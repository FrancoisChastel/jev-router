import type { Harness, ToolOutcome } from "../types";
import { classifyTool, type ToolSemantics } from "./tool-semantics";

/**
 * Execution-phase scorer modeled on Switchyard's stage router.
 * Recovery axes (severity, spinning, exploring) push toward the capable tier;
 * production intensity pushes toward the efficient tier. Each axis contributes at most 0.5 to the
 * signed raw score, and confidence is tanh(|raw|), so one maxed axis lands at ~0.46 and only
 * corroborating axes cross a 0.5 threshold.
 */

export interface StageOptions {
  readonly recentTurnWindow?: number;
  readonly toolSemantics?: ToolSemantics;
}

export interface StageDimensions {
  readonly severity: number;
  readonly spinning: number;
  readonly exploring: number;
  readonly production_intensity: number;
}

export interface StageScore {
  readonly abstained: boolean;
  /** Signed: positive means capable, negative means efficient. */
  readonly raw: number;
  readonly confidence: number;
  readonly direction: "capable" | "efficient" | "none";
  readonly dimensions: StageDimensions;
  /** A critical error marker was seen in the window. */
  readonly critical: boolean;
}

const CRITICAL =
  /traceback \(most recent call last\)|\bfatal\b|\bpanic\b|segmentation fault|\bsegfault\b|out of memory|ENOSPC|EACCES|permission denied/i;
const EXPLORE_SATURATION = 6;
const SPIN_SATURATION = 3;
const AXIS_WEIGHT = 0.5;
/** Confidence produced by exactly one maxed axis. A threshold below this lets a single axis decide on its own. */
export const SINGLE_AXIS_CONFIDENCE = Math.tanh(AXIS_WEIGHT);

const ABSTAIN: StageScore = {
  abstained: true,
  raw: 0,
  confidence: 0,
  direction: "none",
  dimensions: { severity: 0, spinning: 0, exploring: 0, production_intensity: 0 },
  critical: false,
};

function repeatKey(o: ToolOutcome): string {
  return `${o.name}|${(o.errorText ?? o.excerpt ?? "").slice(0, 120)}`;
}

export function scoreStage(ledger: readonly (readonly ToolOutcome[])[], harness: Harness, opts: StageOptions): StageScore {
  const windowSize = Math.max(1, opts.recentTurnWindow ?? 3);
  const batches = ledger.filter((b) => b.length > 0).slice(-windowSize);
  if (batches.length === 0) return ABSTAIN;

  let weightTotal = 0;
  let errorWeight = 0;
  let observeWeight = 0;
  let mutateOkWeight = 0;
  let critical = false;
  const repeats = new Map<string, number>();
  let count = 0;

  batches.forEach((batch, i) => {
    const w = (i + 1) / batches.length;
    for (const o of batch) {
      count += 1;
      weightTotal += w;
      const cls = classifyTool(o.name, harness, opts.toolSemantics);
      if (o.isError) {
        errorWeight += w;
        if (CRITICAL.test(o.errorText ?? o.excerpt ?? "")) critical = true;
        const key = repeatKey(o);
        repeats.set(key, (repeats.get(key) ?? 0) + 1);
      } else if (cls === "mutate") {
        mutateOkWeight += w;
      }
      if (cls === "observe" || cls === "plan") observeWeight += w;
    }
  });

  const severity = critical ? 1 : errorWeight / weightTotal;
  const maxRepeat = Math.max(0, ...repeats.values());
  const spinning = Math.min(1, Math.max(0, (maxRepeat - 1) / SPIN_SATURATION));
  const exploring = mutateOkWeight > 0 ? 0 : (observeWeight / weightTotal) * Math.min(1, count / EXPLORE_SATURATION);
  const production_intensity = mutateOkWeight / weightTotal;

  const raw = AXIS_WEIGHT * (severity + spinning + exploring) - AXIS_WEIGHT * production_intensity;
  const confidence = Math.tanh(Math.abs(raw));
  const direction = raw > 0 ? "capable" : raw < 0 ? "efficient" : "none";
  return { abstained: false, raw, confidence, direction, dimensions: { severity, spinning, exploring, production_intensity }, critical };
}
