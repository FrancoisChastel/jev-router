import type { Decision, Effort, ToolOutcome, WireDialect } from "../../core/types";

export type Dialect = WireDialect;

/** What a dialect adapter extracts from a request body, before harness headers and session state are added. */
export interface NormalizedBody {
  readonly requestedModel: string;
  readonly isNewUserTurn: boolean;
  readonly lastUserText?: string;
  readonly assistantIntentTail?: string;
  readonly toolNames: readonly string[];
  readonly hasImages: boolean;
  readonly toolOutcomes: readonly ToolOutcome[];
  readonly requestedEffort?: Effort;
  readonly stream: boolean;
  /** System prompt plus first user text: the input of the prefix digest used as a session key fallback. */
  readonly prefixDigestInput: string;
  /** Session key carried in the body itself (Gemini's Code Assist backend sends one); preferred over the prefix digest. */
  readonly sessionKey?: string;
}

export type JsonObject = Record<string, unknown>;

export interface DialectAdapter {
  readonly dialect: Dialect;
  /** Upstream path relative to an egress base URL. */
  readonly path: string;
  /** `path` is the request path below the egress base URL, for dialects that carry the model there. */
  normalize(body: JsonObject, path?: string): NormalizedBody;
  /** Returns a new body with the model and, where the dialect allows, the effort rewritten. Nothing else changes. */
  rewrite(body: JsonObject, decision: Decision): JsonObject;
  /** Upstream path for a routed request, for dialects whose model lives in the path. Identity when absent. */
  rewritePath?(path: string, decision: Decision): string;
  /** Returns a new JSON response with the requested model id echoed back. */
  echoModel(json: JsonObject, requestedModel: string): JsonObject;
}

export const TEXT_TAIL_CHARS = 400;
export const EXCERPT_TAIL_CHARS = 200;

export const tail = (s: string, n: number): string => (s.length > n ? s.slice(-n) : s);
export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
export const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const EFFORTS: ReadonlySet<string> = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
export const asEffort = (v: unknown): Effort | undefined => (typeof v === "string" && EFFORTS.has(v) ? (v as Effort) : undefined);

/** Heuristic error detection for dialects that carry no explicit error flag on tool outputs. */
export function looksLikeError(text: string): boolean {
  const head = text.trimStart().slice(0, 200);
  if (/^(error|traceback|exception|fatal|panic)\b/i.test(head)) return true;
  if (/"(error|exit_code|exitCode)"\s*:\s*("|[1-9])/.test(head)) return true;
  return false;
}
