import type { Candidate, Cascade } from "../../core/policy/types";
import type { CascadeAttempt } from "../../core/record";
import type { Decision } from "../../core/types";
import type { Dialect, JsonObject } from "../dialects/types";
import { isStreamReply, type UpstreamCall, type UpstreamReply } from "../forward";
import { assessResponse, isRetryableStatus } from "./assess";
import { usageFromBody } from "./body";
import { bufferBody } from "./buffer";
import { attemptOf } from "./trace";

/** What to do with one attempt's upstream call. */
export type Settled =
  /** Send this reply to the client now. `abandoned` names the buffer cap that stopped the cascade, if one did. */
  | { readonly kind: "deliver"; readonly reply: UpstreamReply; readonly abandoned?: "buffer_max_bytes" | "buffer_max_ms" }
  /** The attempt failed in a way the policy retries. `held` is its response, kept in case nothing better arrives. */
  | { readonly kind: "retry"; readonly attempt: CascadeAttempt; readonly held?: UpstreamReply }
  /** No response at all and no trigger for it: report the call's own failure. */
  | { readonly kind: "fail"; readonly call: Exclude<UpstreamCall, { kind: "reply" }> };

export interface SettleInput {
  readonly config: Cascade;
  readonly dialect: Dialect;
  readonly decision: Decision;
  readonly candidate: Candidate | undefined;
  readonly requestBody: JsonObject;
  readonly call: UpstreamCall;
}

const decoder = new TextDecoder();

function settleUnbuffered(input: SettleInput, reply: UpstreamReply): Settled | undefined {
  const { config, decision, candidate } = input;
  if (reply.ok && reply.body && !config.buffer) return { kind: "deliver", reply };
  if (reply.body) return undefined;
  if (!reply.ok && config.on.includes("upstream_error") && isRetryableStatus(reply.status))
    return { kind: "retry", attempt: attemptOf(decision, candidate, "upstream_error", { detail: `HTTP ${reply.status}` }), held: reply };
  return { kind: "deliver", reply };
}

/**
 * Settle one attempt: deliver it, or retry the next tier with this response held back. Buffers the body under the
 * policy's caps before assessing it; a cap that is hit hands the buffered bytes and the live rest to the client.
 */
export async function settleAttempt(input: SettleInput): Promise<Settled> {
  const { config, decision, candidate, call } = input;
  if (call.kind !== "reply") {
    return config.on.includes("upstream_error")
      ? { kind: "retry", attempt: attemptOf(decision, candidate, "upstream_error", { detail: call.error }) }
      : { kind: "fail", call };
  }
  const early = settleUnbuffered(input, call.reply);
  if (early) return early;
  const buffered = await bufferBody(call.reply.body as ReadableStream<Uint8Array>, {
    maxBytes: config.buffer_max_bytes,
    maxMs: config.buffer_max_ms,
  });
  const held: UpstreamReply = { ...call.reply, body: buffered.replay };
  if (buffered.kind === "overflow") return { kind: "deliver", reply: held, abandoned: buffered.reason };
  if (buffered.kind === "failed") {
    return config.on.includes("upstream_error")
      ? {
          kind: "retry",
          attempt: attemptOf(decision, candidate, "upstream_error", { detail: `stream interrupted: ${buffered.error}` }),
          held,
        }
      : { kind: "deliver", reply: held };
  }
  const isStream = isStreamReply(call.reply, input.requestBody);
  const text = decoder.decode(buffered.bytes);
  const contentType = isStream ? "text/event-stream" : (call.reply.headers.get("content-type") ?? "");
  const verdict = assessResponse({ dialect: input.dialect, status: call.reply.status, contentType, body: text, on: config.on });
  if (verdict.ok) return { kind: "deliver", reply: held };
  const usage = call.reply.ok ? usageFromBody(isStream, text) : undefined;
  return { kind: "retry", attempt: attemptOf(decision, candidate, verdict.trigger, { detail: verdict.detail, usage }), held };
}
