import type { Headers } from "./http-util";

/**
 * Cross-origin access for a token-guarded relay. Cursor's desktop app checks a custom base URL from its Electron
 * renderer, which sends a CORS preflight without credentials before the real call. A preflight carries no token and
 * reveals nothing, and the real request still needs the token, so a guarded relay may answer both. A relay without a
 * token never does: CORS there would let any web page spend the keys the relay injects.
 */

const PREFLIGHT_MAX_AGE_S = 600;
const DEFAULT_ALLOWED_HEADERS = "authorization, content-type, x-api-key";

export function isPreflight(method: string, h: Headers): boolean {
  return method === "OPTIONS" && h.origin !== undefined && h["access-control-request-method"] !== undefined;
}

export function preflightHeaders(h: Headers): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": h["access-control-request-headers"] ?? DEFAULT_ALLOWED_HEADERS,
    "access-control-max-age": String(PREFLIGHT_MAX_AGE_S),
  };
}

/** Header added to every response of a guarded relay to a request that came from a browser context. */
export function corsResponseHeaders(h: Headers): Record<string, string> {
  return h.origin !== undefined ? { "access-control-allow-origin": "*" } : {};
}
