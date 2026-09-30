import { estimateCostUsd } from "../core/cost";
import type { Policy } from "../core/policy/types";
import type { DecisionRecord } from "../core/record";
import type { Effort } from "../core/types";
import type { PlanWindow } from "./plan-window";

/** The last decision of one session, as `GET /status` reports it. Content-free like the decision log. */
export interface SessionStatus {
  readonly candidate: string;
  readonly model: string;
  readonly effort?: Effort;
  /** Egress that serves the candidate, so a reader can pair the session with its plan window. */
  readonly egress?: string;
  readonly source: string;
  readonly reasons: readonly string[];
  readonly ts: number;
  /** Observed cost of the call at the candidate's price; API list-price equivalent on a plan. */
  readonly costUsd?: number;
  /** What the policy's priciest tier would have cost for the same tokens, minus `costUsd`. */
  readonly savedUsd?: number;
}

export interface DayTotals {
  /** Local calendar day, YYYY-MM-DD. */
  readonly day: string;
  readonly decisions: number;
  readonly costUsd: number;
  readonly savedUsd: number;
}

export interface StatusReport {
  readonly plans: Readonly<Record<string, PlanWindow>>;
  readonly sessions: Readonly<Record<string, SessionStatus>>;
  readonly today: DayTotals;
}

const DEFAULT_MAX_SESSIONS = 256;

const localDay = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Observed cost and the saving against the priciest candidate the decision could have used. Undefined without usage. */
export function costAndSaving(record: DecisionRecord, policy: Policy): { readonly costUsd: number; readonly savedUsd: number } | undefined {
  const usage = record.usage;
  const served = policy.candidates[record.shadow?.served ?? record.decision.candidate];
  if (!usage || !served) return undefined;
  const costUsd = estimateCostUsd(served, usage.inputTokens, usage.outputTokens);
  const alternatives = Object.keys(record.decision.counterfactuals)
    .map((id) => policy.candidates[id])
    .filter((c) => c !== undefined)
    .map((c) => estimateCostUsd(c, usage.inputTokens, usage.outputTokens));
  const priciest = Math.max(costUsd, ...alternatives);
  return { costUsd, savedUsd: priciest - costUsd };
}

/** Last decision per session (bounded, most recent kept) and today's totals, fed from the decision log callback. */
export class StatusBoard {
  private readonly sessions = new Map<string, SessionStatus>();
  private totals: DayTotals;

  constructor(
    private readonly policy: Policy,
    private readonly now: () => number,
    private readonly maxSessions = DEFAULT_MAX_SESSIONS,
  ) {
    this.totals = { day: localDay(now()), decisions: 0, costUsd: 0, savedUsd: 0 };
  }

  record(r: DecisionRecord): void {
    const money = costAndSaving(r, this.policy);
    const via = this.policy.candidates[r.decision.candidate]?.via ?? r.decision.via;
    const entry: SessionStatus = {
      candidate: r.decision.candidate,
      model: r.decision.model,
      ...(r.decision.effort ? { effort: r.decision.effort } : {}),
      ...(via ? { egress: via } : {}),
      source: r.decision.source,
      reasons: r.decision.reasons,
      ts: r.ts,
      ...(money ?? {}),
    };
    this.sessions.delete(r.session);
    this.sessions.set(r.session, entry);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const day = localDay(r.ts);
    const base = day === this.totals.day ? this.totals : { day, decisions: 0, costUsd: 0, savedUsd: 0 };
    this.totals = {
      day,
      decisions: base.decisions + 1,
      costUsd: base.costUsd + (money?.costUsd ?? 0),
      savedUsd: base.savedUsd + (money?.savedUsd ?? 0),
    };
  }

  report(plans: Readonly<Record<string, PlanWindow>>): StatusReport {
    const day = localDay(this.now());
    const today = day === this.totals.day ? this.totals : { day, decisions: 0, costUsd: 0, savedUsd: 0 };
    return { plans, sessions: Object.fromEntries(this.sessions), today };
  }
}
