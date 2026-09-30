import type { Candidate } from "./policy/types";
import { EFFORT_ORDER, type Effort } from "./types";

const rank = (e: Effort): number => EFFORT_ORDER.indexOf(e);

/** The candidate's effort levels, least to most. */
export function sortedEfforts(candidate: Candidate): readonly Effort[] {
  return [...(candidate.effort ?? [])].sort((a, b) => rank(a) - rank(b));
}

/** Nearest supported level at or below `want`, else the lowest supported. `supported` must be sorted and non-empty. */
function clampTo(supported: readonly Effort[], want: Effort): Effort {
  if (supported.includes(want)) return want;
  const lower = supported.filter((e) => rank(e) < rank(want));
  return (lower.length > 0 ? lower[lower.length - 1] : supported[0]) as Effort;
}

/** Resolve the effort to send for `candidate`: the wanted level, else its default, clamped to what it accepts. */
export function resolveEffort(candidate: Candidate, wanted: Effort | undefined): { effort?: Effort; clamped: boolean } {
  const supported = sortedEfforts(candidate);
  if (supported.length === 0) return { clamped: false };
  const want = wanted ?? candidate.default_effort;
  if (!want) return { clamped: false };
  const effort = clampTo(supported, want);
  return { effort, clamped: effort !== want };
}

/**
 * The next effort level above the one in use on `candidate`, or undefined when it is already at its top level or has
 * no effort list. The level in use is `inUse`, else the candidate's default, else the middle of its list.
 */
export function effortStepUp(candidate: Candidate, inUse: Effort | undefined): Effort | undefined {
  const supported = sortedEfforts(candidate);
  if (supported.length === 0) return undefined;
  const start = inUse ?? candidate.default_effort ?? (supported[Math.floor((supported.length - 1) / 2)] as Effort);
  return supported[supported.indexOf(clampTo(supported, start)) + 1];
}

/** The higher of two levels; either may be absent. */
export function higherEffort(a: Effort | undefined, b: Effort | undefined): Effort | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return rank(a) >= rank(b) ? a : b;
}
