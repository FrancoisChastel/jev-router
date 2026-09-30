import { estimateCostUsd } from "../../core/cost";
import { nextTier } from "../../core/escalate";
import { getPolicyDef } from "../../core/policy";
import type { Cascade, Policy } from "../../core/policy/types";
import type { CascadeAttempt, CascadeRecord, TokenUsage } from "../../core/record";
import type { Decision } from "../../core/types";
import type { JsonObject } from "../dialects/types";
import {
  callUpstream,
  deliver,
  egressFor,
  failCall,
  onceDone,
  type Target,
  type UpstreamCall,
  type UpstreamDeps,
  type UpstreamReply,
} from "../forward";
import type { RelayRequest } from "../relay";
import type { Decided } from "../service";
import { settleAttempt } from "./settle";
import { attemptOf, cascadeHeader, spentUsd, totalUsage } from "./trace";

export interface CascadeRun {
  readonly deps: UpstreamDeps & { readonly policy: Policy };
  readonly r: RelayRequest;
  /** The client's request body, before any model rewrite. */
  readonly body: JsonObject;
  readonly requestedModel: string;
  readonly policyId: string;
  readonly config: Cascade;
  readonly decided: Decided;
  /** Headers every response carries regardless of which tier serves. */
  readonly routingHeaders: (served: Decision) => Record<string, string>;
}

/** The response kept from a failed attempt, delivered if every later attempt does worse. */
interface Held {
  readonly decision: Decision;
  readonly target: Target;
  readonly reply: UpstreamReply;
}

interface Progress {
  readonly attempts: readonly CascadeAttempt[];
  readonly held?: Held;
}

/**
 * Cascade within one turn: try the routed tier, and while its response looks like a failed attempt and the caps allow,
 * re-run the same request one tier up before the client sees anything. The last attempt streams straight through.
 */
export async function runCascade(run: CascadeRun): Promise<void> {
  const { policy } = run.deps;
  let decision = run.decided.decision;
  let progress: Progress = { attempts: [] };
  for (let retry = 0; ; retry += 1) {
    const candidate = policy.candidates[decision.candidate];
    const target = egressFor(policy, candidate);
    if (!target) {
      const error = "no egress configured for the selected candidate";
      return progress.held ? fallBack(run, progress) : giveUp(run, progress, { kind: "no_key", error, clientError: error });
    }
    const next = retry < run.config.max_retries ? nextTier(policy, run.policyId, run.decided.request, decision) : undefined;
    const rewritten = run.r.dialect.rewrite(run.body, decision);
    const call = await callUpstream(run.deps, run.r, target, rewritten);
    if (!next) return finalAttempt(run, progress, decision, target, call);

    const settled = await settleAttempt({
      config: run.config,
      dialect: run.r.dialect.dialect,
      decision,
      candidate,
      requestBody: rewritten,
      call,
    });
    if (settled.kind === "deliver") return serve(run, progress, { decision, target, reply: settled.reply }, settled.abandoned);
    if (settled.kind === "fail") return giveUp(run, progress, settled.call);
    progress = {
      attempts: [...progress.attempts, settled.attempt],
      ...(settled.held ? { held: { decision, target, reply: settled.held } } : progress.held ? { held: progress.held } : {}),
    };
    if (run.r.clientGone?.aborted) {
      // Nothing reaches a departed client, but the attempts already made were billed and belong in the record.
      return commit(run, progress, recordOf(progress.attempts, decision.candidate), { ok: false, error: "client disconnected" });
    }
    if (overBudget(run, progress.attempts, next)) return fallBack(run, progress, "budget_usd");
    decision = next;
  }
}

function overBudget(run: CascadeRun, attempts: readonly CascadeAttempt[], next: Decision): boolean {
  const budget = run.config.budget_usd;
  const candidate = run.deps.policy.candidates[next.candidate];
  if (budget === undefined || !candidate) return false;
  const def = getPolicyDef(run.deps.policy, run.policyId);
  const estimate = estimateCostUsd(candidate, run.decided.request.estimatedInputTokens, def.est_output_tokens);
  return spentUsd(attempts) + estimate > budget;
}

/** The last tier this request may use: its response goes to the client as it arrives, whatever it says. */
async function finalAttempt(run: CascadeRun, progress: Progress, decision: Decision, target: Target, call: UpstreamCall): Promise<void> {
  if (call.kind === "reply") return serve(run, progress, { decision, target, reply: call.reply });
  if (progress.attempts.length === 0) return giveUp(run, progress, call);
  const failed = attemptOf(decision, run.deps.policy.candidates[decision.candidate], "unreachable", { detail: call.error });
  const next = { ...progress, attempts: [...progress.attempts, failed] };
  return next.held ? fallBack(run, next) : giveUp(run, next, call);
}

/** Deliver the response held from an earlier attempt, because nothing better is coming. */
async function fallBack(run: CascadeRun, progress: Progress, abandoned?: string): Promise<void> {
  const held = progress.held;
  if (!held) {
    const error = "cascade stopped with no response to deliver";
    return giveUp(run, progress, { kind: "unreachable", error, clientError: error }, abandoned);
  }
  const record = recordOf(progress.attempts, held.decision.candidate, abandoned);
  const done = onceDone((ok, _usage, error) =>
    commit(run, progress, record, ok ? { ok: true } : { ok: false, ...(error ? { error } : {}) }),
  );
  await deliver(run.r, held.target, held.reply, run.body, deliverOptions(run, held.decision, record), done);
}

/** Deliver a fresh response; its usage is recorded as the served attempt. */
async function serve(run: CascadeRun, progress: Progress, served: Held, abandoned?: string): Promise<void> {
  if (abandoned) {
    console.error(
      `jev-router: cascade abandoned on '${served.decision.candidate}' for session ${run.decided.request.sessionKey}: ${abandoned} (${abandoned === "buffer_max_bytes" ? `${run.config.buffer_max_bytes} bytes` : `${run.config.buffer_max_ms} ms`}) reached; flushing the response as received`,
    );
  }
  const preview = progress.attempts.length > 0 || abandoned ? recordOf(progress.attempts, served.decision.candidate, abandoned) : undefined;
  const candidate = run.deps.policy.candidates[served.decision.candidate];
  const done = onceDone((ok, usage, error) => {
    const attempt = attemptOf(served.decision, candidate, "served", { usage });
    const record = preview ? recordOf([...progress.attempts, attempt], served.decision.candidate, abandoned) : undefined;
    const apply = ok ? { ok: true } : { ok: false, ...(error ? { error } : {}) };
    if (record) commit(run, { attempts: record.attempts }, record, apply);
    else run.decided.commit(apply, usage);
  });
  const withServed = preview ? { ...preview, attempts: [...preview.attempts, attemptOf(served.decision, candidate, "served")] } : undefined;
  await deliver(run.r, served.target, served.reply, run.body, deliverOptions(run, served.decision, withServed), done);
}

function giveUp(run: CascadeRun, progress: Progress, call: Exclude<UpstreamCall, { kind: "reply" }>, abandoned?: string): void {
  const record = progress.attempts.length > 0 ? recordOf(progress.attempts, run.decided.decision.candidate, abandoned) : undefined;
  failCall(
    run.r,
    call,
    onceDone((_ok, _usage, error) => commit(run, progress, record, { ok: false, ...(error ? { error } : {}) })),
  );
}

function recordOf(attempts: readonly CascadeAttempt[], served: string, abandoned?: string): CascadeRecord {
  return { attempts, served, ...(abandoned ? { abandoned } : {}) };
}

function commit(run: CascadeRun, progress: Progress, record: CascadeRecord | undefined, apply: { ok: boolean; error?: string }): void {
  const usage: TokenUsage | undefined = totalUsage(progress.attempts);
  run.decided.commit(apply, usage, undefined, record);
}

function deliverOptions(run: CascadeRun, served: Decision, record: CascadeRecord | undefined) {
  return {
    source: run.decided.decision.source,
    requestedModel: run.requestedModel,
    extraHeaders: { ...run.routingHeaders(served), ...(record ? { "x-jev-router-cascade": cascadeHeader(record) } : {}) },
  };
}
