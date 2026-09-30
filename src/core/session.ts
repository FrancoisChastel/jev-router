import type { CurrentAssignment, LastUsage, NormalizedRequest, SessionState } from "./types";

const LEDGER_MAX_BATCHES = 20;

export function emptySession(): SessionState {
  return { turn: 0, ledger: [], consecutiveFailures: 0 };
}

export interface AdvanceOptions {
  readonly current?: CurrentAssignment;
  readonly holdUntilTurn?: number;
}

/** Returns the session state after processing `request` with the given assignment. Pure. */
export function advanceSession(session: SessionState, request: NormalizedRequest, opts: AdvanceOptions): SessionState {
  const batch = request.toolOutcomes;
  const ledger = batch.length > 0 ? [...session.ledger, batch].slice(-LEDGER_MAX_BATCHES) : session.ledger;
  const consecutiveFailures =
    batch.length === 0 ? session.consecutiveFailures : batch.every((o) => o.isError) ? session.consecutiveFailures + 1 : 0;
  const next: SessionState = {
    turn: session.turn + 1,
    ledger,
    consecutiveFailures,
    ...(opts.current !== undefined ? { current: opts.current } : session.current !== undefined ? { current: session.current } : {}),
    ...(opts.holdUntilTurn !== undefined
      ? { holdUntilTurn: opts.holdUntilTurn }
      : session.holdUntilTurn !== undefined
        ? { holdUntilTurn: session.holdUntilTurn }
        : {}),
    ...(request.contextCompacted
      ? { lastCompactionTurn: session.turn }
      : session.lastCompactionTurn !== undefined
        ? { lastCompactionTurn: session.lastCompactionTurn }
        : {}),
  };
  return next;
}

/**
 * Attach the usage the upstream reported for the call just served, so the next decision can weigh the cached prefix.
 * Without usage the previous value is dropped: it described an older call. Pure; only token counts are kept.
 */
export function withUsage(session: SessionState, usage: LastUsage | undefined): SessionState {
  const { lastUsage: _stale, ...rest } = session;
  if (!usage) return rest;
  const lastUsage: LastUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
  };
  return { ...rest, lastUsage };
}

export interface SessionKey {
  readonly key: string;
  readonly source: string;
}

/**
 * Resolve a session key from harness headers, then a key the request body carries (Gemini CLI's Code Assist requests
 * hold `session_id`), falling back to a digest of the conversation prefix. Header names are matched case-insensitively.
 */
export function resolveSessionKey(
  headers: Readonly<Record<string, string | undefined>>,
  prefixDigest: string,
  bodyKey?: string,
): SessionKey {
  const h = (name: string): string | undefined => {
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name && v) return v;
    return undefined;
  };
  const cc = h("x-claude-code-session-id");
  if (cc) {
    const agent = h("x-claude-code-agent-id");
    return { key: agent ? `cc:${cc}:${agent}` : `cc:${cc}`, source: "claude-code" };
  }
  const codex = h("thread-id") ?? h("conversation_id") ?? h("session_id") ?? h("session-id");
  if (codex) return { key: `codex:${codex}`, source: "codex" };
  const pi = h("x-session-id");
  if (pi) return { key: `sid:${pi}`, source: "x-session-id" };
  const oc = h("x-opencode-session");
  if (oc) return { key: `oc:${oc}`, source: "opencode" };
  if (bodyKey) return { key: bodyKey, source: "body" };
  return { key: `prefix:${prefixDigest}`, source: "prefix" };
}
