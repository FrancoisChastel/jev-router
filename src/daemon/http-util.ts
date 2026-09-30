import type { IncomingMessage, ServerResponse } from "node:http";
import type { TokenUsage } from "../core/record";
import type { Harness, RequestClass } from "../core/types";
import type { Dialect } from "./dialects/types";

export type Headers = Readonly<Record<string, string | undefined>>;

export function flattenHeaders(req: IncomingMessage): Headers {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);
const REQUEST_DROP: ReadonlySet<string> = new Set([
  ...HOP_BY_HOP,
  "host",
  "content-length",
  "accept-encoding",
  "authorization",
  "x-api-key",
  "x-goog-api-key",
]);
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(["authorization", "x-api-key", "x-goog-api-key"]);
const RESPONSE_DROP: ReadonlySet<string> = new Set([...HOP_BY_HOP, "content-length", "content-encoding"]);

/** Gemini dialects authenticate with an `x-goog-api-key` header; a bearer would be read as an OAuth token. */
const isGemini = (dialect: Dialect): boolean => dialect === "gemini" || dialect === "gemini-code-assist";

/** Headers forwarded upstream: everything the client sent except hop-by-hop, host, length, encoding, and credentials. */
export function upstreamHeaders(
  incoming: Headers,
  opts: { readonly apiKey?: string; readonly forwardAuth: boolean; readonly dialect: Dialect },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue;
    if (REQUEST_DROP.has(k) && !(opts.forwardAuth && CREDENTIAL_HEADERS.has(k))) continue;
    out[k] = v;
  }
  if (!opts.forwardAuth && opts.apiKey) {
    if (isGemini(opts.dialect)) out["x-goog-api-key"] = opts.apiKey;
    else out.authorization = `Bearer ${opts.apiKey}`;
    if (opts.dialect === "anthropic") out["x-api-key"] = opts.apiKey;
  }
  out["content-type"] = "application/json";
  out["accept-encoding"] = "identity";
  return out;
}

export function copyResponseHeaders(from: Response, to: ServerResponse): void {
  from.headers.forEach((value, key) => {
    if (!RESPONSE_DROP.has(key.toLowerCase())) to.setHeader(key, value);
  });
}

export function detectHarness(h: Headers): Harness {
  const ua = (h["user-agent"] ?? "").toLowerCase();
  if (h["x-claude-code-session-id"] || ua.includes("claude-cli") || ua.includes("claude-code")) return "claude-code";
  if ((h.originator ?? "").toLowerCase().includes("codex") || ua.includes("codex")) return "codex";
  if (h["x-opencode-session"] || ua.includes("opencode")) return "opencode";
  if (ua.includes("pi-coding-agent") || ua.startsWith("pi/")) return "pi";
  // "GeminiCLI/<version>/<model> (...)", "GeminiCLI-<client>/...", or the VS Code form ending in "proxy_client=geminicli".
  if (ua.includes("geminicli")) return "gemini";
  return "unknown";
}

const REQUEST_CLASSES: ReadonlySet<string> = new Set(["main", "subagent", "workflow", "compaction", "auxiliary"]);
export function requestClassOf(h: Headers): RequestClass | undefined {
  const v = h["x-claude-code-request-class"];
  return v && REQUEST_CLASSES.has(v) ? (v as RequestClass) : undefined;
}

export function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error(`request body exceeds ${limitBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** google.rpc.Code names Google APIs put in `error.status`, which Gemini clients read. */
const GOOGLE_STATUS: Readonly<Record<number, string>> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  404: "NOT_FOUND",
  413: "INVALID_ARGUMENT",
  502: "UNAVAILABLE",
};

export function errorBody(dialect: Dialect | undefined, status: number, message: string): string {
  const type =
    status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" : status === 404 ? "not_found_error" : "api_error";
  if (dialect === "anthropic") return JSON.stringify({ type: "error", error: { type, message } });
  if (dialect && isGemini(dialect))
    return JSON.stringify({ error: { code: status, message, status: GOOGLE_STATUS[status] ?? "INTERNAL" } });
  return JSON.stringify({ error: { message, type, code: null } });
}

export function sendJson(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...extra });
  res.end(body);
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Gemini bills thinking tokens as output but reports them apart from the candidates. */
function geminiOutputTokens(raw: Record<string, unknown>): number | undefined {
  const candidates = num(raw.candidatesTokenCount);
  const thoughts = num(raw.thoughtsTokenCount);
  return candidates === undefined && thoughts === undefined ? undefined : (candidates ?? 0) + (thoughts ?? 0);
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * The usage object of a complete response or stream event, whatever the dialect: `usage` (Anthropic, OpenAI), or
 * Gemini's `usageMetadata`, which the Code Assist backend nests under `response`.
 */
export function usageOf(json: Record<string, unknown>): Record<string, unknown> | undefined {
  const response = asRecord(json.response);
  return (
    asRecord(json.usage) ??
    asRecord(asRecord(json.message)?.usage) ??
    asRecord(response?.usage) ??
    asRecord(json.usageMetadata) ??
    asRecord(response?.usageMetadata)
  );
}

/** Fold a provider usage object into the running total, taking the larger value per field so streamed partials compose. */
export function mergeUsage(acc: TokenUsage | undefined, raw: Record<string, unknown>): TokenUsage {
  const details = (k: string): Record<string, unknown> =>
    typeof raw[k] === "object" && raw[k] !== null ? (raw[k] as Record<string, unknown>) : {};
  const input = num(raw.input_tokens) ?? num(raw.prompt_tokens) ?? num(raw.promptTokenCount);
  const output = num(raw.output_tokens) ?? num(raw.completion_tokens) ?? geminiOutputTokens(raw);
  const cacheRead =
    num(raw.cache_read_input_tokens) ??
    num(details("prompt_tokens_details").cached_tokens) ??
    num(details("input_tokens_details").cached_tokens) ??
    num(raw.cachedContentTokenCount);
  const cacheWrite = num(raw.cache_creation_input_tokens);
  const cost = num(raw.cost);
  const max = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined ? b : b === undefined ? a : Math.max(a, b);
  const merged = {
    inputTokens: max(acc?.inputTokens, input) ?? 0,
    outputTokens: max(acc?.outputTokens, output) ?? 0,
    cacheReadTokens: max(acc?.cacheReadTokens, cacheRead),
    cacheWriteTokens: max(acc?.cacheWriteTokens, cacheWrite),
    costUsd: max(acc?.costUsd, cost),
  };
  return {
    inputTokens: merged.inputTokens,
    outputTokens: merged.outputTokens,
    ...(merged.cacheReadTokens !== undefined ? { cacheReadTokens: merged.cacheReadTokens } : {}),
    ...(merged.cacheWriteTokens !== undefined ? { cacheWriteTokens: merged.cacheWriteTokens } : {}),
    ...(merged.costUsd !== undefined ? { costUsd: merged.costUsd } : {}),
  };
}
