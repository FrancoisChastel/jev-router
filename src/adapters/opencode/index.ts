import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { looksLikeError } from "../../daemon/dialects/types";
import type { ObserveEvent } from "../../daemon/session-store";
import type { FetchLike } from "../../judge/http";

const TEXT_TAIL = 200;
const POST_TIMEOUT_MS = 1000;
const tail = (s: string): string => (s.length > TEXT_TAIL ? s.slice(-TEXT_TAIL) : s);

export interface OpenCodeAdapterOptions {
  /** Relay base URL. Default $JEV_ROUTER_URL or http://127.0.0.1:4141. */
  readonly relayUrl?: string;
  readonly fetch?: FetchLike;
  readonly warn?: (message: string) => void;
}

export interface ToolAfterInput {
  readonly tool: string;
  readonly sessionID: string;
  readonly callID: string;
  readonly args: unknown;
}
export interface ToolAfterOutput {
  readonly title: string;
  readonly output: string;
  readonly metadata: unknown;
}

function metadataSaysError(metadata: unknown): boolean {
  if (typeof metadata !== "object" || metadata === null) return false;
  const m = metadata as Record<string, unknown>;
  if (typeof m.exit === "number" && m.exit !== 0) return true;
  if (typeof m.exitCode === "number" && m.exitCode !== 0) return true;
  return m.error === true || (typeof m.error === "string" && m.error !== "");
}

/** OpenCode tool results carry no error flag on the hook, so errors are inferred from metadata and output. */
export function mapToolResult(input: ToolAfterInput, output: ToolAfterOutput): ObserveEvent {
  const text = typeof output.output === "string" ? output.output : "";
  const isError = metadataSaysError(output.metadata) || looksLikeError(text);
  return {
    session: `oc:${input.sessionID}`,
    event: "tool_result",
    tool: { name: input.tool, isError, ...(text ? { text: tail(text) } : {}) },
  };
}

export function mapEvent(event: { readonly type: string; readonly properties?: unknown }): ObserveEvent | undefined {
  const props = (typeof event.properties === "object" && event.properties !== null ? event.properties : {}) as Record<string, unknown>;
  const sessionID = typeof props.sessionID === "string" ? props.sessionID : undefined;
  if (!sessionID) return undefined;
  if (event.type === "session.compacted") return { session: `oc:${sessionID}`, event: "compaction" };
  if (event.type === "session.error") {
    const err = props.error as { name?: unknown; data?: { message?: unknown } } | undefined;
    const message = [
      typeof err?.name === "string" ? err.name : undefined,
      typeof err?.data?.message === "string" ? err.data.message : undefined,
    ]
      .filter(Boolean)
      .join(": ");
    return { session: `oc:${sessionID}`, event: "api_error", ...(message ? { error: tail(message) } : {}) };
  }
  return undefined;
}

/**
 * OpenCode plugin: sensors plus session identification. Model switching happens in the relay, which OpenCode
 * reaches through the jev-router provider, and the relay already applies reasoning effort for the chat dialect.
 */
export function createOpenCodePlugin(opts: OpenCodeAdapterOptions = {}): Plugin {
  const relayUrl = (opts.relayUrl ?? process.env.JEV_ROUTER_URL ?? "http://127.0.0.1:4141").replace(/\/+$/, "");
  const fetchImpl = opts.fetch ?? fetch;
  const warn = opts.warn ?? ((m: string) => console.error(m));
  let warned = false;

  const post = async (event: ObserveEvent): Promise<void> => {
    try {
      await fetchImpl(`${relayUrl}/observe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
    } catch (e) {
      if (!warned) {
        warned = true;
        warn(`jev-router: relay at ${relayUrl} unreachable, signals dropped (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  };

  return async (): Promise<Hooks> => ({
    "chat.headers": async (input, output) => {
      output.headers["x-opencode-session"] = input.sessionID;
    },
    "tool.execute.after": async (input, output) => {
      await post(mapToolResult(input, output));
    },
    event: async ({ event }) => {
      const mapped = mapEvent(event as { type: string; properties?: unknown });
      if (mapped) await post(mapped);
    },
  });
}

const plugin: Plugin = createOpenCodePlugin();
export default plugin;
