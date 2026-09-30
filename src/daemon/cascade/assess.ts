import type { CascadeTrigger } from "../../core/policy/types";
import type { Dialect } from "../dialects/types";
import { jsonObject, sseDataObjects } from "./body";
import { EMPTY_REPLY, type Fold, foldAnthropic, foldChat, foldGemini, foldResponses, type ReplySummary } from "./replies";

export interface AssessInput {
  readonly dialect: Dialect;
  readonly status: number;
  readonly contentType: string;
  /** The complete response body as received from the upstream. */
  readonly body: string;
  /** Triggers to look for, in this order of precedence. Defaults to all four. */
  readonly on?: readonly CascadeTrigger[];
}

export type Assessment = { readonly ok: true } | { readonly ok: false; readonly trigger: CascadeTrigger; readonly detail: string };

const ALL: readonly CascadeTrigger[] = ["upstream_error", "empty", "refusal", "truncated"];
const FOLDS: Readonly<Record<Dialect, Fold>> = {
  anthropic: foldAnthropic,
  "openai-chat": foldChat,
  "openai-responses": foldResponses,
  gemini: foldGemini,
  "gemini-code-assist": foldGemini,
};
/** Replies longer than this are real answers even when they open with an apology. */
export const REFUSAL_MAX_CHARS = 400;
const REFUSAL_LEXICON = /\b(i can't|i cannot|i'm unable|i am unable|i won't|as an ai)\b/i;
const TRUNCATED_STOPS: ReadonlySet<string> = new Set(["max_tokens", "length", "max_output_tokens", "incomplete"]);

/** 429, 5xx, and Anthropic's 529 "overloaded" are worth a retry on another model; other 4xx are the client's to fix. */
export const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

export function summarize(dialect: Dialect, contentType: string, body: string): ReplySummary | undefined {
  const fold = FOLDS[dialect];
  if (contentType.includes("text/event-stream")) return sseDataObjects(body).reduce(fold, EMPTY_REPLY);
  const json = jsonObject(body);
  return json ? fold(EMPTY_REPLY, json) : undefined;
}

type Check = (reply: ReplySummary) => string | undefined;

const CHECKS: Readonly<Record<Exclude<CascadeTrigger, "upstream_error">, Check>> = {
  empty: (r) => (!r.toolCall && r.text.trim() === "" && r.refusal === "" ? "no assistant text and no tool call" : undefined),
  refusal: (r) => {
    if (r.toolCall) return undefined;
    if (r.refusal) return `provider-flagged refusal: ${r.refusal.slice(0, 80)}`;
    const text = r.text.trim().replace(/’/g, "'");
    if (text.length === 0 || text.length > REFUSAL_MAX_CHARS) return undefined;
    const hit = REFUSAL_LEXICON.exec(text);
    return hit ? `short reply matching "${hit[1]?.toLowerCase()}"` : undefined;
  },
  truncated: (r) => (r.stop && TRUNCATED_STOPS.has(r.stop) ? `stop reason ${r.stop}` : undefined),
};

/**
 * Decide whether a complete upstream response looks like a failed attempt. Pure: the same input always gives the
 * same answer. Bodies that cannot be read as the dialect's format are never a trigger except by HTTP status.
 */
export function assessResponse(input: AssessInput): Assessment {
  const on = input.on ?? ALL;
  if (input.status < 200 || input.status >= 300) {
    return on.includes("upstream_error") && isRetryableStatus(input.status)
      ? { ok: false, trigger: "upstream_error", detail: `HTTP ${input.status}` }
      : { ok: true };
  }
  const reply = summarize(input.dialect, input.contentType, input.body);
  if (!reply) return { ok: true };
  if (reply.error !== undefined && on.includes("upstream_error"))
    return { ok: false, trigger: "upstream_error", detail: `error event: ${reply.error}` };
  const text = reply.finalText || reply.text;
  const view: ReplySummary = { ...reply, text };
  for (const trigger of on) {
    if (trigger === "upstream_error") continue;
    const detail = CHECKS[trigger](view);
    if (detail) return { ok: false, trigger, detail };
  }
  return { ok: true };
}
