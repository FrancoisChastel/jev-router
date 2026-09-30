import { plan } from "../core/decide";
import type { Policy } from "../core/policy/types";
import type { DecisionRecord } from "../core/record";
import { emptySession, withUsage } from "../core/session";
import { type Decision, EFFORT_ORDER, type Effort, type NormalizedRequest, type SessionState } from "../core/types";
import { costOf, recordCostUsd, servedUsage } from "./stats";

export interface ReplayResult {
  readonly id: string;
  readonly session: string;
  readonly turn: number;
  readonly recorded: Decision;
  readonly replayed: Decision;
}

export interface ReplayReport {
  readonly results: readonly ReplayResult[];
  /** Turns where the replayed candidate differs from the served one. */
  readonly changed: number;
  /** Turns that needed the judge but had no recorded answers; they fell open. */
  readonly unjudged: number;
  readonly recordedCostUsd: number;
  readonly replayedCostUsd: number;
}

function requestFrom(r: DecisionRecord): NormalizedRequest {
  const effort = (EFFORT_ORDER as readonly string[]).includes(r.requestedEffort ?? "") ? (r.requestedEffort as Effort) : undefined;
  return {
    harness: r.harness,
    sessionKey: r.session,
    requestedModel: "auto",
    ...(r.requestClass ? { requestClass: r.requestClass } : {}),
    isNewUserTurn: r.isNewUserTurn,
    toolNames: r.toolNames ?? [],
    hasImages: r.hasImages === true,
    estimatedInputTokens: r.estimatedInputTokens,
    ...(effort ? { requestedEffort: effort } : {}),
    ...(r.contextCompacted ? { contextCompacted: true } : {}),
    toolOutcomes: r.toolOutcomes ?? [],
  };
}

/**
 * Re-decide a recorded log under a policy, replaying recorded judge answers instead of calling a judge.
 * Costs assume the same tokens would have flowed through the replayed candidate, which is an approximation.
 */
export function replay(records: readonly DecisionRecord[], policy: Policy, policyId: string): ReplayReport {
  const bySession = new Map<string, DecisionRecord[]>();
  for (const r of records) bySession.set(r.session, [...(bySession.get(r.session) ?? []), r]);

  const results: ReplayResult[] = [];
  let changed = 0;
  let unjudged = 0;
  let recordedCost = 0;
  let replayedCost = 0;

  for (const list of bySession.values()) {
    const ordered = [...list].sort((a, b) => a.turn - b.turn || a.ts - b.ts);
    let session: SessionState = emptySession();
    for (const r of ordered) {
      const outcome = plan({ request: requestFrom(r), session, policy, policyId });
      let decision: Decision;
      if (outcome.kind === "decision") {
        decision = outcome.decision;
        session = outcome.session;
      } else {
        const answers = r.judge?.answers;
        if (!answers) unjudged += 1;
        const c = outcome.conclude(answers ?? null);
        decision = c.decision;
        session = c.session;
      }
      // Feed the recorded usage back so cache-aware switching sees what the live router saw.
      session = withUsage(session, r.usage);
      if (decision.candidate !== r.decision.candidate) changed += 1;
      const answer = servedUsage(r);
      if (r.usage && answer) {
        const now = policy.candidates[decision.candidate];
        recordedCost += recordCostUsd(r, policy);
        // The replayed tier is priced on the answer's own tokens; replay cannot know whether it would have cascaded.
        if (now) replayedCost += costOf(now, answer);
      }
      results.push({ id: r.id, session: r.session, turn: r.turn, recorded: r.decision, replayed: decision });
    }
  }
  return { results, changed, unjudged, recordedCostUsd: recordedCost, replayedCostUsd: replayedCost };
}
