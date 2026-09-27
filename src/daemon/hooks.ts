import type { ObserveEvent } from "./session-store";

type Payload = Readonly<Record<string, unknown>>;
const TEXT_TAIL = 200;

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const tail = (s: string): string => (s.length > TEXT_TAIL ? s.slice(-TEXT_TAIL) : s);

/** Best-effort text of a tool result, whatever shape the harness used. */
function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v !== "object" || v === null) return "";
  const o = v as Record<string, unknown>;
  for (const key of ["content", "output", "stdout", "text", "result", "message"]) {
    const t = o[key];
    if (typeof t === "string") return t;
    if (Array.isArray(t))
      return t
        .map((x) => (typeof x === "string" ? x : typeof x === "object" && x !== null ? String((x as { text?: unknown }).text ?? "") : ""))
        .join("\n");
  }
  try {
    return JSON.stringify(o).slice(0, 1000);
  } catch {
    return "";
  }
}

function looksLikeError(v: unknown, text: string): boolean {
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.exit_code === "number" && o.exit_code !== 0) return true;
    if (typeof o.exitCode === "number" && o.exitCode !== 0) return true;
    if (o.error !== undefined && o.error !== null && o.error !== false) return true;
    if (o.is_error === true || o.isError === true) return true;
  }
  return /^(error|traceback|exception|fatal|panic)\b/i.test(text.trimStart().slice(0, 100));
}

function toolEvent(session: string, name: string, isError: boolean, text: string): ObserveEvent {
  const bounded = tail(text);
  return { session, event: "tool_result", tool: { name, isError, ...(bounded ? { text: bounded } : {}) } };
}

/**
 * Map a native Claude Code hook payload to an observe event. The session key mirrors what the relay derives
 * from x-claude-code-session-id and x-claude-code-agent-id, so hook signals join the same session.
 */
export function claudeCodeHookToObserve(payload: Payload): ObserveEvent | undefined {
  const sessionId = str(payload.session_id);
  if (!sessionId) return undefined;
  const agent = str(payload.agent_id);
  const session = agent ? `cc:${sessionId}:${agent}` : `cc:${sessionId}`;
  const name = str(payload.tool_name) ?? "unknown";
  switch (payload.hook_event_name) {
    case "PostToolUse":
      return toolEvent(session, name, false, textOf(payload.tool_output ?? payload.tool_response));
    case "PostToolUseFailure":
      return toolEvent(session, name, true, str(payload.tool_use_error) ?? textOf(payload.tool_output));
    case "PostCompact":
      return { session, event: "compaction" };
    case "StopFailure": {
      const type = str(payload.error_type);
      const message = str(payload.error);
      const error = [type, message].filter(Boolean).join(": ");
      return { session, event: "api_error", ...(error ? { error: tail(error) } : {}) };
    }
    case "SubagentStart":
      return { session, event: "subagent_start" };
    case "UserPromptSubmit":
      return { session, event: "prompt" };
    default:
      return undefined;
  }
}

/** Map a native Codex hook payload. Codex carries no error flag on tool results, so errors are inferred from content. */
export function codexHookToObserve(payload: Payload): ObserveEvent | undefined {
  const sessionId = str(payload.session_id);
  if (!sessionId) return undefined;
  const session = `codex:${sessionId}`;
  switch (payload.hook_event_name) {
    case "PostToolUse": {
      const text = textOf(payload.tool_response);
      return toolEvent(session, str(payload.tool_name) ?? "unknown", looksLikeError(payload.tool_response, text), text);
    }
    case "PostCompact":
      return { session, event: "compaction" };
    case "UserPromptSubmit":
      return { session, event: "prompt" };
    case "SubagentStart":
      return { session, event: "subagent_start" };
    default:
      return undefined;
  }
}
