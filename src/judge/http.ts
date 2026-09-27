import type { Answer, EvaluateOptions, Judge, JudgeRequest, JudgeResult, JudgeUsage } from "./types";

export type Transport = "typesafe" | "vercel" | "openrouter";

const ENDPOINTS: Readonly<
  Record<Transport, { readonly base: string; readonly path: string; readonly model: string; readonly sessionField: boolean }>
> = {
  typesafe: { base: "https://api.typesafe.ai", path: "/v1/systemone", model: "jev-latest", sessionField: false },
  vercel: { base: "https://ai-gateway.vercel.sh/typesafe", path: "/v1/systemone", model: "typesafe-ai/jev", sessionField: false },
  openrouter: { base: "https://openrouter.ai/api", path: "/alpha/decisions", model: "typesafe/jev-1.13", sessionField: true },
};

export function endpointFor(transport: Transport, baseUrl?: string): { url: string; model: string } {
  const e = ENDPOINTS[transport];
  const base = (baseUrl ?? e.base).replace(/\/+$/, "");
  return { url: `${base}${e.path}`, model: e.model };
}

export type JudgeErrorCode = "http" | "timeout" | "network" | "cancelled" | "invalid_response";

export class JudgeError extends Error {
  constructor(
    message: string,
    readonly code: JudgeErrorCode,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JudgeError";
  }
}

export interface HttpJudgeOptions {
  readonly transport: Transport;
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /** Per-attempt deadline. Default 1500 ms. */
  readonly timeoutMs?: number;
  /** Retries after a retryable failure. Default 1. */
  readonly maxRetries?: number;
  /** Base backoff. Default 250 ms, doubled per attempt with jitter. */
  readonly retryDelayMs?: number;
  readonly fetch?: typeof fetch;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

const ANSWER_TYPES: ReadonlySet<string> = new Set(["choice", "score", "noul"]);

function isAbortError(e: unknown): boolean {
  return typeof e === "object" && e !== null && "name" in e && (e as { name: unknown }).name === "AbortError";
}

function normalizeUsage(raw: unknown, meta: unknown): JudgeUsage {
  const u = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const inputTokens = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const outputTokens = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  let cost: number | undefined = typeof u.cost === "number" ? u.cost : undefined;
  if (cost === undefined && typeof meta === "object" && meta !== null) {
    const gw = (meta as { gateway?: { cost?: unknown } }).gateway;
    const c = gw?.cost;
    const n = typeof c === "string" ? Number(c) : typeof c === "number" ? c : Number.NaN;
    if (Number.isFinite(n)) cost = n;
  }
  return { inputTokens, outputTokens, ...(cost !== undefined ? { costUsd: cost } : {}) };
}

function parseAnswers(raw: unknown): Readonly<Record<string, Answer>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new JudgeError("response has no answers object", "invalid_response", false);
  const out: Record<string, Answer> = {};
  for (const [id, a] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof a !== "object" || a === null || !ANSWER_TYPES.has(String((a as { type?: unknown }).type))) {
      throw new JudgeError(`answer '${id}' has an unknown shape`, "invalid_response", false);
    }
    out[id] = a as Answer;
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** HTTP transport for the TypeSafe request shape across TypeSafe direct, Vercel AI Gateway, and OpenRouter Decisions. */
export class HttpJudge implements Judge {
  private readonly url: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpJudgeOptions) {
    const e = endpointFor(opts.transport, opts.baseUrl);
    this.url = e.url;
    this.model = opts.model ?? e.model;
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.maxRetries = opts.maxRetries ?? 1;
    this.retryDelayMs = opts.retryDelayMs ?? 250;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async evaluate(request: JudgeRequest, evalOpts: EvaluateOptions = {}): Promise<JudgeResult> {
    const body = JSON.stringify({
      model: this.model,
      state: request.state,
      questions: request.questions,
      ...(ENDPOINTS[this.opts.transport].sessionField && request.sessionId ? { session_id: request.sessionId } : {}),
    });
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.apiKey}`,
      "content-type": "application/json",
      ...this.opts.extraHeaders,
    };

    let lastError: JudgeError = new JudgeError("no attempt made", "network", false);
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const started = performance.now();
      const result = await this.attempt(body, headers, evalOpts.signal);
      if (result.ok) return { ...result.value, latencyMs: performance.now() - started };
      lastError = result.error;
      if (!lastError.retryable || attempt === this.maxRetries) break;
      await sleep(this.retryDelayMs * 2 ** attempt * (0.5 + Math.random()));
    }
    throw lastError;
  }

  private async attempt(
    body: string,
    headers: Record<string, string>,
    outer: AbortSignal | undefined,
  ): Promise<{ ok: true; value: Omit<JudgeResult, "latencyMs"> } | { ok: false; error: JudgeError }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const onOuterAbort = () => ctrl.abort();
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, { method: "POST", headers, body, signal: ctrl.signal });
      } catch (e) {
        if (isAbortError(e)) {
          return outer?.aborted
            ? { ok: false, error: new JudgeError("cancelled", "cancelled", false) }
            : { ok: false, error: new JudgeError(`judge timed out after ${this.timeoutMs} ms`, "timeout", true) };
        }
        return { ok: false, error: new JudgeError(e instanceof Error ? e.message : String(e), "network", true) };
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
        return { ok: false, error: new JudgeError(`judge responded ${res.status}: ${text.slice(0, 200)}`, "http", retryable, res.status) };
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { ok: false, error: new JudgeError("judge returned non-JSON", "invalid_response", false, res.status) };
      }
      const obj = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
      try {
        const answers = parseAnswers(obj.answers);
        const usage = normalizeUsage(obj.usage, obj.provider_metadata);
        const model = typeof obj.model === "string" ? obj.model : this.model;
        return { ok: true, value: { model, answers, usage } };
      } catch (e) {
        return { ok: false, error: e instanceof JudgeError ? e : new JudgeError(String(e), "invalid_response", false) };
      }
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }
}
