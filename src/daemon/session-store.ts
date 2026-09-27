import { emptySession } from "../core/session";
import type { SessionState, ToolOutcome } from "../core/types";

export type ObserveKind = "tool_result" | "compaction" | "api_error" | "subagent_start" | "prompt";

export interface ObserveEvent {
  readonly session: string;
  readonly event: ObserveKind;
  readonly tool?: { readonly name: string; readonly isError: boolean; readonly text?: string };
  readonly error?: string;
}

export interface PendingSignals {
  readonly compaction: boolean;
  /** Tool outcomes reported by harness hooks since the last request. Higher fidelity than body parsing. */
  readonly outcomes: readonly ToolOutcome[];
}

interface Entry {
  readonly state: SessionState;
  readonly pending: PendingSignals;
  readonly touched: number;
}

const NO_PENDING: PendingSignals = { compaction: false, outcomes: [] };
const MAX_PENDING_OUTCOMES = 32;
const TEXT_TAIL = 200;

export interface SessionStoreOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

/** In-memory session state keyed by the resolved session key, with idle expiry and a size cap. */
export class SessionStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: SessionStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 2 * 60 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): SessionState | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() - e.touched > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e.state;
  }

  set(key: string, state: SessionState): void {
    const prev = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, { state, pending: prev?.pending ?? NO_PENDING, touched: this.now() });
    this.evict();
  }

  observe(event: ObserveEvent): void {
    const prev = this.entries.get(event.session);
    const pending = prev?.pending ?? NO_PENDING;
    const next: PendingSignals =
      event.event === "compaction"
        ? { ...pending, compaction: true }
        : event.event === "tool_result" && event.tool
          ? { ...pending, outcomes: [...pending.outcomes, toOutcome(event.tool)].slice(-MAX_PENDING_OUTCOMES) }
          : event.event === "api_error"
            ? {
                ...pending,
                outcomes: [
                  ...pending.outcomes,
                  { name: "api", isError: true, ...(event.error ? { errorText: event.error.slice(-TEXT_TAIL) } : {}) },
                ].slice(-MAX_PENDING_OUTCOMES),
              }
            : pending;
    this.entries.delete(event.session);
    this.entries.set(event.session, { state: prev?.state ?? emptySession(), pending: next, touched: this.now() });
    this.evict();
  }

  /** Returns and clears the hook-reported signals for a session. */
  takePending(key: string): PendingSignals {
    const e = this.entries.get(key);
    if (!e) return NO_PENDING;
    if (e.pending !== NO_PENDING) this.entries.set(key, { ...e, pending: NO_PENDING });
    return e.pending;
  }

  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, e] of this.entries) if (e.touched < cutoff) this.entries.delete(key);
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

function toOutcome(tool: { readonly name: string; readonly isError: boolean; readonly text?: string }): ToolOutcome {
  const text = tool.text ? tool.text.slice(-TEXT_TAIL) : undefined;
  return { name: tool.name, isError: tool.isError, ...(text ? (tool.isError ? { errorText: text } : { excerpt: text }) : {}) };
}
