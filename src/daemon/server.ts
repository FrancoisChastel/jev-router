import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { EgressInput, Policy } from "../core/policy/types";
import type { DecisionRecord } from "../core/record";
import type { Harness, RequestClass, ToolOutcome } from "../core/types";
import type { FetchLike } from "../judge/http";
import type { Judge } from "../judge/types";
import { DIALECTS } from "./dialects";
import { asEffort, type DialectAdapter, type JsonObject, type NormalizedBody } from "./dialects/types";
import { claudeCodeHookToObserve, codexHookToObserve } from "./hooks";
import { errorBody, flattenHeaders, readJsonBody, sendJson } from "./http-util";
import { proxy, relay } from "./relay";
import { RouterService } from "./service";
import { type ObserveEvent, SessionStore } from "./session-store";

export interface DaemonOptions {
  readonly policy: Policy;
  readonly judge?: Judge;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (record: DecisionRecord) => void;
  readonly host?: string;
  readonly port?: number;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly maxBodyBytes?: number;
  /** Serve this candidate for every routed request and only log the router's decision. */
  readonly shadow?: string;
  /**
   * Shared secret callers must present as `Authorization: Bearer <token>` or `x-api-key`. Required when
   * binding to anything other than loopback, because the relay injects real provider credentials.
   */
  readonly token?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function presentsToken(headers: Readonly<Record<string, string | undefined>>, token: string): boolean {
  const auth = headers.authorization ?? "";
  return sameSecret(auth, `Bearer ${token}`) || sameSecret(headers["x-api-key"] ?? "", token);
}

export interface RunningDaemon {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  readonly store: SessionStore;
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY = 64 * 1024 * 1024;
const HARNESSES: ReadonlySet<string> = new Set(["pi", "claude-code", "codex", "opencode", "hermes", "unknown"]);
const OBSERVE_KINDS: ReadonlySet<string> = new Set(["tool_result", "compaction", "api_error", "subagent_start", "prompt"]);

function dialectForPath(path: string): DialectAdapter | undefined {
  if (path === "/v1/messages") return DIALECTS.anthropic;
  if (path === "/v1/chat/completions") return DIALECTS["openai-chat"];
  if (path === "/v1/responses") return DIALECTS["openai-responses"];
  return undefined;
}

interface Mount {
  readonly name: string;
  readonly egress: EgressInput;
  readonly subpath: string;
}

/** The egress whose `mount` prefixes this path, with the remaining sub-path. */
function findMount(policy: Policy, path: string): Mount | undefined {
  for (const [name, egress] of Object.entries(policy.egress)) {
    const m = egress.mount;
    if (!m) continue;
    if (path === m || path.startsWith(`${m}/`)) return { name, egress, subpath: path.slice(m.length) || "/" };
  }
  return undefined;
}

function dialectForSubpath(sub: string): DialectAdapter | undefined {
  if (sub === "/responses" || sub === "/v1/responses") return DIALECTS["openai-responses"];
  if (sub === "/chat/completions" || sub === "/v1/chat/completions") return DIALECTS["openai-chat"];
  if (sub === "/messages" || sub === "/v1/messages") return DIALECTS.anthropic;
  return undefined;
}

/**
 * Codex checks the model it is told to use against the catalog its backend returns, so a proxied catalog gains an
 * `auto` entry cloned from the model the codex policy starts on. Other catalogs pass through untouched.
 */
export function withAutoModel(json: JsonObject, policy: Policy): JsonObject {
  if (!Array.isArray(json.models)) return json;
  const models = json.models.filter(isObject);
  if (models.some((m) => m.slug === "auto")) return json;
  const route = policy.routes.find((r) => r.harness === "codex" && r.id === "auto") ?? policy.routes.find((r) => r.id === "auto");
  const def = route ? policy.policies[route.policy] : undefined;
  const slug = def ? policy.candidates[def.default]?.model : undefined;
  const template = models.find((m) => m.slug === slug) ?? models.find((m) => m.visibility === "list") ?? models[0];
  if (!template) return json;
  const auto = { ...template, slug: "auto", display_name: "auto (jev-router)", visibility: "list", priority: 0 };
  return { ...json, models: [auto, ...json.models] };
}

function modelsListing(policy: Policy): string {
  const data = policy.routes
    .filter((r) => r.id !== "*")
    .map((r) => ({
      id: r.id,
      object: "model",
      created: 0,
      owned_by: "jev-router",
      display_name: r.id,
      description: `jev-router policy '${r.policy}' for ${r.harness}`,
    }));
  return JSON.stringify({
    object: "list",
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  });
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Build a NormalizedBody from the loosely-typed /decide payload sent by in-process plugins. */
function bodyFromDecidePayload(raw: JsonObject): NormalizedBody {
  const r = isObject(raw.request) ? raw.request : {};
  const outcomes: ToolOutcome[] = Array.isArray(r.toolOutcomes)
    ? r.toolOutcomes.filter(isObject).map((o) => ({
        name: String(o.name ?? "unknown"),
        isError: o.isError === true,
        ...(typeof o.errorText === "string" ? { errorText: o.errorText.slice(-200) } : {}),
        ...(typeof o.excerpt === "string" ? { excerpt: o.excerpt.slice(-200) } : {}),
      }))
    : [];
  const effort = asEffort(r.requestedEffort);
  return {
    requestedModel: typeof r.requestedModel === "string" ? r.requestedModel : "auto",
    isNewUserTurn: r.isNewUserTurn !== false,
    ...(typeof r.lastUserText === "string" ? { lastUserText: r.lastUserText } : {}),
    ...(typeof r.assistantIntentTail === "string" ? { assistantIntentTail: r.assistantIntentTail } : {}),
    toolNames: Array.isArray(r.toolNames) ? r.toolNames.filter((t): t is string => typeof t === "string") : [],
    hasImages: r.hasImages === true,
    toolOutcomes: outcomes,
    ...(effort ? { requestedEffort: effort } : {}),
    stream: false,
    prefixDigestInput: "",
  };
}

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const env = opts.env ?? process.env;
  const store = new SessionStore();
  const service = new RouterService({
    policy: opts.policy,
    judge: opts.judge,
    store,
    log: opts.log ?? (() => undefined),
    now: opts.now ?? (() => Date.now()),
    randomId: opts.randomId ?? (() => crypto.randomUUID()),
  });
  if (opts.shadow && !opts.policy.candidates[opts.shadow]) throw new Error(`shadow candidate '${opts.shadow}' is not in the policy`);
  const relayDeps = { policy: opts.policy, service, env, fetch: opts.fetch ?? fetch, ...(opts.shadow ? { shadow: opts.shadow } : {}) };
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const headers = flattenHeaders(req);

    const isProbe = method === "HEAD" && path === "/api/hello";
    if (opts.token && path !== "/healthz" && !isProbe && !presentsToken(headers, opts.token)) {
      sendJson(res, 401, errorBody(dialectForPath(path)?.dialect, 401, "jev-router: missing or invalid token"));
      return;
    }
    if (method === "HEAD" && path === "/api/hello") {
      res.writeHead(200);
      res.end();
      return;
    }
    if (method === "GET" && path === "/healthz") {
      sendJson(res, 200, JSON.stringify({ ok: true, sessions: store.size }));
      return;
    }
    if (method === "GET" && path === "/v1/models") {
      sendJson(res, 200, modelsListing(opts.policy));
      return;
    }

    const mounted = findMount(opts.policy, path);
    if (mounted && method !== "POST") {
      await proxy(relayDeps, mounted, {
        res,
        headers,
        method,
        path: mounted.subpath,
        query: url.search,
        ...(mounted.subpath === "/models" ? { transformJson: (j: JsonObject) => withAutoModel(j, opts.policy) } : {}),
      });
      return;
    }

    if (method === "POST") {
      // Client-disconnect detection. Node emits close on the response when the client goes away mid-stream,
      // with the response unfinished. The request's own close event is not usable: it fires when the body ends.
      // Bun's node:http currently emits nothing on a mid-stream abort, so cancellation does not propagate there.
      const clientGone = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) clientGone.abort();
      });
      let raw: string;
      try {
        raw = await readJsonBody(req, maxBody);
      } catch (e) {
        sendJson(res, 413, errorBody(dialectForPath(path)?.dialect, 413, e instanceof Error ? e.message : String(e)));
        return;
      }

      if (mounted) {
        const mountedDialect = dialectForSubpath(mounted.subpath);
        if (mountedDialect) {
          await relay(relayDeps, {
            req,
            res,
            headers,
            dialect: mountedDialect,
            path: mounted.subpath,
            query: url.search,
            rawBody: raw,
            clientGone: clientGone.signal,
            egressName: mounted.name,
          });
          return;
        }
        await proxy(relayDeps, mounted, {
          res,
          headers,
          method,
          path: mounted.subpath,
          query: url.search,
          rawBody: raw,
          clientGone: clientGone.signal,
        });
        return;
      }
      const dialect = dialectForPath(path);
      if (dialect) {
        await relay(relayDeps, { req, res, headers, dialect, path, query: url.search, rawBody: raw, clientGone: clientGone.signal });
        return;
      }
      if (path === "/v1/messages/count_tokens") {
        await relay(relayDeps, {
          countTokens: true,
          req,
          res,
          headers,
          dialect: DIALECTS.anthropic,
          path,
          query: url.search,
          rawBody: raw === "" ? "{}" : raw,
          clientGone: clientGone.signal,
        });
        return;
      }
      if (path === "/hooks/claude-code" || path === "/hooks/codex") {
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          sendJson(res, 400, errorBody(undefined, 400, "invalid JSON"));
          return;
        }
        if (isObject(payload)) {
          const event = path === "/hooks/claude-code" ? claudeCodeHookToObserve(payload) : codexHookToObserve(payload);
          if (event) store.observe(event);
        }
        // Hook output format: an empty object means "no decision, carry on".
        sendJson(res, 200, "{}");
        return;
      }
      if (path === "/observe") {
        let event: unknown;
        try {
          event = JSON.parse(raw);
        } catch {
          sendJson(res, 400, errorBody(undefined, 400, "invalid JSON"));
          return;
        }
        if (!isObject(event) || typeof event.session !== "string" || !OBSERVE_KINDS.has(String(event.event))) {
          sendJson(res, 400, errorBody(undefined, 400, "observe needs { session, event }"));
          return;
        }
        store.observe(event as unknown as ObserveEvent);
        res.writeHead(204);
        res.end();
        return;
      }
      if (path === "/decide") {
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          sendJson(res, 400, errorBody(undefined, 400, "invalid JSON"));
          return;
        }
        if (!isObject(payload) || typeof payload.sessionKey !== "string") {
          sendJson(res, 400, errorBody(undefined, 400, "decide needs { sessionKey, request }"));
          return;
        }
        const harness = HARNESSES.has(String(payload.harness)) ? (payload.harness as Harness) : "unknown";
        const policyId =
          typeof payload.policyId === "string" && opts.policy.policies[payload.policyId]
            ? payload.policyId
            : (opts.policy.routes.find((r) => r.harness === harness || r.harness === "any")?.policy ??
              Object.keys(opts.policy.policies)[0] ??
              "default");
        const body = bodyFromDecidePayload(payload);
        const requestClass = typeof payload.requestClass === "string" ? (payload.requestClass as RequestClass) : undefined;
        const decided = await service.decide({
          harness,
          sessionKey: payload.sessionKey,
          policyId,
          body,
          ...(requestClass ? { requestClass } : {}),
          ...(payload.contextCompacted === true ? { contextCompacted: true } : {}),
          estimatedInputTokens: typeof payload.estimatedInputTokens === "number" ? payload.estimatedInputTokens : 0,
        });
        const record = decided.commit({ ok: true });
        sendJson(res, 200, JSON.stringify({ decision: decided.decision, recordId: record.id }));
        return;
      }
    }
    sendJson(res, 404, errorBody(dialectForPath(path)?.dialect, 404, `no handler for ${method} ${path}`));
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) sendJson(res, 500, errorBody(undefined, 500, e instanceof Error ? e.message : String(e)));
      else res.destroy();
    });
  });
  const host = opts.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host) && !opts.token) {
    throw new Error(
      `refusing to bind ${host} without a token: the relay injects provider credentials, so set --token (or JEV_ROUTER_TOKEN) for any non-loopback bind`,
    );
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);
  return {
    url: `http://${host}:${port}`,
    port,
    host,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
