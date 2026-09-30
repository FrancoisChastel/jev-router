import type { Answer } from "../judge/types";
import type { StageScore } from "./signals/stage";
import type { Decision, Effort, Harness, NormalizedRequest, PlanUtilization, RequestClass, SessionState } from "./types";

export interface JudgeTrace {
  readonly questions: readonly string[];
  readonly transport?: string;
  readonly model?: string;
  readonly latencyMs?: number;
  readonly costUsd?: number;
  readonly answers?: Readonly<Record<string, Answer>>;
  readonly error?: string;
}

/** One line of the decision log. Content-free by construction: digests and vocabularies only. */
export interface DecisionRecord {
  readonly id: string;
  readonly ts: number;
  readonly session: string;
  readonly harness: Harness;
  readonly turn: number;
  readonly requestClass?: RequestClass;
  readonly isNewUserTurn: boolean;
  readonly estimatedInputTokens: number;
  readonly contextCompacted?: boolean;
  readonly hasImages?: boolean;
  readonly requestedEffort?: string;
  /** Tool names declared on the request, bounded. Names, never arguments. */
  readonly toolNames?: readonly string[];
  /** Outcomes carried by the request as name and error flag only, so a replay can rebuild the signals. */
  readonly toolOutcomes?: readonly { readonly name: string; readonly isError: boolean }[];
  readonly signals?: StageScore["dimensions"] & { readonly score: number };
  readonly judge?: JudgeTrace;
  readonly decision: Decision;
  /** Whether the adapter managed to apply the decision. Absent when the adapter has nothing to apply. */
  readonly apply?: ApplyOutcome;
  readonly usage?: TokenUsage;
  /** Present in shadow mode: the candidate that actually served the request while the decision was only logged. */
  readonly shadow?: { readonly served: string };
  /** Present when a cascade retried the request or gave up on retrying it. `usage` above is then the sum over attempts. */
  readonly cascade?: CascadeRecord;
  /** Plan window utilization the decision saw on a subscription egress, when one had been observed. */
  readonly plan?: PlanUtilization;
}

/** One upstream call made for a cascaded request. `outcome` is `served`, a cascade trigger, or `unreachable`. */
export interface CascadeAttempt {
  readonly candidate: string;
  readonly model: string;
  readonly effort?: Effort;
  readonly outcome: string;
  readonly detail?: string;
  readonly usage?: TokenUsage;
  /** List-price cost of this attempt's usage. */
  readonly costUsd?: number;
}

export interface CascadeRecord {
  readonly attempts: readonly CascadeAttempt[];
  /** The candidate whose response the client received. */
  readonly served: string;
  /** Why the cascade stopped short of a retry it would otherwise have made: `buffer_max_bytes`, `buffer_max_ms`, `budget_usd`. */
  readonly abandoned?: string;
}

export interface ApplyOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

/** Provider-neutral token usage as observed on the response. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
}

export interface RecordInput {
  readonly id: string;
  readonly ts: number;
  readonly request: NormalizedRequest;
  /** Session state after the decision was applied. */
  readonly session: SessionState;
  readonly decision: Decision;
  readonly stage?: StageScore;
  readonly judge?: JudgeTrace;
  readonly apply?: ApplyOutcome;
  readonly usage?: TokenUsage;
  readonly shadow?: { readonly served: string };
  readonly cascade?: CascadeRecord;
}

export function buildDecisionRecord(input: RecordInput): DecisionRecord {
  const { request, stage } = input;
  return {
    id: input.id,
    ts: input.ts,
    session: request.sessionKey,
    harness: request.harness,
    turn: input.session.turn - 1,
    ...(request.requestClass ? { requestClass: request.requestClass } : {}),
    isNewUserTurn: request.isNewUserTurn,
    estimatedInputTokens: request.estimatedInputTokens,
    ...(request.contextCompacted ? { contextCompacted: true } : {}),
    ...(request.hasImages ? { hasImages: true } : {}),
    ...(request.requestedEffort ? { requestedEffort: request.requestedEffort } : {}),
    ...(request.toolNames.length > 0 ? { toolNames: request.toolNames.slice(0, 64) } : {}),
    ...(request.toolOutcomes.length > 0
      ? { toolOutcomes: request.toolOutcomes.slice(0, 64).map((o) => ({ name: o.name, isError: o.isError })) }
      : {}),
    ...(stage && !stage.abstained ? { signals: { ...stage.dimensions, score: stage.raw } } : {}),
    ...(input.judge ? { judge: input.judge } : {}),
    decision: input.decision,
    ...(input.apply ? { apply: input.apply } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.shadow ? { shadow: input.shadow } : {}),
    ...(input.cascade ? { cascade: input.cascade } : {}),
    ...(request.planWindow ? { plan: request.planWindow } : {}),
  };
}
