import type { Answer, JudgeRequest } from "../judge/types";
import { counterfactualCosts } from "./cost";
import { buildDossier, type DossierOptions } from "./dossier";
import { getPolicyDef } from "./policy";
import type { ExprContext, ExprValue } from "./policy/expr";
import type { Candidate, Policy, PolicyDef } from "./policy/types";
import { executionPhaseQuestions, taskPhaseQuestions } from "./questions";
import { advanceSession } from "./session";
import { type StageScore, scoreStage } from "./signals/stage";
import {
  type CurrentAssignment,
  type Decision,
  type DecisionSource,
  EFFORT_ORDER,
  type Effort,
  type Lease,
  type NormalizedRequest,
  type SessionState,
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
  };
}

export function isCapable(candidate: Candidate, request: NormalizedRequest): boolean {
  const caps = candidate.capabilities;
  if (!caps) return true;
  if (request.hasImages && caps.vision === false) return false;
  if (request.toolNames.length > 0 && caps.tools === false) return false;
  if (caps.context !== undefined && request.estimatedInputTokens > caps.context) return false;
  return true;
}

function sortedEfforts(candidate: Candidate): readonly Effort[] {
  return [...(candidate.effort ?? [])].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
}

/** Clamp a wanted effort to the candidate's list, rounding down; the candidate's default when nothing is wanted. */
export function resolveEffort(candidate: Candidate, wanted: Effort | undefined): { effort?: Effort; clamped: boolean } {
  const supported = sortedEfforts(candidate);
  if (supported.length === 0) return { clamped: false };
  const want = wanted ?? candidate.default_effort;
  if (!want) return { clamped: false };
  if (supported.includes(want)) return { effort: want, clamped: false };
  const wi = EFFORT_ORDER.indexOf(want);
  const lower = supported.filter((e) => EFFORT_ORDER.indexOf(e) < wi);
  return { effort: lower.length > 0 ? (lower[lower.length - 1] as Effort) : (supported[0] as Effort), clamped: true };
}

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
  return ctx;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

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
}

/**
 * Plan the routing of one request. Returns a decision immediately when deterministic evidence suffices,
 * otherwise a judge request plus a `conclude` continuation. Pure: no I/O, no clock, no randomness.
 */
export function plan(input: PlanInput): PlanOutcome {
  const { request, session, policy, policyId } = input;
  const def: PolicyDef = getPolicyDef(policy, policyId);
  const baseReasons: string[] = [];

  const eligible = def.order.filter((id) => isCapable(policy.candidates[id] as Candidate, request));
  if (eligible.length < def.order.length) baseReasons.push("capability_filter");
  if (eligible.length === 0) baseReasons.push("no_eligible_candidate");
  const tiers = makeTiers(def.order, eligible.length > 0 ? eligible : [def.order[def.order.length - 1] as string]);

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

  const finish = (candidateId: string, source: DecisionSource, o: FinishOptions): Concluded => {
    const candidate = policy.candidates[candidateId] as Candidate;
    const { effort, clamped } = resolveEffort(candidate, o.effortWanted);
    const decision: Decision = {
      candidate: candidateId,
      model: candidate.model,
      ...(candidate.via ? { via: candidate.via } : {}),
      ...(effort ? { effort } : {}),
      source,
      ...(o.confidence !== undefined ? { confidence: o.confidence } : {}),
      reasons: [...baseReasons, ...o.reasons, ...(clamped ? ["effort_clamped"] : [])],
      counterfactuals: counterfactualCosts(policy.candidates, def.order, request.estimatedInputTokens, def.est_output_tokens),
      lease: o.lease,
    };
    const assignment: CurrentAssignment =
      o.keepCurrent && current
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
    if (stage.direction === "capable")
      return decide(tiers.up(baseline), "signals", { reasons: ["signals_capable"], lease: "one_call", ...effortOpt });
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
      return finish(baseline, "judge", { reasons: ["low_confidence"], lease: "tool_chain", confidence, ...fallbackOpt });
    }

    let target = tiers.clamp(def.default);
    let upSteps = 0;
    let allowDown = false;
    let effortWanted: Effort | undefined;
    let holdTurns: number | undefined;
    const reasons: string[] = [];
    for (const [i, rule] of def.rules.entries()) {
      if (!rule.expr.evaluate(full)) continue;
      reasons.push(`rule:${i}`);
      const a = rule.then;
      if (a.effort) effortWanted = a.effort;
      if (a.hold_turns !== undefined) holdTurns = a.hold_turns;
      if (a.pin) {
        target = tiers.clamp(a.pin);
        break;
      }
      if (a.at_least) target = tiers.higher(target, tiers.clamp(a.at_least));
      if (a.up) upSteps += a.up;
      if (a.allow_down) allowDown = true;
    }
    if (upSteps > 0) target = tiers.higher(target, tiers.up(baseline, upSteps));
    if (tiers.idx(target) < tiers.idx(baseline) && !request.isNewUserTurn && !allowDown) {
      target = baseline;
      reasons.push("downgrade_blocked");
    }
    if (holdActive && current) target = tiers.higher(target, current.candidate);

    // Prefer raising effort over switching model when the policy asks for it and the current model has headroom.
    if (def.switch.prefer_effort_over_model && current && tiers.idx(target) === tiers.idx(current.candidate) + 1) {
      const supported = sortedEfforts(policy.candidates[current.candidate] as Candidate);
      const currentIdx = current.effort ? supported.indexOf(current.effort) : -1;
      if (supported.length > 0 && currentIdx < supported.length - 1) {
        const currentRank = EFFORT_ORDER.indexOf(current.effort ?? "minimal");
        const wantedIsHigher =
          effortWanted !== undefined && supported.includes(effortWanted) && EFFORT_ORDER.indexOf(effortWanted) > currentRank;
        effortWanted = wantedIsHigher ? effortWanted : (supported[supported.length - 1] as Effort);
        target = current.candidate;
        reasons.push("effort_over_model");
      }
    }

    const finalEffort = effortWanted ?? request.requestedEffort;
    return finish(target, "judge", {
      reasons,
      lease: "tool_chain",
      confidence,
      ...(finalEffort ? { effortWanted: finalEffort } : {}),
      ...(holdTurns !== undefined ? { hold: session.turn + 1 + holdTurns } : {}),
    });
  };

  return { kind: "judge", judgeRequest, conclude };
}
