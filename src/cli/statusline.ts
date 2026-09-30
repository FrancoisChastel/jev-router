import type { PlanWindow } from "../daemon/plan-window";
import type { StatusReport } from "../daemon/status";
import type { FetchLike } from "../judge/http";

/**
 * `jev-router statusline`: one line for Claude Code's `statusLine` command. Claude Code pipes a JSON object with
 * `session_id` on stdin; the relay's `GET /status` supplies the rest. Anything missing or slow prints nothing.
 */

export const STATUS_TIMEOUT_MS = 300;
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/;

/** The session id Claude Code sent, from its stdin JSON; undefined when absent or not JSON. */
export function sessionIdFrom(stdin: string): string | undefined {
  try {
    const v: unknown = JSON.parse(stdin);
    const id = typeof v === "object" && v !== null ? (v as { session_id?: unknown }).session_id : undefined;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** `claude-sonnet-5` -> `sonnet-5`, `anthropic/claude-opus-5.5` -> `opus-5.5`, `gpt-6-luna` unchanged. */
export function shortModel(model: string): string {
  return model.replace(/^[^/]+\//, "").replace(/^claude-/, "");
}

const money = (n: number): string => `$${n.toFixed(2)}`;

/** Render the status line for a Claude Code session. A reachable relay always shows at least its name. */
export function formatStatusLine(status: StatusReport, sessionId: string | undefined): string {
  const key = sessionId ? `cc:${sessionId}` : undefined;
  const session = key ? status.sessions[key] : undefined;
  // A known session shows its own egress's window (none on a gateway); otherwise the most recently observed one.
  const latest = Object.values(status.plans).reduce<PlanWindow | undefined>(
    (best, w) => (best === undefined || w.observedAt > best.observedAt ? w : best),
    undefined,
  );
  const plan = session ? (session.egress ? status.plans[session.egress] : undefined) : latest;
  const parts = [
    "jev-router",
    ...(session ? [shortModel(session.model)] : []),
    ...(status.today.savedUsd > 0 ? [`saved ${money(status.today.savedUsd)} today`] : []),
    ...(plan?.fiveHour !== undefined ? [`plan 5h ${Math.round(plan.fiveHour * 100)}%`] : []),
  ];
  return parts.join(" · ");
}

export interface StatusLineOptions {
  readonly url: string;
  readonly stdin: string;
  readonly token?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

/** Ask a loopback relay for its status and render the line. Never throws; any failure is an empty line. */
export async function statusLine(opts: StatusLineOptions): Promise<string> {
  if (!LOOPBACK.test(opts.url)) return "";
  try {
    const res = await (opts.fetch ?? fetch)(`${opts.url.replace(/\/+$/, "")}/status`, {
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return "";
    const status = (await res.json()) as StatusReport;
    if (typeof status !== "object" || status === null || typeof status.sessions !== "object" || typeof status.plans !== "object") return "";
    return formatStatusLine(
      { ...status, today: status.today ?? { day: "", decisions: 0, costUsd: 0, savedUsd: 0 } },
      sessionIdFrom(opts.stdin),
    );
  } catch {
    return "";
  }
}
