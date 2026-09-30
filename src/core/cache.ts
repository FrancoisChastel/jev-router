import { estimateCostUsd } from "./cost";
import type { Candidate } from "./policy/types";
import type { LastUsage, SwitchCostEstimate } from "./types";

const PER_MILLION = 1_000_000;

/** Share of the input price a provider waives on a prompt-cache read. 90% is the usual discount. */
export const CACHE_READ_DISCOUNT = 0.9;

export interface CachePenaltyInput {
  readonly lastUsage: LastUsage;
  readonly from: Candidate;
  readonly to: Candidate;
}

/**
 * Extra cost of the next call on `to` because prompt caches are per model: the prefix that `from` would have read
 * from cache is re-sent at full input price, minus the discounted read that staying would have paid. Never negative.
 */
export function cachePenaltyUsd({ lastUsage, from, to }: CachePenaltyInput): number {
  const cached = lastUsage.cacheReadTokens ?? 0;
  const resent = (cached / PER_MILLION) * to.price.in;
  const stayRead = (cached / PER_MILLION) * from.price.in * (1 - CACHE_READ_DISCOUNT);
  return Math.max(0, resent - stayRead);
}

export interface SwitchSavingInput {
  readonly estimatedInputTokens: number;
  readonly estOutputTokens: number;
  readonly from: Candidate;
  readonly to: Candidate;
  readonly horizonTurns: number;
}

/** Per-turn saving of serving on `to` instead of `from`, times the horizon. Negative when `to` costs more. */
export function switchSavingUsd({ estimatedInputTokens, estOutputTokens, from, to, horizonTurns }: SwitchSavingInput): number {
  const perTurn = estimateCostUsd(from, estimatedInputTokens, estOutputTokens) - estimateCostUsd(to, estimatedInputTokens, estOutputTokens);
  return perTurn * horizonTurns;
}

export interface SwitchEstimateInput extends SwitchSavingInput {
  readonly lastUsage: LastUsage | undefined;
}

/** Both sides of a model switch, or undefined when the previous call's cache reads are unknown. */
export function estimateSwitch(input: SwitchEstimateInput): SwitchCostEstimate | undefined {
  const { lastUsage } = input;
  if (lastUsage?.cacheReadTokens === undefined) return undefined;
  return { penaltyUsd: cachePenaltyUsd({ lastUsage, from: input.from, to: input.to }), savingUsd: switchSavingUsd(input) };
}
