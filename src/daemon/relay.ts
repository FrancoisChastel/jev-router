import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Candidate, EgressInput, Policy, RouteInput } from "../core/policy/types";
import type { TokenUsage } from "../core/record";
import { resolveSessionKey } from "../core/session";
import type { Harness } from "../core/types";
import type { DialectAdapter, JsonObject } from "./dialects/types";
import {
  copyResponseHeaders,
  detectHarness,
  errorBody,
  type Headers,
  mergeUsage,
  requestClassOf,
  sendJson,
  upstreamHeaders,
} from "./http-util";
import type { RouterService } from "./service";
import { createSseTransform } from "./sse";

export interface RelayDeps {
  readonly policy: Policy;
  readonly service: RouterService;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
}

const CHARS_PER_TOKEN = 4;

function findRoute(policy: Policy, id: string, harness: Harness): RouteInput | undefined {
  const exact = policy.routes.filter((r) => r.id === id);
  return (
    exact.find((r) => r.harness === harness) ??
    exact.find((r) => r.harness === "any") ??
    exact[0] ??
    policy.routes.find((r) => r.id === "*")
  );
}

function defaultEgress(policy: Policy): { readonly name: string; readonly egress: EgressInput } | undefined {
  const name = Object.keys(policy.egress)[0];
  return name ? { name, egress: policy.egress[name] as EgressInput } : undefined;
}

function egressFor(policy: Policy, candidate: Candidate | undefined): { readonly name: string; readonly egress: EgressInput } | undefined {
  if (candidate?.via && policy.egress[candidate.via]) return { name: candidate.via, egress: policy.egress[candidate.via] as EgressInput };
  return defaultEgress(policy);
}

export interface RelayRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly headers: Headers;
  readonly dialect: DialectAdapter;
  readonly path: string;
  readonly query: string;
  readonly rawBody: string;
}

/** Route one inference request and stream the upstream response back in the client's own wire format. */
export async function relay(deps: RelayDeps, r: RelayRequest): Promise<void> {
  const { policy } = deps;
  let body: JsonObject;
  try {
    const parsed: unknown = JSON.parse(r.rawBody);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("body must be a JSON object");
    body = parsed as JsonObject;
  } catch (e) {
    sendJson(r.res, 400, errorBody(r.dialect.dialect, 400, `invalid JSON body: ${e instanceof Error ? e.message : String(e)}`));
    return;
  }

  const harness = detectHarness(r.headers);
  const normalized = r.dialect.normalize(body);
  const route = findRoute(policy, normalized.requestedModel, harness);

  // Unknown model ids pass straight through to the default egress with credentials swapped and nothing rewritten.
  if (!route) {
    const target = defaultEgress(policy);
    if (!target) {
      sendJson(r.res, 502, errorBody(r.dialect.dialect, 502, "no egress configured for passthrough"));
      return;
    }
    await forward(deps, r, target, body, { source: "passthrough" });
    return;
  }

  const digest = createHash("sha256").update(normalized.prefixDigestInput).digest("hex").slice(0, 32);
  const { key: sessionKey } = resolveSessionKey(r.headers, digest);
  const requestClass = requestClassOf(r.headers);
  const decided = await deps.service.decide({
    harness,
    sessionKey,
    policyId: route.policy,
    body: normalized,
    ...(requestClass ? { requestClass } : {}),
    ...(r.headers["x-claude-code-context-compacted"] ? { contextCompacted: true } : {}),
    estimatedInputTokens: Math.ceil(r.rawBody.length / CHARS_PER_TOKEN),
  });
  const candidate = policy.candidates[decided.decision.candidate];
  const target = egressFor(policy, candidate);
  if (!target) {
    decided.commit({ ok: false, error: "no egress configured" });
    sendJson(r.res, 502, errorBody(r.dialect.dialect, 502, "no egress configured for the selected candidate"));
    return;
  }
  const rewritten = r.dialect.rewrite(body, decided.decision);
  await forward(deps, r, target, rewritten, {
    source: decided.decision.source,
    extraHeaders: {
      "x-jev-router-model": decided.decision.model,
      "x-jev-router-candidate": decided.decision.candidate,
      ...(decided.decision.effort ? { "x-jev-router-effort": decided.decision.effort } : {}),
    },
    onDone: (ok, usage, error) => decided.commit(ok ? { ok: true } : { ok: false, ...(error ? { error } : {}) }, usage),
  });
}

interface ForwardOptions {
  readonly source: string;
  readonly extraHeaders?: Record<string, string>;
  readonly onDone?: (ok: boolean, usage: TokenUsage | undefined, error?: string) => void;
}

async function forward(
  deps: RelayDeps,
  r: RelayRequest,
  target: { readonly name: string; readonly egress: EgressInput },
  body: JsonObject,
  opts: ForwardOptions,
): Promise<void> {
  const apiKey = target.egress.api_key_env ? deps.env[target.egress.api_key_env] : undefined;
  const forwardAuth = target.egress.forward_auth === true;
  if (!forwardAuth && !apiKey) {
    opts.onDone?.(false, undefined, `egress '${target.name}' has no API key in $${target.egress.api_key_env ?? "(unset)"}`);
    sendJson(r.res, 502, errorBody(r.dialect.dialect, 502, `egress '${target.name}' has no API key configured`));
    return;
  }
  const url = `${target.egress.base_url.replace(/\/+$/, "")}${r.path}${r.query}`;
  const headers = upstreamHeaders(r.headers, { ...(apiKey ? { apiKey } : {}), forwardAuth, dialect: r.dialect.dialect });
  const abort = new AbortController();
  let finished = false;
  r.req.on("close", () => {
    if (!finished) abort.abort();
  });

  let upstream: Response;
  try {
    upstream = await deps.fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: abort.signal });
  } catch (e) {
    finished = true;
    const message = e instanceof Error ? e.message : String(e);
    opts.onDone?.(false, undefined, `upstream unreachable: ${message}`);
    if (!r.res.headersSent) sendJson(r.res, 502, errorBody(r.dialect.dialect, 502, `upstream unreachable: ${message}`));
    return;
  }

  r.res.statusCode = upstream.status;
  copyResponseHeaders(upstream, r.res);
  r.res.setHeader("x-jev-router-source", opts.source);
  r.res.setHeader("x-jev-router-egress", target.name);
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) r.res.setHeader(k, v);

  const requestedModel =
    typeof body.model === "string" && opts.source !== "passthrough"
      ? r.dialect.normalize(JSON.parse(r.rawBody) as JsonObject).requestedModel || String(body.model)
      : undefined;
  const contentType = upstream.headers.get("content-type") ?? "";

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    r.res.setHeader("content-length", Buffer.byteLength(text));
    r.res.end(text);
    finished = true;
    opts.onDone?.(false, undefined, `upstream responded ${upstream.status}`);
    return;
  }

  if (contentType.includes("text/event-stream")) {
    let usage: TokenUsage | undefined;
    const stream = requestedModel
      ? upstream.body.pipeThrough(
          createSseTransform({
            requestedModel,
            onUsage: (u) => {
              usage = mergeUsage(usage, u);
            },
          }),
        )
      : upstream.body;
    r.res.flushHeaders();
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) r.res.write(chunk);
      r.res.end();
      finished = true;
      opts.onDone?.(true, usage);
    } catch (e) {
      finished = true;
      r.res.destroy();
      opts.onDone?.(false, usage, `stream interrupted: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  const text = await upstream.text();
  finished = true;
  let out = text;
  let usage: TokenUsage | undefined;
  try {
    const json = JSON.parse(text) as JsonObject;
    if (typeof json.usage === "object" && json.usage !== null) usage = mergeUsage(undefined, json.usage as Record<string, unknown>);
    if (requestedModel) out = JSON.stringify(r.dialect.echoModel(json, requestedModel));
  } catch {
    /* not JSON: forward verbatim */
  }
  r.res.setHeader("content-length", Buffer.byteLength(out));
  r.res.end(out);
  opts.onDone?.(true, usage);
}
