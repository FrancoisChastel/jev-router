import type { JudgeMode } from "./policy/types";
import { executionPhaseQuestions, taskPhaseQuestions } from "./questions";

/**
 * Identifiers the decision engine provides to rule expressions. Compaction is a built-in override, not a rule input.
 * `plan_5h` and `plan_7d` exist only once a subscription egress has reported its usage windows; until then they are
 * unknown and rules that read them never fire.
 */
export const DETERMINISTIC_KEYS = [
  "harness",
  "request_class",
  "has_images",
  "is_new_user_turn",
  "est_tokens",
  "consecutive_failures",
  "requested_effort",
  "signal.score",
  "signal.severity",
  "signal.spinning",
  "signal.exploring",
  "signal.production",
  "plan_5h",
  "plan_7d",
] as const;

/** Every identifier a rule may reference for the given judge mode, including `<id>.confidence` for choice and score answers. */
export function knownIdentifiers(mode: JudgeMode): ReadonlySet<string> {
  const out = new Set<string>(DETERMINISTIC_KEYS);
  const questions =
    mode === "option_pick" ? { pick: { type: "choice" as const } } : { ...taskPhaseQuestions(), ...executionPhaseQuestions() };
  for (const [id, q] of Object.entries(questions)) {
    out.add(id);
    if (q.type !== "noul") out.add(`${id}.confidence`);
  }
  return out;
}
