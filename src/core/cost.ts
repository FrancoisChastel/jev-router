import type { Candidate } from "./policy/types";

const PER_MILLION = 1_000_000;

export function estimateCostUsd(candidate: Candidate, inputTokens: number, outputTokens: number): number {
  return (inputTokens / PER_MILLION) * candidate.price.in + (outputTokens / PER_MILLION) * candidate.price.out;
}

export function counterfactualCosts(
  candidates: Readonly<Record<string, Candidate>>,
  ids: readonly string[],
  inputTokens: number,
  outputTokens: number,
): Readonly<Record<string, { readonly estCostUsd: number }>> {
  const out: Record<string, { estCostUsd: number }> = {};
  for (const id of ids) {
    const c = candidates[id];
    if (c) out[id] = { estCostUsd: estimateCostUsd(c, inputTokens, outputTokens) };
  }
  return out;
}
