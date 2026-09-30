/** Reasoning effort vocabulary shared across harnesses. Ordered from least to most. */
export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_ORDER: readonly Effort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Wire formats the relay speaks; an egress may declare the subset its upstream accepts. */
export type WireDialect = "anthropic" | "openai-chat" | "openai-responses";
export const WIRE_DIALECTS: readonly WireDialect[] = ["anthropic", "openai-chat", "openai-responses"];

/** Plan usage-window utilization observed on a subscription egress, each a fraction 0..1. */
export interface PlanUtilization {
  readonly fiveHour?: number;
  readonly sevenDay?: number;
}

export type Harness = "pi" | "claude-code" | "codex" | "opencode" | "cursor" | "hermes" | "unknown";

/** Request class as reported by Claude Code gateway hint headers; other harnesses map into it. */
export type RequestClass = "main" | "subagent" | "workflow" | "compaction" | "auxiliary";

/** How long a decision is reused before the router re-evaluates. */
export type Lease = "one_call" | "tool_chain" | "user_turn";

export type ToolClass = "observe" | "mutate" | "plan" | "new" | "shell" | "other";

export interface ToolOutcome {
  readonly name: string;
  readonly isError: boolean;
  /** Short error text, already bounded by the adapter. */
  readonly errorText?: string;
  /** Short tail of the tool output, already bounded by the adapter. */
  readonly excerpt?: string;
  readonly durationMs?: number;
}

/** Provider-neutral view of one model request, produced by an adapter or the relay. */
export interface NormalizedRequest {
  readonly harness: Harness;
  readonly sessionKey: string;
  readonly requestedModel: string;
  readonly requestClass?: RequestClass;
  /** True when the latest message is a user prompt rather than tool results. */
  readonly isNewUserTurn: boolean;
  readonly lastUserText?: string;
  readonly assistantIntentTail?: string;
  /** Tool names declared on the request. */
  readonly toolNames: readonly string[];
  readonly hasImages: boolean;
  readonly estimatedInputTokens: number;
  readonly requestedEffort?: Effort;
  /** True on the first request after a context compaction. */
  readonly contextCompacted?: boolean;
  /** Outcomes of the tool calls whose results this request carries. */
  readonly toolOutcomes: readonly ToolOutcome[];
  /** Wire format the request arrived in; candidates whose egress cannot speak it are filtered out. Absent: any. */
  readonly dialect?: WireDialect;
  /** Plan window utilization last observed on the egress this request would bill, when known. */
  readonly planWindow?: PlanUtilization;
}

export interface CurrentAssignment {
  readonly candidate: string;
  readonly effort?: Effort;
  readonly lease: Lease;
  readonly sinceTurn: number;
}

/** Token usage of the last completed response in a session, as the upstream reported it. */
export interface LastUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface SessionState {
  /** Number of turns already processed; the incoming request is turn `turn`. */
  readonly turn: number;
  /** Per-turn tool outcome batches, oldest first, bounded by the session helper. */
  readonly ledger: readonly (readonly ToolOutcome[])[];
  readonly current?: CurrentAssignment;
  /** While `turn < holdUntilTurn`, de-escalation is blocked. */
  readonly holdUntilTurn?: number;
  readonly consecutiveFailures: number;
  readonly lastCompactionTurn?: number;
  /** Usage of the previous completed response, supplied by the daemon after the call; absent when unknown. */
  readonly lastUsage?: LastUsage;
}

export type DecisionSource = "override" | "hold" | "lease" | "signals" | "rules" | "judge" | "fallback";

export interface Decision {
  readonly candidate: string;
  readonly model: string;
  readonly via?: string;
  readonly effort?: Effort;
  readonly source: DecisionSource;
  readonly confidence?: number;
  /** Stable vocabulary, safe to aggregate in stats. */
  readonly reasons: readonly string[];
  readonly counterfactuals: Readonly<Record<string, { readonly estCostUsd: number }>>;
  readonly lease: Lease;
  /** Cache-aware switch estimate, present when the decision weighed a model switch against a known cached prefix. */
  readonly cache?: SwitchCostEstimate;
  /** The highest tier an `at_most` cap allows this turn, present when a cap holds. A cascade never climbs above it. */
  readonly ceiling?: string;
}

export interface SwitchCostEstimate {
  /** Extra cost of the next call because the cached prefix is re-sent at full price on the new model. */
  readonly penaltyUsd: number;
  /** Per-turn saving of the switch times the horizon; negative when the switch costs more per turn. */
  readonly savingUsd: number;
}
