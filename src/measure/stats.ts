import type { Candidate, Policy } from "../core/policy/types";
import type { DecisionRecord, TokenUsage } from "../core/record";

const PER_MILLION = 1_000_000;

export interface BaselineStat {
  /** What the same traffic would have cost on this candidate alone, using the tokens actually observed. */
  readonly costUsd: number;
  /** Positive when the router beat this baseline, negative when it lost to it. */
  readonly savingsUsd: number;
  readonly savingsPct: number | null;
}

export interface StatsReport {
  readonly decisions: number;
  readonly withUsage: number;
  readonly sessions: number;
  readonly actualCostUsd: number;
  readonly baselines: Readonly<Record<string, BaselineStat>>;
  readonly byCandidate: Readonly<Record<string, number>>;
  readonly bySource: Readonly<Record<string, number>>;
  readonly applyFailures: number;
  readonly judge: {
    readonly calls: number;
    readonly failures: number;
    readonly costUsd: number;
    readonly latencyP50Ms: number | null;
    readonly latencyP95Ms: number | null;
  };
}

/** Cost of one call on a candidate. Cached input is priced as input; v1 has no per-provider cache pricing. */
export function costOf(candidate: Candidate, usage: TokenUsage): number {
  return (usage.inputTokens / PER_MILLION) * candidate.price.in + (usage.outputTokens / PER_MILLION) * candidate.price.out;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null;
}

const bump = (m: Record<string, number>, k: string): void => {
  m[k] = (m[k] ?? 0) + 1;
};

/** Aggregate a decision log. Every baseline is reported, including the ones that make the router look bad. */
export function summarize(records: readonly DecisionRecord[], policy: Policy): StatsReport {
  const byCandidate: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const sessions = new Set<string>();
  const baselineCost: Record<string, number> = {};
  for (const id of Object.keys(policy.candidates)) baselineCost[id] = 0;
  let actual = 0;
  let withUsage = 0;
  let applyFailures = 0;
  let judgeCalls = 0;
  let judgeFailures = 0;
  let judgeCost = 0;
  const latencies: number[] = [];

  for (const r of records) {
    sessions.add(r.session);
    bump(byCandidate, r.decision.candidate);
    bump(bySource, r.decision.source);
    if (r.apply && !r.apply.ok) applyFailures += 1;
    if (r.judge) {
      if (r.judge.error) judgeFailures += 1;
      else {
        judgeCalls += 1;
        judgeCost += r.judge.costUsd ?? 0;
        if (typeof r.judge.latencyMs === "number") latencies.push(r.judge.latencyMs);
      }
    }
    if (!r.usage) continue;
    withUsage += 1;
    const served = policy.candidates[r.decision.candidate];
    if (served) actual += costOf(served, r.usage);
    for (const [id, c] of Object.entries(policy.candidates)) baselineCost[id] = (baselineCost[id] ?? 0) + costOf(c, r.usage);
  }

  const baselines: Record<string, BaselineStat> = {};
  for (const [id, cost] of Object.entries(baselineCost)) {
    const savings = cost - actual;
    baselines[id] = { costUsd: cost, savingsUsd: savings, savingsPct: cost > 0 ? savings / cost : null };
  }
  latencies.sort((a, b) => a - b);
  return {
    decisions: records.length,
    withUsage,
    sessions: sessions.size,
    actualCostUsd: actual,
    baselines,
    byCandidate,
    bySource,
    applyFailures,
    judge: {
      calls: judgeCalls,
      failures: judgeFailures,
      costUsd: judgeCost,
      latencyP50Ms: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95),
    },
  };
}

/** Parse a JSONL decision log leniently: malformed lines are counted, not fatal. */
export function parseLog(text: string): { readonly records: readonly DecisionRecord[]; readonly skipped: number } {
  const records: DecisionRecord[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line) as DecisionRecord;
      if (v && typeof v === "object" && v.decision && typeof v.session === "string") records.push(v);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}
