import type { Answer, JudgeRequest } from "../judge/types";
import { estimateSwitch } from "./cache";
import { counterfactualCosts } from "./cost";
import { buildDossier, type DossierOptions } from "./dossier";
import { effortStepUp, higherEffort, resolveEffort } from "./effort";
import { getPolicyDef } from "./policy";
import type { ExprContext, ExprValue } from "./policy/expr";
import type { Candidate, EgressInput, Policy, PolicyDef, RuleAction } from "./policy/types";
import { executionPhaseQuestions, taskPhaseQuestions } from "./questions";
import { advanceSession } from "./session";
import { type StageScore, scoreStage } from "./signals/stage";
import type {
  CurrentAssignment,
  Decision,
  DecisionSource,
  Effort,
  Lease,
  NormalizedRequest,
  SessionState,
  SwitchCostEstimate,
  WireDialect,
} from "./types";

/** A lease never outlives this many turns even without an error or a new user turn. */
const LEASE_MAX_TURNS = 6;
/** Consecutive all-failure tool batches that force an escalation. */
const FAILURE_OVERRIDE_THRESHOLD = 3;

export interface PlanInput {
  readonly request: NormalizedRequest;
  readonly session: SessionState;
  readonly policy: Policy;
  readonly policyId: string;
  readonly dossier?: DossierOptions;
}

export interface Concluded {
  readonly decision: Decision;
  readonly session: SessionState;
}

export type PlanOutcome =
  | { readonly kind: "decision"; readonly decision: Decision; readonly session: SessionState }
  | { readonly kind: "judge"; readonly judgeRequest: JudgeRequest; conclude(answers: Readonly<Record<string, Answer>> | null): Concluded };

interface Tiers {
  readonly ids: readonly string[];
  idx(id: string): number;
  up(id: string, n?: number): string;
  down(id: string, n?: number): string;
  higher(a: string, b: string): string;
  /** Nearest eligible tier at or above `id` in the full order, else the highest eligible. */
  clamp(id: string): string;
  /** Nearest eligible tier at or below `id` in the full order, else the lowest eligible. Used for caps. */
  floor(id: string): string;
}

function makeTiers(fullOrder: readonly string[], eligible: readonly string[]): Tiers {
  const idx = (id: string) => eligible.indexOf(id);
  const at = (i: number) => eligible[Math.min(Math.max(i, 0), eligible.length - 1)] as string;
  return {
    ids: eligible,
    idx,
    up: (id, n = 1) => at(idx(id) + n),
    down: (id, n = 1) => at(idx(id) - n),
    higher: (a, b) => (idx(a) >= idx(b) ? a : b),
    clamp: (id) => {
      if (eligible.includes(id)) return id;
      const full = fullOrder.indexOf(id);
      return eligible.find((e) => fullOrder.indexOf(e) >= full) ?? (eligible[eligible.length - 1] as string);
    },
    floor: (id) => {
      if (eligible.includes(id)) return id;
      const full = fullOrder.indexOf(id);
      return [...eligible].reverse().find((e) => fullOrder.indexOf(e) <= full) ?? (eligible[0] as string);
    },
  };
}

/** The egress a candidate is served through: its `via`, else the first egress, as the relay resolves it. */
function egressOf(policy: Policy, candidate: Candidate): EgressInput | undefined {
  if (candidate.via && policy.egress[candidate.via]) return policy.egress[candidate.via];
  const first = Object.keys(policy.egress)[0];
  return first ? policy.egress[first] : undefined;
}

/** Whether the candidate's egress accepts the request's wire format. Unknown formats and undeclared egresses pass. */
export function speaks(policy: Policy, candidate: Candidate, request: NormalizedRequest): boolean {
  const dialects = request.dialect ? egressOf(policy, candidate)?.dialects : undefined;
  return !dialects || dialects.includes(request.dialect as WireDialect);
}

export function isCapable(candidate: Candidate, request: NormalizedRequest): boolean {
  const caps = candidate.capabilities;
  if (!caps) return true;
  if (request.hasImages && caps.vision === false) return false;
  if (request.toolNames.length > 0 && caps.tools === false) return false;
  if (caps.context !== undefined && request.estimatedInputTokens > caps.context) return false;
  return true;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function baseContext(request: NormalizedRequest, stage: StageScore, failuresNow: number): ExprContext {
  const dims = stage.abstained ? undefined : stage.dimensions;
  const ctx: Record<string, ExprValue> = {
    harness: request.harness,
    has_images: request.hasImages,
    is_new_user_turn: request.isNewUserTurn,
    est_tokens: request.estimatedInputTokens,
    consecutive_failures: failuresNow,
    "signal.score": stage.abstained ? undefined : stage.raw,
    "signal.severity": dims?.severity,
    "signal.spinning": dims?.spinning,
    "signal.exploring": dims?.exploring,
    "signal.production": dims?.production_intensity,
  };
  if (request.requestClass) ctx.request_class = request.requestClass;
  if (request.requestedEffort) ctx.requested_effort = request.requestedEffort;
  // Plan windows stay absent until observed, so rules reading them are unknown and never fire.
  if (finite(request.planWindow?.fiveHour)) ctx.plan_5h = request.planWindow.fiveHour;
  if (finite(request.planWindow?.sevenDay)) ctx.plan_7d = request.planWindow.sevenDay;
  return ctx;
}

/** Only well-formed values reach rules; anything else stays unknown so rules fail closed. */
function flattenAnswers(answers: Readonly<Record<string, Answer>>): ExprContext {
  const ctx: Record<string, ExprValue> = {};
  for (const [id, a] of Object.entries(answers)) {
    if (a.type === "noul") {
      if (finite(a.noul)) ctx[id] = a.noul;
    } else if (a.type === "score") {
      if (finite(a.score)) ctx[id] = a.score;
      ctx[`${id}.confidence`] = finite(a.confidence) ? a.confidence : 0;
    } else {
      if (typeof a.choice === "string") ctx[id] = a.choice;
      ctx[`${id}.confidence`] = finite(a.confidence) ? a.confidence : 0;
    }
  }
  return ctx;
}

/**
 * Minimum confidence across the choice and score answers that the policy's rules actually reference.
 * Questions no rule reads cannot gate the decision. A missing or non-finite confidence counts as zero.
 */
function minConfidence(answers: Readonly<Record<string, Answer>>, def: PolicyDef): number {
  const referenced = new Set<string>();
  for (const rule of def.rules) for (const id of rule.expr.identifiers) referenced.add(id.replace(/\.confidence$/, ""));
  let min = 1;
  for (const [id, a] of Object.entries(answers)) {
    if (a.type === "noul" || !referenced.has(id)) continue;
    min = Math.min(min, finite(a.confidence) ? a.confidence : 0);
  }
  return min;
}

interface FinishOptions {
  readonly reasons: readonly string[];
  readonly lease: Lease;
  readonly effortWanted?: Effort;
  readonly hold?: number;
  readonly confidence?: number;
  readonly keepCurrent?: boolean;
  /** Context the `at_most` caps are evaluated against; the deterministic context unless the judge answered. */
  readonly capContext?: ExprContext;
  /** Estimate that blocked a switch; otherwise finish computes one for any model switch. */
  readonly cache?: SwitchCostEstimate;
}

interface Cap {
  readonly cap: string;
  readonly reasons: readonly string[];
}

/** The lowest `at_most` cap among the rules that hold in `ctx`. Unknown identifiers never hold, so no cap. */
function capFor(def: PolicyDef, tiers: Tiers, ctx: ExprContext): Cap | undefined {
  let cap: string | undefined;
  const reasons: string[] = [];
  for (const [i, rule] of def.rules.entries()) {
    if (!rule.then.at_most || !rule.expr.evaluate(ctx)) continue;
    const c = tiers.floor(rule.then.at_most);
    reasons.push(`rule:${i}`);
    if (cap === undefined || tiers.idx(c) < tiers.idx(cap)) cap = c;
  }
  return cap === undefined ? undefined : { cap, reasons };
}

/** Pure cap rules only bound the outcome; they are reported by the cap, not by the rule loop. */
const isPureCap = (a: RuleAction): boolean => a.at_most !== undefined && Object.keys(a).length === 1;

/**
 * Plan the routing of one request. Returns a decision immediately when deterministic evidence suffices,
 * otherwise a judge request plus a `conclude` continuation. Pure: no I/O, no clock, no randomness.
 */
export function plan(input: PlanInput): PlanOutcome {
  const { request, session, policy, policyId } = input;
  const def: PolicyDef = getPolicyDef(policy, policyId);
  const baseReasons: string[] = [];

  const speaking = def.order.filter((id) => speaks(policy, policy.candidates[id] as Candidate, request));
  if (speaking.length < def.order.length) baseReasons.push("dialect_filter");
  const eligible = speaking.filter((id) => isCapable(policy.candidates[id] as Candidate, request));
  if (eligible.length < speaking.length) baseReasons.push("capability_filter");
  if (eligible.length === 0) baseReasons.push("no_eligible_candidate");
  const lastResort = speaking[speaking.length - 1] ?? (def.order[def.order.length - 1] as string);
  const tiers = makeTiers(def.order, eligible.length > 0 ? eligible : [lastResort]);

  const current: CurrentAssignment | undefined =
    session.current && tiers.ids.includes(session.current.candidate) ? session.current : undefined;
  const baseline = current?.candidate ?? tiers.clamp(def.default);

  const stage = scoreStage([...session.ledger, request.toolOutcomes], request.harness, {
    recentTurnWindow: def.recent_turn_window,
    toolSemantics: def.tool_semantics,
  });
  const batch = request.toolOutcomes;
  const failuresNow =
    batch.length === 0 ? session.consecutiveFailures : batch.every((o) => o.isError) ? session.consecutiveFailures + 1 : 0;
  const holdActive = session.holdUntilTurn !== undefined && session.turn < session.holdUntilTurn;
  const ctx = baseContext(request, stage, failuresNow);

  /** Cache-aware estimate for moving off the current model, when the switch is on and the last cache reads are known. */
  const switchEstimate = (targetId: string): SwitchCostEstimate | undefined =>
    current && def.switch.cache_penalty && targetId !== current.candidate
      ? estimateSwitch({
          lastUsage: session.lastUsage,
          from: policy.candidates[current.candidate] as Candidate,
          to: policy.candidates[targetId] as Candidate,
          estimatedInputTokens: request.estimatedInputTokens,
          estOutputTokens: def.est_output_tokens,
          horizonTurns: def.recent_turn_window,
        })
      : undefined;

  /**
   * Effort first, model second: when an escalation would move above the baseline, the next effort level on the
   * baseline instead, or undefined when the switch is off, the move is not upward, or effort is already at the top.
   */
  const effortFirst = (targetId: string): Effort | undefined => {
    if (!def.switch.prefer_effort_over_model || tiers.idx(targetId) <= tiers.idx(baseline)) return undefined;
    const inUse = current?.effort ?? request.requestedEffort;
    return effortStepUp(policy.candidates[baseline] as Candidate, inUse);
  };

  /** The estimate when moving down to `targetId` would cost more in lost cache than it saves over the horizon. */
  const cacheBlock = (targetId: string): SwitchCostEstimate | undefined => {
    if (!current || tiers.idx(targetId) >= tiers.idx(current.candidate)) return undefined;
    const estimate = switchEstimate(targetId);
    return estimate && estimate.savingUsd < estimate.penaltyUsd ? estimate : undefined;
  };

  const finish = (wantedId: string, source: DecisionSource, o: FinishOptions): Concluded => {
    // Caps come last and bound every path, overrides and holds included: never above the cap this turn.
    const capped = capFor(def, tiers, o.capContext ?? ctx);
    const lowered = capped !== undefined && tiers.idx(wantedId) > tiers.idx(capped.cap);
    const candidateId = lowered ? capped.cap : wantedId;
    const capReasons = lowered ? [...capped.reasons.filter((r) => !o.reasons.includes(r)), "capped"] : [];
    const candidate = policy.candidates[candidateId] as Candidate;
    const { effort, clamped } = resolveEffort(candidate, o.effortWanted);
    const cache = o.cache ?? switchEstimate(candidateId);
    const decision: Decision = {
      candidate: candidateId,
      model: candidate.model,
      ...(candidate.via ? { via: candidate.via } : {}),
      ...(effort ? { effort } : {}),
      source,
      ...(o.confidence !== undefined ? { confidence: o.confidence } : {}),
      reasons: [...baseReasons, ...o.reasons, ...capReasons, ...(clamped ? ["effort_clamped"] : [])],
      counterfactuals: counterfactualCosts(policy.candidates, def.order, request.estimatedInputTokens, def.est_output_tokens),
      lease: o.lease,
      ...(cache ? { cache } : {}),
      ...(capped ? { ceiling: capped.cap } : {}),
    };
    const assignment: CurrentAssignment =
      o.keepCurrent && current && !lowered
        ? current
        : { candidate: candidateId, ...(effort ? { effort } : {}), lease: o.lease, sinceTurn: session.turn };
    return {
      decision,
      session: advanceSession(session, request, { current: assignment, ...(o.hold !== undefined ? { holdUntilTurn: o.hold } : {}) }),
    };
  };
  const decide = (candidateId: string, source: DecisionSource, o: FinishOptions): PlanOutcome => ({
    kind: "decision",
    ...finish(candidateId, source, o),
  });

  // 1. Hard overrides always escalate one tier and start a hold.
  const overrideReason = request.contextCompacted
    ? "context_compacted"
    : failuresNow >= FAILURE_OVERRIDE_THRESHOLD
      ? "repeated_failures"
      : stage.critical
        ? "critical_error"
        : undefined;
  if (overrideReason) {
    return decide(tiers.up(baseline), "override", {
      reasons: [overrideReason],
      hold: session.turn + 1 + def.hold_turns,
      lease: "one_call",
      ...(request.requestedEffort ? { effortWanted: request.requestedEffort } : {}),
    });
  }

  // 2. An active hold keeps tool continuations where they are.
  if (holdActive && !request.isNewUserTurn && current) {
    return decide(current.candidate, "hold", {
      reasons: ["hold_active"],
      lease: current.lease,
      keepCurrent: true,
      ...(current.effort ? { effortWanted: current.effort } : {}),
    });
  }

  // 3. A clean tool continuation inside a lease reuses the decision.
  const batchHasError = batch.some((o) => o.isError);
  if (
    !request.isNewUserTurn &&
    current &&
    current.lease !== "one_call" &&
    !batchHasError &&
    session.turn - current.sinceTurn < LEASE_MAX_TURNS
  ) {
    return decide(current.candidate, "lease", {
      reasons: ["lease_active"],
      lease: current.lease,
      keepCurrent: true,
      ...(current.effort ? { effortWanted: current.effort } : {}),
    });
  }

  // 4. Rules that can be decided without the judge and pin a candidate.
  for (const [i, rule] of def.rules.entries()) {
    if (!rule.then.pin) continue;
    if (![...rule.expr.identifiers].every((id) => ctx[id] !== undefined)) continue;
    if (rule.expr.evaluate(ctx)) {
      const wanted = rule.then.effort ?? request.requestedEffort;
      return decide(tiers.clamp(rule.then.pin), "rules", {
        reasons: [`rule:${i}`],
        lease: "tool_chain",
        ...(wanted ? { effortWanted: wanted } : {}),
      });
    }
  }

  // 5. Decisive tool signals on continuations skip the judge.
  if (!request.isNewUserTurn && !stage.abstained && stage.direction !== "none" && stage.confidence >= def.confidence_threshold) {
    const wanted = current?.effort ?? request.requestedEffort;
    const effortOpt = wanted ? { effortWanted: wanted } : {};
    if (stage.direction === "capable") {
      const up = tiers.up(baseline);
      const stepped = effortFirst(up);
      if (stepped)
        return decide(baseline, "signals", { reasons: ["signals_capable", "effort_first"], lease: "one_call", effortWanted: stepped });
      return decide(up, "signals", { reasons: ["signals_capable"], lease: "one_call", ...effortOpt });
    }
    if (!holdActive) return decide(tiers.down(baseline), "signals", { reasons: ["signals_efficient"], lease: "tool_chain", ...effortOpt });
  }

  // 6. Ask the judge: task questions on a user turn, execution questions on an ambiguous continuation.
  const useExecution = !request.isNewUserTurn && !stage.abstained;
  const judgeRequest: JudgeRequest = {
    state: buildDossier(request, input.dossier ?? {}),
    questions: useExecution ? executionPhaseQuestions() : taskPhaseQuestions(),
    sessionId: request.sessionKey,
  };

  const conclude = (answers: Readonly<Record<string, Answer>> | null): Concluded => {
    const fallbackEffort = current?.effort ?? request.requestedEffort;
    const fallbackOpt = fallbackEffort ? { effortWanted: fallbackEffort } : {};
    if (!answers || Object.keys(answers).length === 0) {
      const why = answers ? "judge_empty" : "judge_unavailable";
      if (policy.judge.on_error === "fail_closed") {
        return finish(tiers.ids[tiers.ids.length - 1] as string, "fallback", {
          reasons: [why, "fail_closed"],
          lease: "one_call",
          ...fallbackOpt,
        });
      }
      return finish(baseline, "fallback", { reasons: [why], lease: "tool_chain", ...fallbackOpt });
    }

    const full: ExprContext = { ...ctx, ...flattenAnswers(answers) };
    const confidence = minConfidence(answers, def);
    if (confidence < def.min_confidence) {
      return finish(baseline, "judge", { reasons: ["low_confidence"], lease: "tool_chain", confidence, capContext: full, ...fallbackOpt });
    }

    let target = tiers.clamp(def.default);
    let upSteps = 0;
    let allowDown = false;
    let effortWanted: Effort | undefined;
    let holdTurns: number | undefined;
    let pinned = false;
    const reasons: string[] = [];
    for (const [i, rule] of def.rules.entries()) {
      const a = rule.then;
      if (isPureCap(a) || !rule.expr.evaluate(full)) continue;
      reasons.push(`rule:${i}`);
      if (a.effort) effortWanted = a.effort;
      if (a.hold_turns !== undefined) holdTurns = a.hold_turns;
      if (a.pin) {
        target = tiers.clamp(a.pin);
        pinned = true;
        break;
      }
      if (a.at_least) target = tiers.higher(target, tiers.clamp(a.at_least));
      if (a.up) upSteps += a.up;
      if (a.allow_down) allowDown = true;
    }
    // Only an `up` action may be absorbed by effort-first; a pin, an at_least, or the default above the baseline switches.
    const forced = target;
    if (upSteps > 0) target = tiers.higher(target, tiers.up(baseline, upSteps));
    if (tiers.idx(target) < tiers.idx(baseline) && !request.isNewUserTurn && !allowDown) {
      target = baseline;
      reasons.push("downgrade_blocked");
    }
    if (holdActive && current) target = tiers.higher(target, current.candidate);

    const stepped = !pinned && tiers.idx(forced) <= tiers.idx(baseline) ? effortFirst(target) : undefined;
    if (stepped) {
      target = baseline;
      effortWanted = higherEffort(stepped, effortWanted);
      reasons.push("effort_first");
    }

    const blocked = cacheBlock(target);
    if (blocked && current) {
      target = current.candidate;
      effortWanted = current.effort ?? effortWanted;
      reasons.push("cache_penalty_blocked");
    }

    const finalEffort = effortWanted ?? request.requestedEffort;
    return finish(target, "judge", {
      reasons,
      capContext: full,
      lease: "tool_chain",
      confidence,
      ...(finalEffort ? { effortWanted: finalEffort } : {}),
      ...(holdTurns !== undefined ? { hold: session.turn + 1 + holdTurns } : {}),
      ...(blocked ? { cache: blocked } : {}),
    });
  };

  return { kind: "judge", judgeRequest, conclude };
}
