import type { Question } from "../judge/types";
import type { Candidate } from "./policy/types";

/** Asked on each new user turn against the task dossier. */
export function taskPhaseQuestions(): Readonly<Record<string, Question>> {
  return {
    difficulty: {
      type: "score",
      instructions: "How hard is this request for a coding agent to complete correctly?",
      criteria: [
        "Trivial: an acknowledgement, a lookup, or a one-line answer",
        "Routine: a bounded edit or task with an obvious approach",
        "Substantial: multi-file changes or debugging that need judgment",
        "Deep: architecture, tricky debugging, design, or research with unclear path",
      ],
    },
    needs_reasoning: {
      type: "noul",
      instructions: "Does getting this right require extended step-by-step reasoning rather than pattern matching?",
    },
    stakes: {
      type: "score",
      instructions: "How costly is a wrong or sloppy answer here?",
      criteria: [
        "Cosmetic: easily noticed and undone",
        "Rework: wastes time but nothing breaks",
        "Breaks things: builds, tests, data, or user-facing behavior",
        "Critical: security, auth, payments, migrations, or irreversible actions",
      ],
    },
    output_kind: {
      type: "choice",
      instructions: "What kind of output does the user expect?",
      criteria: {
        short_answer: "A brief textual answer or confirmation",
        code_edit: "Changes to existing code",
        long_generation: "A large new artifact such as a module, document, or test suite",
        plan: "An analysis, design, or plan rather than code",
        tool_plan: "A sequence of tool actions such as running commands or inspecting files",
      },
    },
    long_context: { type: "noul", instructions: "Does the task require reading or holding a large amount of context to do well?" },
  };
}

/** Asked only when the deterministic tool-signal score is ambiguous, against the recent tool digest. */
export function executionPhaseQuestions(): Readonly<Record<string, Question>> {
  return {
    tools_failed: { type: "noul", instructions: "Did the most recent tool calls fail or produce errors that block progress?" },
    spinning: { type: "noul", instructions: "Is the agent repeating the same actions without making progress?" },
    producing: { type: "noul", instructions: "Is the agent now writing or editing files rather than exploring or planning?" },
  };
}

/** Option-pick mode: one choice over candidate ids with user-authored descriptions. */
export function optionPickQuestion(
  candidates: Readonly<Record<string, Candidate>>,
  order: readonly string[],
): Readonly<Record<string, Question>> {
  const criteria: Record<string, string> = {};
  for (const id of order) criteria[id] = candidates[id]?.description ?? candidates[id]?.model ?? id;
  return {
    pick: { type: "choice", instructions: "Which candidate is the least expensive one that can complete this request well?", criteria },
  };
}
