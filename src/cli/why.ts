import type { Policy } from "../core/policy/types";
import type { DecisionRecord } from "../core/record";
import { costAndSaving } from "../daemon/status";
import type { Answer } from "../judge/types";

/**
 * `jev-router why`: the last decisions from the log, one human-readable block each. Pure formatting; the command in
 * main.ts reads the log and the policy.
 */

export interface WhyOptions {
  /** Session key (`cc:<id>`, `codex:<id>`) or the bare id after the prefix. */
  readonly session?: string;
  readonly last: number;
}

/** Whether a record belongs to the session the user named, with or without the harness prefix. */
export function matchesSession(record: DecisionRecord, session: string): boolean {
  if (record.session === session || record.session.startsWith(`${session}:`)) return true;
  const bare = record.session.split(":")[1];
  return bare === session;
}

export function selectRecords(records: readonly DecisionRecord[], opts: WhyOptions): readonly DecisionRecord[] {
  const pool = opts.session ? records.filter((r) => matchesSession(r, opts.session as string)) : records;
  return pool.slice(-Math.max(1, opts.last));
}

const usd = (n: number): string => `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 6 : 4)}`;
const pct = (n: number): string => `${Math.round(n * 100)}%`;

function answerText(a: Answer): string {
  if (a.type === "noul") return String(a.noul);
  if (a.type === "score") return `${a.score.toFixed(2)}@${(a.confidence ?? 0).toFixed(2)}`;
  return `${a.choice}@${(a.confidence ?? 0).toFixed(2)}`;
}

function judgeLine(r: DecisionRecord): string | undefined {
  const j = r.judge;
  if (!j) return undefined;
  if (j.error) return `judge     ${j.error}`;
  const answers = Object.entries(j.answers ?? {})
    .map(([id, a]) => `${id}=${answerText(a)}`)
    .join(" ");
  const meta = [
    j.model,
    j.latencyMs !== undefined ? `${Math.round(j.latencyMs)}ms` : undefined,
    j.costUsd !== undefined ? usd(j.costUsd) : undefined,
  ]
    .filter((x) => x !== undefined)
    .join(", ");
  return `judge     ${answers || "(no answers)"}${meta ? `  (${meta})` : ""}`;
}

function costLines(r: DecisionRecord, policy: Policy | undefined): string[] {
  const lines: string[] = [];
  const money = policy ? costAndSaving(r, policy) : undefined;
  if (r.usage)
    lines.push(
      `usage     ${r.usage.inputTokens} in / ${r.usage.outputTokens} out${money ? `  cost ${usd(money.costUsd)}  saved ${usd(money.savedUsd)} vs the priciest tier` : ""}`,
    );
  const cf = Object.entries(r.decision.counterfactuals);
  if (cf.length > 0) lines.push(`estimate  ${cf.map(([id, c]) => `${id} ${usd(c.estCostUsd)}`).join("  ")}`);
  return lines;
}

/** Compact one-line JSON for fields this version does not model, such as a cascade trace. */
const compact = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
};

export function formatDecision(r: DecisionRecord, policy?: Policy): string {
  const d = r.decision;
  const served = r.shadow ? `  (shadow: served ${r.shadow.served})` : "";
  const cascade = (r as unknown as { readonly cascade?: unknown }).cascade;
  const lines = [
    `${new Date(r.ts).toISOString()}  ${r.session}  turn ${r.turn}${r.requestClass ? `  ${r.requestClass}` : ""}${r.isNewUserTurn ? "  user turn" : ""}`,
    `decision  ${d.candidate} -> ${d.model}${d.effort ? ` (${d.effort})` : ""}  via ${d.source}${d.confidence !== undefined ? ` @${d.confidence.toFixed(2)}` : ""}${served}`,
    `reasons   ${d.reasons.length > 0 ? d.reasons.join(", ") : "(none)"}`,
    judgeLine(r),
    ...costLines(r, policy),
    r.plan
      ? `plan      ${[r.plan.fiveHour !== undefined ? `5h ${pct(r.plan.fiveHour)}` : undefined, r.plan.sevenDay !== undefined ? `7d ${pct(r.plan.sevenDay)}` : undefined].filter(Boolean).join("  ")}`
      : undefined,
    cascade !== undefined ? `cascade   ${compact(cascade)}` : undefined,
    r.apply && !r.apply.ok ? `apply     failed${r.apply.error ? `: ${r.apply.error}` : ""}` : undefined,
  ];
  return lines.filter((l): l is string => l !== undefined).join("\n");
}

export function formatWhy(records: readonly DecisionRecord[], opts: WhyOptions, policy?: Policy): string {
  const picked = selectRecords(records, opts);
  if (picked.length === 0) return opts.session ? `no decisions for session ${opts.session}` : "no decisions logged yet";
  return picked.map((r) => formatDecision(r, policy)).join("\n\n");
}
