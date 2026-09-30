import type { JsonObject } from "./dialects/types";

/**
 * Cursor quirks, kept apart from the generic relay.
 *
 * Cursor's backend posts to `<base URL>/chat/completions`, but its agent sends some models (the GPT family) a
 * Responses-API body there (`input` instead of `messages`) and still expects chat-completion chunks back. OpenRouter
 * serves a Cursor surface at `/api/v1/cursor` that accepts both shapes and answers as chat completions, so Cursor
 * traffic bound for OpenRouter goes there. Other egresses receive the request unchanged.
 */

const CHAT_PATH = "/v1/chat/completions";
const OPENROUTER_CURSOR_CHAT_PATH = "/v1/cursor/chat/completions";

function isOpenRouter(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

/** Upstream path for a Cursor request: OpenRouter's Cursor surface for chat completions, the same path otherwise. */
export function cursorUpstreamPath(egressBaseUrl: string, path: string): string {
  return path === CHAT_PATH && isOpenRouter(egressBaseUrl) ? OPENROUTER_CURSOR_CHAT_PATH : path;
}

/** A Responses-API body that arrived on the chat-completions path. */
export function isResponsesShaped(body: JsonObject): boolean {
  return Array.isArray(body.input) && !Array.isArray(body.messages);
}
