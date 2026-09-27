import { type Concluded, plan } from "../core/decide";
import type { Policy } from "../core/policy/types";
import { type ApplyOutcome, buildDecisionRecord, type DecisionRecord, type JudgeTrace, type TokenUsage } from "../core/record";
import { emptySession } from "../core/session";
import { type StageScore, scoreStage } from "../core/signals/stage";
import type { Decision, Harness, NormalizedRequest, RequestClass, ToolOutcome } from "../core/types";
import type { Judge } from "../judge/types";
import type { NormalizedBody } from "./dialects/types";
import type { SessionStore } from "./session-store";

export interface DecideInput {
  readonly harness: Harness;
  readonly sessionKey: string;
  readonly policyId: string;
  readonly body: NormalizedBody;
  readonly requestClass?: RequestClass;
  readonly contextCompacted?: boolean;
  readonly estimatedInputTokens: number;
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
}

/** Shared decision path for the relay and the /decide endpoint. Holds no per-request state itself. */
export class RouterService {
  constructor(private readonly deps: RouterServiceDeps) {}

  async decide(input: DecideInput): Promise<Decided> {
    const { policy, judge, store } = this.deps;
    const session = store.get(input.sessionKey) ?? emptySession();
    const pending = store.takePending(input.sessionKey);
    const toolOutcomes: readonly ToolOutcome[] = pending.outcomes.length > 0 ? pending.outcomes : input.body.toolOutcomes;
    const b = input.body;
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
        if (apply.ok) store.set(input.sessionKey, concluded.session);
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
