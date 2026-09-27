import type { Answer } from "../judge/types";
import type { StageScore } from "./signals/stage";
import type { Decision, Harness, NormalizedRequest, RequestClass, SessionState } from "./types";

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
  readonly signals?: StageScore["dimensions"] & { readonly score: number };
  readonly judge?: JudgeTrace;
  readonly decision: Decision;
  /** Whether the adapter managed to apply the decision. Absent when the adapter has nothing to apply. */
  readonly apply?: ApplyOutcome;
  readonly usage?: TokenUsage;
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
    ...(stage && !stage.abstained ? { signals: { ...stage.dimensions, score: stage.raw } } : {}),
    ...(input.judge ? { judge: input.judge } : {}),
    decision: input.decision,
    ...(input.apply ? { apply: input.apply } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
  };
}
