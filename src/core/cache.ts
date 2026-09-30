import type { Candidate } from "./policy/types";
import type { LastUsage, SwitchCostEstimate } from "./types";

const PER_MILLION = 1_000_000;

/** Share of the input price a provider waives on a prompt-cache read. 90% is the usual discount. */
export const CACHE_READ_DISCOUNT = 0.9;
/** Share of the input price still paid on a cache read, the complement of the discount. */
export const CACHED_INPUT_RATE = 1 - CACHE_READ_DISCOUNT;

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
  const stayRead = (cached / PER_MILLION) * from.price.in * CACHED_INPUT_RATE;
  return Math.max(0, resent - stayRead);
}

export interface SwitchSavingInput {
  readonly estimatedInputTokens: number;
  readonly estOutputTokens: number;
  readonly from: Candidate;
  readonly to: Candidate;
  readonly horizonTurns: number;
  /** Cached prefix of the previous call; 0 prices every input token at full rate. */
  readonly cacheReadTokens?: number;
}

/**
 * Per-turn saving of serving on `to` instead of `from`, times the horizon. Negative when `to` costs more.
 * After the first turn the prefix is read at cached rates on either model, so only the price difference on the cached
 * rate applies to it; the new input tokens and the output pay full price.
 */
export function switchSavingUsd(input: SwitchSavingInput): number {
  const { estimatedInputTokens, estOutputTokens, from, to, horizonTurns } = input;
  const cached = input.cacheReadTokens ?? 0;
  const fresh = Math.max(0, estimatedInputTokens - cached);
  const effectiveInput = CACHED_INPUT_RATE * cached + fresh;
  const perTurn = ((from.price.in - to.price.in) * effectiveInput + (from.price.out - to.price.out) * estOutputTokens) / PER_MILLION;
  return perTurn * horizonTurns;
}

export interface SwitchEstimateInput extends SwitchSavingInput {
  readonly lastUsage: LastUsage | undefined;
}

/** Both sides of a model switch, or undefined when the previous call's cache reads are unknown. */
export function estimateSwitch(input: SwitchEstimateInput): SwitchCostEstimate | undefined {
  const { lastUsage } = input;
  if (lastUsage?.cacheReadTokens === undefined) return undefined;
  return {
    penaltyUsd: cachePenaltyUsd({ lastUsage, from: input.from, to: input.to }),
    savingUsd: switchSavingUsd({ ...input, cacheReadTokens: lastUsage.cacheReadTokens }),
  };
}
