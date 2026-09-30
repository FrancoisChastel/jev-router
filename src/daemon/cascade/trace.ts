import { estimateCostUsd } from "../../core/cost";
import type { Candidate } from "../../core/policy/types";
import type { CascadeAttempt, CascadeRecord, TokenUsage } from "../../core/record";
import type { Decision } from "../../core/types";

/** One attempt's line in the record, priced at the candidate's list price when usage is known. */
export function attemptOf(
  decision: Decision,
  candidate: Candidate | undefined,
  outcome: string,
  extra: { readonly detail?: string; readonly usage?: TokenUsage | undefined } = {},
): CascadeAttempt {
  const usage = extra.usage;
  return {
    candidate: decision.candidate,
    model: decision.model,
    ...(decision.effort ? { effort: decision.effort } : {}),
    outcome,
    ...(extra.detail ? { detail: extra.detail } : {}),
    ...(usage ? { usage } : {}),
    ...(usage && candidate ? { costUsd: estimateCostUsd(candidate, usage.inputTokens, usage.outputTokens) } : {}),
  };
}

const add = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

/** Token usage summed over every attempt that reported some; undefined when none did. */
export function totalUsage(attempts: readonly CascadeAttempt[]): TokenUsage | undefined {
  const reported = attempts.map((a) => a.usage).filter((u): u is TokenUsage => u !== undefined);
  if (reported.length === 0) return undefined;
  return reported.reduce<TokenUsage>(
    (acc, u) => {
      const cacheRead = add(acc.cacheReadTokens, u.cacheReadTokens);
      const cacheWrite = add(acc.cacheWriteTokens, u.cacheWriteTokens);
      const cost = add(acc.costUsd, u.costUsd);
      return {
        inputTokens: acc.inputTokens + u.inputTokens,
        outputTokens: acc.outputTokens + u.outputTokens,
        ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
        ...(cost !== undefined ? { costUsd: cost } : {}),
      };
    },
    { inputTokens: 0, outputTokens: 0 },
  );
}

/** Dollars already spent on attempts that reported usage. */
export const spentUsd = (attempts: readonly CascadeAttempt[]): number => attempts.reduce((n, a) => n + (a.costUsd ?? 0), 0);

/**
 * The `x-jev-router-cascade` header: each hop annotated with why the tier before it failed, as in
 * `fast->mid (empty)` or `fast->mid (empty)->frontier (upstream_error)`. A fallback to an earlier response is noted.
 */
export function cascadeHeader(record: CascadeRecord): string {
  const [first, ...rest] = record.attempts;
  if (!first) return record.served;
  const hops = rest.reduce((acc, attempt, i) => `${acc}->${attempt.candidate} (${record.attempts[i]?.outcome ?? "?"})`, first.candidate);
  const last = record.attempts[record.attempts.length - 1];
  const fellBack = last && last.candidate !== record.served ? `; served ${record.served}` : "";
  const abandoned = record.abandoned ? `; abandoned: ${record.abandoned}` : "";
  return `${hops}${fellBack}${abandoned}`;
}
