import { type Concluded, plan } from "../core/decide";
import type { Policy } from "../core/policy/types";
import { type ApplyOutcome, buildDecisionRecord, type DecisionRecord, type JudgeTrace, type TokenUsage } from "../core/record";
import { emptySession } from "../core/session";
import { type StageScore, scoreStage } from "../core/signals/stage";
import type { Decision, Harness, NormalizedRequest, PlanUtilization, RequestClass, ToolOutcome, WireDialect } from "../core/types";
import type { Judge } from "../judge/types";
import type { NormalizedBody } from "./dialects/types";
import type { PlanWindowStore } from "./plan-window";
import type { SessionStore } from "./session-store";

export interface DecideInput {
  readonly harness: Harness;
  readonly sessionKey: string;
  readonly policyId: string;
  readonly body: NormalizedBody;
  readonly requestClass?: RequestClass;
  readonly contextCompacted?: boolean;
  readonly estimatedInputTokens: number;
  /** Wire format of the request, so candidates whose egress cannot speak it are skipped. */
  readonly dialect?: WireDialect;
}

export interface Decided {
  readonly request: NormalizedRequest;
  readonly decision: Decision;
  readonly judge?: JudgeTrace;
  readonly stage: StageScore;
  /** Persist the session when the decision took effect, and log the record either way. */
  commit(apply: ApplyOutcome, usage?: TokenUsage, shadow?: { readonly served: string }): DecisionRecord;
}

export interface RouterServiceDeps {
  readonly policy: Policy;
  readonly judge: Judge | undefined;
  readonly store: SessionStore;
  readonly log: (record: DecisionRecord) => void;
  readonly now: () => number;
  readonly randomId: () => string;
  /** Plan windows observed on subscription egresses; absent means rules never see `plan_5h` / `plan_7d`. */
  readonly planWindows?: PlanWindowStore;
}

/**
 * The subscription egress a session on this policy bills: its current candidate's, else the policy default's.
 * Undefined when that egress is not plan-billed. Pure.
 */
export function planEgressFor(policy: Policy, policyId: string, current: string | undefined): string | undefined {
  const def = policy.policies[policyId];
  if (!def) return undefined;
  const id = current && def.order.includes(current) ? current : def.default;
  const name = policy.candidates[id]?.via ?? Object.keys(policy.egress)[0];
  return name && policy.egress[name]?.billing === "subscription" ? name : undefined;
}

/** Shared decision path for the relay and the /decide endpoint. Holds no per-request state itself. */
export class RouterService {
  constructor(private readonly deps: RouterServiceDeps) {}

  /** The candidate a session is currently assigned to, if any. Read-only. */
  currentCandidate(sessionKey: string): string | undefined {
    return this.deps.store.get(sessionKey)?.current?.candidate;
  }

  async decide(input: DecideInput): Promise<Decided> {
    const { policy, judge, store } = this.deps;
    const session = store.get(input.sessionKey) ?? emptySession();
    const pending = store.peekPending(input.sessionKey);
    const toolOutcomes: readonly ToolOutcome[] = pending.outcomes.length > 0 ? pending.outcomes : input.body.toolOutcomes;
    const b = input.body;
    const planEgress = planEgressFor(policy, input.policyId, session.current?.candidate);
    const planWindow: PlanUtilization | undefined = planEgress
      ? this.deps.planWindows?.utilization(planEgress, this.deps.now())
      : undefined;
    const request: NormalizedRequest = {
      harness: input.harness,
      sessionKey: input.sessionKey,
      requestedModel: b.requestedModel,
      ...(input.requestClass ? { requestClass: input.requestClass } : {}),
      isNewUserTurn: b.isNewUserTurn,
      ...(b.lastUserText !== undefined ? { lastUserText: b.lastUserText } : {}),
      ...(b.assistantIntentTail !== undefined ? { assistantIntentTail: b.assistantIntentTail } : {}),
      toolNames: b.toolNames,
      hasImages: b.hasImages,
      estimatedInputTokens: input.estimatedInputTokens,
      ...(b.requestedEffort ? { requestedEffort: b.requestedEffort } : {}),
      ...(input.contextCompacted || pending.compaction ? { contextCompacted: true } : {}),
      toolOutcomes,
      ...(input.dialect ? { dialect: input.dialect } : {}),
      ...(planWindow ? { planWindow } : {}),
    };

    const outcome = plan({ request, session, policy, policyId: input.policyId });
    let concluded: Concluded;
    let judgeTrace: JudgeTrace | undefined;
    if (outcome.kind === "decision") {
      concluded = outcome;
    } else {
      const questions = Object.keys(outcome.judgeRequest.questions);
      if (!judge) {
        judgeTrace = { questions, error: "no_judge_configured" };
        concluded = outcome.conclude(null);
      } else {
        try {
          const res = await judge.evaluate(outcome.judgeRequest);
          judgeTrace = {
            questions,
            model: res.model,
            latencyMs: res.latencyMs,
            answers: res.answers,
            ...(res.usage.costUsd !== undefined ? { costUsd: res.usage.costUsd } : {}),
          };
          concluded = outcome.conclude(res.answers);
        } catch (e) {
          judgeTrace = { questions, error: e instanceof Error ? e.message : String(e) };
          concluded = outcome.conclude(null);
        }
      }
    }
    const def = policy.policies[input.policyId];
    const stage = scoreStage([...concluded.session.ledger], request.harness, {
      recentTurnWindow: def?.recent_turn_window ?? 3,
      ...(def ? { toolSemantics: def.tool_semantics } : {}),
    });
    const trace = judgeTrace;
    return {
      request,
      decision: concluded.decision,
      ...(trace ? { judge: trace } : {}),
      stage,
      commit: (apply, usage, shadow) => {
        if (apply.ok) {
          store.set(input.sessionKey, concluded.session);
          store.clearPending(input.sessionKey, pending);
        }
        const record = buildDecisionRecord({
          id: this.deps.randomId(),
          ts: this.deps.now(),
          request,
          session: concluded.session,
          decision: concluded.decision,
          stage,
          apply,
          ...(trace ? { judge: trace } : {}),
          ...(usage ? { usage } : {}),
          ...(shadow ? { shadow } : {}),
        });
        this.deps.log(record);
        return record;
      },
    };
  }
}
