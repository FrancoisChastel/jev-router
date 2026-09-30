import { isCapable, resolveEffort } from "./decide";
import { getPolicyDef } from "./policy";
import type { Candidate, Policy } from "./policy/types";
import type { Decision, Effort, NormalizedRequest, SessionState } from "./types";

/**
 * The decision one tier above `from` on the policy's ladder, among the candidates able to serve this request.
 * Undefined when `from` is already the most capable eligible tier. The effort the client asked for (or the one
 * `from` ran at) is clamped to the new candidate, exactly as a routed decision would be. Pure.
 */
export function nextTier(policy: Policy, policyId: string, request: NormalizedRequest, from: Decision): Decision | undefined {
  const order = getPolicyDef(policy, policyId).order;
  const eligible = order.filter((id) => isCapable(policy.candidates[id] as Candidate, request));
  const fromRank = order.indexOf(from.candidate);
  const nextId = eligible.find((id) => order.indexOf(id) > fromRank);
  if (nextId === undefined) return undefined;
  const candidate = policy.candidates[nextId] as Candidate;
  const { effort, clamped } = resolveEffort(candidate, from.effort ?? request.requestedEffort);
  const { via: _via, effort: _effort, ...rest } = from;
  return {
    ...rest,
    candidate: nextId,
    model: candidate.model,
    ...(candidate.via ? { via: candidate.via } : {}),
    ...(effort ? { effort } : {}),
    reasons: [...from.reasons, "cascade", ...(clamped ? ["effort_clamped"] : [])],
  };
}

/**
 * The session after a cascade: the tier that finally served becomes the current assignment, keeping the lease and
 * start turn the decision set, so the next turn continues there under the usual hold and lease rules. Pure.
 */
export function reassignServed(session: SessionState, candidate: string, effort: Effort | undefined): SessionState {
  const current = session.current;
  if (!current || (current.candidate === candidate && current.effort === effort)) return session;
  const { effort: _prev, ...base } = current;
  return { ...session, current: { ...base, candidate, ...(effort ? { effort } : {}) } };
}
