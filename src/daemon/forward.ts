import type { EgressInput, Policy } from "../core/policy/types";
import type { TokenUsage } from "../core/record";
import type { FetchLike } from "../judge/http";
import type { JsonObject } from "./dialects/types";
import { copyResponseHeaders, errorBody, mergeUsage, sendJson, upstreamHeaders } from "./http-util";
import type { RelayRequest } from "./relay";
import { createSseTransform } from "./sse";

export interface Target {
  readonly name: string;
  readonly egress: EgressInput;
}

export interface UpstreamDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: FetchLike;
}

export function defaultEgress(policy: Policy): Target | undefined {
  const name = Object.keys(policy.egress)[0];
  return name ? { name, egress: policy.egress[name] as EgressInput } : undefined;
}

export function egressFor(policy: Policy, candidate: { readonly via?: string } | undefined): Target | undefined {
  if (candidate?.via && policy.egress[candidate.via]) return { name: candidate.via, egress: policy.egress[candidate.via] as EgressInput };
  return defaultEgress(policy);
}

/** A response as the relay delivers it. The body may be a replay of bytes buffered earlier. */
export interface UpstreamReply {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Response["headers"];
  readonly body: ReadableStream<Uint8Array> | null;
}

export type UpstreamCall =
  | { readonly kind: "no_key" | "unreachable"; readonly error: string; readonly clientError: string }
  | { readonly kind: "reply"; readonly reply: UpstreamReply };

/** POST `body` to the target egress with credentials swapped. Aborts when the client goes away. Never throws. */
export async function callUpstream(deps: UpstreamDeps, r: RelayRequest, target: Target, body: JsonObject): Promise<UpstreamCall> {
  const apiKey = target.egress.api_key_env ? deps.env[target.egress.api_key_env] : undefined;
  const forwardAuth = target.egress.forward_auth === true;
  if (!forwardAuth && !apiKey)
    return {
      kind: "no_key",
      error: `egress '${target.name}' has no API key in $${target.egress.api_key_env ?? "(unset)"}`,
      clientError: `egress '${target.name}' has no API key configured`,
    };
  const url = `${target.egress.base_url.replace(/\/+$/, "")}${r.path}${r.query}`;
  const headers = upstreamHeaders(r.headers, { ...(apiKey ? { apiKey } : {}), forwardAuth, dialect: r.dialect.dialect });
  const abort = new AbortController();
  const onClientGone = () => abort.abort();
  if (r.clientGone?.aborted) onClientGone();
  r.clientGone?.addEventListener("abort", onClientGone, { once: true });
  try {
    const res = await deps.fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: abort.signal });
    if (process.env.JEV_ROUTER_DEBUG_SSE)
      console.error(`jev-router forward: ${res.status} content-type=${res.headers.get("content-type")} body=${res.body ? "yes" : "no"}`);
    return { kind: "reply", reply: { status: res.status, ok: res.ok, headers: res.headers, body: res.body } };
  } catch (e) {
    const error = `upstream unreachable: ${e instanceof Error ? e.message : String(e)}`;
    return { kind: "unreachable", error, clientError: error };
  }
}

export type Done = (ok: boolean, usage: TokenUsage | undefined, error?: string) => void;

export interface DeliverOptions {
  readonly source: string;
  /** When set, the client's model id is echoed back in place of the upstream's. Absent for passthrough. */
  readonly requestedModel?: string;
  readonly extraHeaders?: Record<string, string>;
}

/**
 * Some upstreams (chatgpt.com's Codex backend among them) stream without a content-type; the request asked for a
 * stream, so treat the body as one rather than buffering it to the end.
 */
export function isStreamReply(reply: UpstreamReply, requestBody: JsonObject): boolean {
  const contentType = reply.headers.get("content-type") ?? "";
  return contentType.includes("text/event-stream") || (contentType === "" && requestBody.stream === true);
}

async function readText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  return body ? new Response(body).text() : "";
}

async function deliverStream(r: RelayRequest, body: ReadableStream<Uint8Array>, opts: DeliverOptions, done: Done): Promise<void> {
  let usage: TokenUsage | undefined;
  let terminalSeen = false;
  const stream = opts.requestedModel
    ? body.pipeThrough(
        createSseTransform({
          requestedModel: opts.requestedModel,
          onUsage: (u) => {
            usage = mergeUsage(usage, u);
          },
          onTerminal: () => {
            terminalSeen = true;
          },
        }),
      )
    : body;
  r.res.flushHeaders();
  let streamError: string | undefined;
  const clientDisconnected = () => r.clientGone?.aborted === true;
  try {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) r.res.write(chunk);
    r.res.end();
  } catch (e) {
    // A client that hangs up after the terminal event (Codex does) got everything it asked for; only a hang-up
    // before that, or an upstream fault, is a failed delivery.
    if (clientDisconnected() && terminalSeen) r.res.end();
    else {
      streamError = clientDisconnected() ? "client disconnected" : `stream interrupted: ${e instanceof Error ? e.message : String(e)}`;
      r.res.destroy();
    }
  }
  done(streamError === undefined, usage, streamError);
}

/** Send one upstream reply to the client in its own wire format, echoing the requested model, then report via `done`. */
export async function deliver(
  r: RelayRequest,
  target: Target,
  reply: UpstreamReply,
  requestBody: JsonObject,
  opts: DeliverOptions,
  done: Done,
): Promise<void> {
  r.res.statusCode = reply.status;
  copyResponseHeaders(reply, r.res);
  r.res.setHeader("x-jev-router-source", opts.source);
  r.res.setHeader("x-jev-router-egress", target.name);
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) r.res.setHeader(k, v);

  if (!reply.ok || !reply.body) {
    const text = await readText(reply.body);
    r.res.setHeader("content-length", Buffer.byteLength(text));
    r.res.end(text);
    done(false, undefined, `upstream responded ${reply.status}`);
    return;
  }
  if (isStreamReply(reply, requestBody)) {
    await deliverStream(r, reply.body, opts, done);
    return;
  }
  const text = await readText(reply.body);
  let out = text;
  let usage: TokenUsage | undefined;
  try {
    const json = JSON.parse(text) as JsonObject;
    if (typeof json.usage === "object" && json.usage !== null) usage = mergeUsage(undefined, json.usage as Record<string, unknown>);
    if (opts.requestedModel) out = JSON.stringify(r.dialect.echoModel(json, opts.requestedModel));
  } catch {
    /* not JSON: forward verbatim */
  }
  r.res.setHeader("content-length", Buffer.byteLength(out));
  r.res.end(out);
  done(true, usage);
}

/** Wrap a completion callback so a throwing log or store never breaks the response path, and it runs at most once. */
export function onceDone(cb: Done | undefined): Done {
  let called = false;
  return (ok, usage, error) => {
    if (called) return;
    called = true;
    try {
      cb?.(ok, usage, error);
    } catch (e) {
      console.error(`jev-router: onDone callback failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

/** Report a call that never produced a reply and answer the client with a dialect-shaped 502. */
export function failCall(r: RelayRequest, call: Exclude<UpstreamCall, { kind: "reply" }>, done: Done): void {
  done(false, undefined, call.error);
  if (!r.res.headersSent) sendJson(r.res, 502, errorBody(r.dialect.dialect, 502, call.clientError));
}

export interface ForwardOptions extends DeliverOptions {
  readonly onDone?: Done;
}

/** One upstream call, delivered as it arrives. */
export async function forward(deps: UpstreamDeps, r: RelayRequest, target: Target, body: JsonObject, opts: ForwardOptions): Promise<void> {
  const done = onceDone(opts.onDone);
  const call = await callUpstream(deps, r, target, body);
  if (call.kind !== "reply") return failCall(r, call, done);
  await deliver(r, target, call.reply, body, opts, done);
}
