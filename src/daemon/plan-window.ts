import type { PlanUtilization } from "../core/types";

/**
 * Plan usage windows reported by subscription upstreams on every response, observed live:
 *
 * - Anthropic (Claude Code OAuth): `anthropic-ratelimit-unified-5h-utilization: 0.65` and `-7d-utilization` as a
 *   fraction, `anthropic-ratelimit-unified-5h-reset: 1790737200` in Unix seconds.
 * - ChatGPT Codex backend: `x-codex-primary-used-percent: 0` and `x-codex-secondary-used-percent: 2` as a percentage,
 *   `x-codex-{primary,secondary}-window-minutes` (300 and 10080), `x-codex-primary-reset-at` in Unix seconds.
 *
 * Both forms are parsed defensively: a value read from a `percent` header or ending in `%` is a percentage, and so is a
 * bare value above 1.5 (a fraction slightly over 1, as an overdrawn window might report, stays a fraction).
 */
export interface PlanWindow extends PlanUtilization {
  /** ISO time the five-hour window resets, when reported. */
  readonly resetsAt?: string;
  readonly observedAt: number;
}

export type HeaderGet = (name: string) => string | null;

const FIVE_HOURS_MIN = 300;
const SEVEN_DAYS_MIN = 7 * 24 * 60;
/** Windows up to this length count as the short (five-hour) window when the upstream labels them by minutes. */
const SHORT_WINDOW_MAX_MIN = 12 * 60;

/** Bare values up to this are fractions; above it they can only be percentages. */
const FRACTION_MAX = 1.5;

/** A utilization value as a fraction 0..1, from `0.43`, `43`, or `43%`. */
export function toFraction(raw: string | null, percent = false): number | undefined {
  if (raw === null) return undefined;
  const text = raw.trim();
  const isPct = percent || text.endsWith("%");
  const n = Number(text.replace(/%$/, ""));
  if (text === "" || !Number.isFinite(n) || n < 0) return undefined;
  const f = isPct || n > FRACTION_MAX ? n / 100 : n;
  return Math.min(1, f);
}

/** An ISO timestamp from Unix seconds, Unix milliseconds, or an ISO / HTTP date. */
export function toIso(raw: string | null): string | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const text = raw.trim();
  const n = Number(text);
  const ms = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(text);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

function anthropicWindow(get: HeaderGet): Omit<PlanWindow, "observedAt"> | undefined {
  const fiveHour = toFraction(get("anthropic-ratelimit-unified-5h-utilization"));
  const sevenDay = toFraction(get("anthropic-ratelimit-unified-7d-utilization"));
  if (fiveHour === undefined && sevenDay === undefined) return undefined;
  const resetsAt = toIso(get("anthropic-ratelimit-unified-5h-reset"));
  return {
    ...(fiveHour !== undefined ? { fiveHour } : {}),
    ...(sevenDay !== undefined ? { sevenDay } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function codexWindow(get: HeaderGet): Omit<PlanWindow, "observedAt"> | undefined {
  let fiveHour: number | undefined;
  let sevenDay: number | undefined;
  let resetsAt: string | undefined;
  for (const [slot, fallbackMinutes] of [
    ["primary", FIVE_HOURS_MIN],
    ["secondary", SEVEN_DAYS_MIN],
  ] as const) {
    const used = toFraction(get(`x-codex-${slot}-used-percent`), true);
    if (used === undefined) continue;
    const minutes = Number(get(`x-codex-${slot}-window-minutes`) ?? Number.NaN);
    const window = Number.isFinite(minutes) && minutes > 0 ? minutes : fallbackMinutes;
    if (window <= SHORT_WINDOW_MAX_MIN) {
      fiveHour = used;
      resetsAt = toIso(get(`x-codex-${slot}-reset-at`));
    } else sevenDay = used;
  }
  if (fiveHour === undefined && sevenDay === undefined) return undefined;
  return {
    ...(fiveHour !== undefined ? { fiveHour } : {}),
    ...(sevenDay !== undefined ? { sevenDay } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/** The plan window a response reports, or undefined when it carries none of the known headers. Pure. */
export function parsePlanWindow(get: HeaderGet, now: number): PlanWindow | undefined {
  const w = anthropicWindow(get) ?? codexWindow(get);
  return w ? { ...w, observedAt: now } : undefined;
}

/** Last plan window per subscription egress, in memory only. Fields a response omits keep their previous value. */
export class PlanWindowStore {
  private readonly windows = new Map<string, PlanWindow>();

  update(egress: string, get: HeaderGet, now: number): void {
    const next = parsePlanWindow(get, now);
    if (!next) return;
    this.windows.set(egress, { ...this.windows.get(egress), ...next });
  }

  get(egress: string): PlanWindow | undefined {
    return this.windows.get(egress);
  }

  /**
   * The utilization rules may act on. The five-hour value is dropped once its window has reset, since the upstream
   * has not yet said how full the new one is.
   */
  utilization(egress: string, now: number): PlanUtilization | undefined {
    const w = this.windows.get(egress);
    if (!w) return undefined;
    const reset = w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN;
    const stale = Number.isFinite(reset) && now >= reset;
    const fiveHour = stale ? undefined : w.fiveHour;
    if (fiveHour === undefined && w.sevenDay === undefined) return undefined;
    return { ...(fiveHour !== undefined ? { fiveHour } : {}), ...(w.sevenDay !== undefined ? { sevenDay: w.sevenDay } : {}) };
  }

  snapshot(): Readonly<Record<string, PlanWindow>> {
    return Object.fromEntries(this.windows);
  }
}
