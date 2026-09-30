import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { nextTier } from "../core/escalate";
import type { EgressInput, Policy, RouteInput } from "../core/policy/types";
import { resolveSessionKey } from "../core/session";
import type { Decision, Harness } from "../core/types";
import type { FetchLike } from "../judge/http";
import { runCascade } from "./cascade/run";
import { type DialectAdapter, isObject, type JsonObject } from "./dialects/types";
import { defaultEgress, egressFor, forward } from "./forward";
import { copyResponseHeaders, detectHarness, errorBody, type Headers, requestClassOf, sendJson, upstreamHeaders } from "./http-util";
import type { Decided, RouterService } from "./service";

export interface RelayDeps {
  readonly policy: Policy;
  readonly service: RouterService;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: FetchLike;
  /** Shadow mode: always serve this candidate while logging what the router would have done. */
  readonly shadow?: string;
}

const CHARS_PER_TOKEN = 4;

/**
 * Exact route id first, then any `<prefix>/auto` maps onto the `auto` route so picker-friendly names such as
 * `claude-code/auto` or `claude/auto` route even when the policy only declares `auto`, then a `*` catch-all.
 */
function findRoute(policy: Policy, id: string, harness: Harness): RouteInput | undefined {
  const pick = (candidates: readonly RouteInput[]) =>
    candidates.find((r) => r.harness === harness) ?? candidates.find((r) => r.harness === "any") ?? candidates[0];
  const exact = pick(policy.routes.filter((r) => r.id === id));
  if (exact) return exact;
  if (id.endsWith("/auto")) {
    const generic = pick(policy.routes.filter((r) => r.id === "auto"));
    if (generic) return generic;
  }
  return policy.routes.find((r) => r.id === "*");
}

export interface RelayRequest {
  /** Token counting must never route, log, or advance a session; it only needs a real model id. */
  readonly countTokens?: boolean;
  /** Aborts when the client connection closes before the response finished. */
  readonly clientGone?: AbortSignal;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly headers: Headers;
  readonly dialect: DialectAdapter;
  readonly path: string;
  readonly query: string;
  readonly rawBody: string;
  /** Egress that must serve an unrouted request, set when the request arrived under that egress's mount. */
  readonly egressName?: string;
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
    const mounted = r.egressName ? policy.egress[r.egressName] : undefined;
    const target = mounted && r.egressName ? { name: r.egressName, egress: mounted } : defaultEgress(policy);
    if (!target) {
      sendJson(r.res, 502, errorBody(r.dialect.dialect, 502, "no egress configured for passthrough"));
      return;
    }
    await forward(deps, r, target, body, { source: "passthrough" });
    return;
  }

  const digest = createHash("sha256").update(normalized.prefixDigestInput).digest("hex").slice(0, 32);
  const { key: sessionKey } = resolveSessionKey(r.headers, digest);

  if (r.countTokens) {
    // Use the model this session is currently on (or the policy default) so the count matches the tokenizer in use.
    const def = policy.policies[route.policy];
    const current = deps.service.currentCandidate(sessionKey) ?? def?.default;
    const candidate = current ? policy.candidates[current] : undefined;
    const target = egressFor(policy, candidate);
    if (!target || !candidate) {
      sendJson(r.res, 502, errorBody(r.dialect.dialect, 502, "no egress configured for token counting"));
      return;
    }
    await forward(
      deps,
      r,
      target,
      { ...body, model: candidate.model },
      { source: "count_tokens", requestedModel: normalized.requestedModel },
    );
    return;
  }
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
  const cascade = policy.policies[route.policy]?.cascade;
  if (cascade?.enabled && !deps.shadow && nextTier(policy, route.policy, decided.request, decided.decision)) {
    await runCascade({
      deps,
      r,
      body,
      requestedModel: normalized.requestedModel,
      policyId: route.policy,
      config: cascade,
      decided,
      routingHeaders: (served) => routingHeaders(served, decided.decision),
    });
    return;
  }
  await serveDecision(deps, r, body, normalized.requestedModel, decided);
}

function routingHeaders(served: Decision, decision: Decision): Record<string, string> {
  return {
    "x-jev-router-model": served.model,
    "x-jev-router-candidate": served.candidate,
    "x-jev-router-decision": decision.candidate,
    ...(served.effort ? { "x-jev-router-effort": served.effort } : {}),
  };
}

/** Forward a routed request once, on the decided candidate or, in shadow mode, on the shadow candidate. */
async function serveDecision(deps: RelayDeps, r: RelayRequest, body: JsonObject, requestedModel: string, decided: Decided): Promise<void> {
  const { policy } = deps;
  const servedId = deps.shadow && policy.candidates[deps.shadow] ? deps.shadow : decided.decision.candidate;
  const candidate = policy.candidates[servedId];
  const shadow = servedId !== decided.decision.candidate || deps.shadow ? { served: servedId } : undefined;
  const target = egressFor(policy, candidate);
  if (!target) {
    decided.commit({ ok: false, error: "no egress configured" });
    sendJson(r.res, 502, errorBody(r.dialect.dialect, 502, "no egress configured for the selected candidate"));
    return;
  }
  const served = shadow && candidate ? { ...decided.decision, candidate: servedId, model: candidate.model } : decided.decision;
  await forward(deps, r, target, r.dialect.rewrite(body, served), {
    source: shadow ? "shadow" : decided.decision.source,
    requestedModel,
    extraHeaders: routingHeaders(served, decided.decision),
    onDone: (ok, usage, error) => decided.commit(ok ? { ok: true } : { ok: false, ...(error ? { error } : {}) }, usage, shadow),
  });
}

export interface ProxyRequest {
  readonly res: ServerResponse;
  readonly headers: Headers;
  readonly method: string;
  /** Sub-path below the egress base URL, query included separately. */
  readonly path: string;
  readonly query: string;
  readonly rawBody?: string;
  readonly clientGone?: AbortSignal;
  /** Rewrites a complete JSON response body before it is sent; streams and non-JSON bodies pass untouched. */
  readonly transformJson?: (json: JsonObject) => JsonObject;
}

/**
 * Forward one request to an egress unchanged apart from credentials: no routing, no session, no log. Used for the
 * endpoints a harness needs next to inference when its own login is forwarded, such as Codex's model catalog.
 */
export async function proxy(
  deps: RelayDeps,
  target: { readonly name: string; readonly egress: EgressInput },
  p: ProxyRequest,
): Promise<void> {
  const apiKey = target.egress.api_key_env ? deps.env[target.egress.api_key_env] : undefined;
  const forwardAuth = target.egress.forward_auth === true;
  if (!forwardAuth && !apiKey) {
    sendJson(p.res, 502, errorBody(undefined, 502, `egress '${target.name}' has no API key configured`));
    return;
  }
  const url = `${target.egress.base_url.replace(/\/+$/, "")}${p.path}${p.query}`;
  // "anthropic" makes upstreamHeaders inject both bearer and x-api-key when a key is used; harmless elsewhere.
  const headers = upstreamHeaders(p.headers, { ...(apiKey ? { apiKey } : {}), forwardAuth, dialect: "anthropic" });
  const hasBody = p.rawBody !== undefined && p.rawBody !== "" && p.method !== "GET" && p.method !== "HEAD";
  if (!hasBody) delete headers["content-type"];
  const abort = new AbortController();
  let finished = false;
  const onClientGone = () => {
    if (!finished) abort.abort();
  };
  if (p.clientGone?.aborted) onClientGone();
  p.clientGone?.addEventListener("abort", onClientGone, { once: true });

  let upstream: Response;
  try {
    upstream = await deps.fetch(url, { method: p.method, headers, ...(hasBody ? { body: p.rawBody } : {}), signal: abort.signal });
  } catch (e) {
    finished = true;
    if (!p.res.headersSent)
      sendJson(p.res, 502, errorBody(undefined, 502, `upstream unreachable: ${e instanceof Error ? e.message : String(e)}`));
    return;
  }
  p.res.statusCode = upstream.status;
  copyResponseHeaders(upstream, p.res);
  p.res.setHeader("x-jev-router-source", "proxy");
  p.res.setHeader("x-jev-router-egress", target.name);
  const contentType = upstream.headers.get("content-type") ?? "";
  if (p.transformJson && upstream.ok && contentType.includes("application/json")) {
    const text = await upstream.text();
    finished = true;
    let out = text;
    try {
      const json: unknown = JSON.parse(text);
      if (isObject(json)) out = JSON.stringify(p.transformJson(json));
    } catch {
      /* not JSON after all: pass it through untouched */
    }
    p.res.setHeader("content-length", Buffer.byteLength(out));
    p.res.end(out);
    return;
  }
  if (!upstream.body) {
    finished = true;
    p.res.end();
    return;
  }
  try {
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) p.res.write(chunk);
    p.res.end();
  } catch {
    p.res.destroy();
  }
  finished = true;
}
