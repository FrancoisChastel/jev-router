import { describe, expect, test } from "bun:test";
import { plan } from "../../src/core/decide";
import { loadPolicy } from "../../src/core/policy";
import { emptySession } from "../../src/core/session";
import type { NormalizedRequest, SessionState, ToolOutcome } from "../../src/core/types";
import type { Answer } from "../../src/judge/types";
import { minimalPolicy } from "../fixtures/policies";

const ok = (name: string): ToolOutcome => ({ name, isError: false });
const err = (name: string, errorText = "boom"): ToolOutcome => ({ name, isError: true, errorText });

function req(over: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    harness: "claude-code",
    sessionKey: "s1",
    requestedModel: "auto",
    isNewUserTurn: true,
    lastUserText: "refactor the payment module and add tests",
    toolNames: ["Read", "Edit", "Bash"],
    hasImages: false,
    estimatedInputTokens: 8000,
    toolOutcomes: [],
    ...over,
  };
}

const score = (s: number, confidence = 0.9): Answer => ({ type: "score", score: s, probabilities: {}, confidence });
const noul = (p: number): Answer => ({ type: "noul", noul: p });
const choice = (c: string, confidence = 0.9): Answer => ({ type: "choice", choice: c, probabilities: { [c]: 0.9 }, confidence });

const policy = loadPolicy(minimalPolicy());

describe("plan: deterministic paths", () => {
  test("fresh session on a new user turn asks task-phase questions only", () => {
    const out = plan({ request: req(), session: emptySession(), policy, policyId: "default" });
    expect(out.kind).toBe("judge");
    if (out.kind !== "judge") return;
    const ids = Object.keys(out.judgeRequest.questions).sort();
    expect(ids).toEqual(["difficulty", "long_context", "needs_reasoning", "output_kind", "stakes"]);
    expect(out.judgeRequest.sessionId).toBe("s1");
  });

  test("auxiliary request class is pinned by rules without a judge call", () => {
    const out = plan({ request: req({ requestClass: "auxiliary" }), session: emptySession(), policy, policyId: "default" });
    expect(out.kind).toBe("decision");
    if (out.kind !== "decision") return;
    expect(out.decision.candidate).toBe("fast");
    expect(out.decision.source).toBe("rules");
    expect(out.decision.model).toBe("openai/gpt-5.4-mini");
  });

  test("tool continuation reuses an active lease", () => {
    const session: SessionState = { ...emptySession(), turn: 3, current: { candidate: "mid", lease: "tool_chain", sinceTurn: 2 } };
    const out = plan({ request: req({ isNewUserTurn: false, toolOutcomes: [ok("Edit")] }), session, policy, policyId: "default" });
    expect(out.kind).toBe("decision");
    if (out.kind !== "decision") return;
    expect(out.decision.candidate).toBe("mid");
    expect(out.decision.source).toBe("lease");
    expect(out.session.turn).toBe(4);
  });

  test("three consecutive all-failure batches escalate one tier and set a hold", () => {
    const session: SessionState = {
      ...emptySession(),
      turn: 5,
      consecutiveFailures: 2,
      current: { candidate: "fast", lease: "one_call", sinceTurn: 0 },
    };
    const out = plan({ request: req({ isNewUserTurn: false, toolOutcomes: [err("Bash")] }), session, policy, policyId: "default" });
    expect(out.kind).toBe("decision");
    if (out.kind !== "decision") return;
    expect(out.decision.candidate).toBe("mid");
    expect(out.decision.source).toBe("override");
    expect(out.session.holdUntilTurn).toBe(6 + 2);
    expect(out.session.consecutiveFailures).toBe(3);
  });

  test("post-compaction request escalates with a hold", () => {
    const session: SessionState = { ...emptySession(), turn: 9, current: { candidate: "fast", lease: "one_call", sinceTurn: 0 } };
    const out = plan({ request: req({ isNewUserTurn: false, contextCompacted: true }), session, policy, policyId: "default" });
    expect(out.kind).toBe("decision");
    if (out.kind !== "decision") return;
    expect(out.decision.candidate).toBe("mid");
    expect(out.decision.source).toBe("override");
    expect(out.decision.reasons).toContain("context_compacted");
  });

  test("an active hold blocks de-escalation", () => {
    const session: SessionState = {
      ...emptySession(),
      turn: 3,
      holdUntilTurn: 5,
      current: { candidate: "mid", lease: "one_call", sinceTurn: 1 },
      ledger: [
        [ok("Edit"), ok("Edit")],
        [ok("Write"), ok("Edit")],
      ],
    };
    const out = plan({
      request: req({ isNewUserTurn: false, toolOutcomes: [ok("Edit"), ok("Edit")] }),
      session,
      policy,
      policyId: "default",
    });
    expect(out.kind).toBe("decision");
    if (out.kind !== "decision") return;
    expect(out.decision.candidate).toBe("mid");
    expect(out.decision.source).toBe("hold");
  });

  test("corroborated recovery signals escalate one tier without a judge", () => {
    const failing = err("Bash", "tests failed: 3 errors");
    const session: SessionState = {
      ...emptySession(),
      turn: 6,
      current: { candidate: "fast", lease: "one_call", sinceTurn: 1 },
      ledger: [[failing], [failing]],
    };
    const out = plan({ request: req({ isNewUserTurn: false, toolOutcomes: [failing, ok("Read")] }), session, policy, policyId: "default" });
    expect(out.kind).toBe("decision");
    if (out.kind !== "decision") return;
    expect(out.decision.candidate).toBe("mid");
    expect(out.decision.source).toBe("signals");
  });

  test("steady production alone stays in the ambiguous band and asks the judge", () => {
    const prod = [ok("Edit"), ok("Write"), ok("Edit")];
    const session: SessionState = {
      ...emptySession(),
      turn: 6,
      current: { candidate: "mid", lease: "one_call", sinceTurn: 1 },
      ledger: [prod, prod, prod],
    };
    const out = plan({ request: req({ isNewUserTurn: false, toolOutcomes: prod }), session, policy, policyId: "default" });
    expect(out.kind).toBe("judge");
  });

  test("ambiguous tool continuation asks execution-phase questions only", () => {
    const mixed = [err("Bash"), ok("Read")];
    const session: SessionState = {
      ...emptySession(),
      turn: 4,
      current: { candidate: "fast", lease: "one_call", sinceTurn: 0 },
      ledger: [mixed],
    };
    const out = plan({
      request: req({ isNewUserTurn: false, toolOutcomes: [ok("Read"), ok("Grep")] }),
      session,
      policy,
      policyId: "default",
    });
    expect(out.kind).toBe("judge");
    if (out.kind !== "judge") return;
    expect(Object.keys(out.judgeRequest.questions).sort()).toEqual(["producing", "spinning", "tools_failed"]);
  });

  test("capability filter excludes candidates that cannot serve the request", () => {
    const raw = minimalPolicy();
    raw.candidates.fast.capabilities = { vision: false };
    const p = loadPolicy(raw);
    const out = plan({
      request: req({ requestClass: "auxiliary", hasImages: true }),
      session: emptySession(),
      policy: p,
      policyId: "default",
    });
    expect(out.kind).toBe("decision");
    if (out.kind !== "decision") return;
    expect(out.decision.candidate).toBe("mid");
    expect(out.decision.reasons).toContain("capability_filter");
  });

  test("never mutates the input session", () => {
    const session = emptySession();
    const snapshot = JSON.stringify(session);
    plan({ request: req({ requestClass: "auxiliary" }), session, policy, policyId: "default" });
    expect(JSON.stringify(session)).toBe(snapshot);
  });
});

describe("conclude: judge-driven paths", () => {
  function judged(request: NormalizedRequest, session: SessionState, answers: Record<string, Answer> | null, p = policy) {
    const out = plan({ request, session, policy: p, policyId: "default" });
    if (out.kind !== "judge") throw new Error("expected judge");
    return out.conclude(answers);
  }

  test("difficult task lands on the mid tier with counterfactuals for every candidate", () => {
    const { decision, session } = judged(req(), emptySession(), {
      difficulty: score(2.6),
      needs_reasoning: noul(0.3),
      stakes: score(1),
      output_kind: choice("code_edit"),
      long_context: noul(0.1),
    });
    expect(decision.candidate).toBe("mid");
    expect(decision.source).toBe("judge");
    expect(Object.keys(decision.counterfactuals).sort()).toEqual(["fast", "frontier", "mid"]);
    expect(decision.counterfactuals.frontier!.estCostUsd).toBeGreaterThan(decision.counterfactuals.fast!.estCostUsd);
    expect(session.current?.candidate).toBe("mid");
    expect(session.turn).toBe(1);
  });

  test("high stakes plus high difficulty reaches frontier with the rule's effort", () => {
    const { decision } = judged(req(), emptySession(), {
      difficulty: score(3.4),
      needs_reasoning: noul(0.9),
      stakes: score(2.5),
      output_kind: choice("code_edit"),
      long_context: noul(0.2),
    });
    expect(decision.candidate).toBe("frontier");
    expect(decision.effort).toBe("high");
  });

  test("low judge confidence keeps the current tier", () => {
    const { decision } = judged(req(), emptySession(), {
      difficulty: score(3.4, 0.3),
      needs_reasoning: noul(0.9),
      stakes: score(2.5, 0.2),
      output_kind: choice("code_edit"),
      long_context: noul(0.2),
    });
    expect(decision.candidate).toBe("fast");
    expect(decision.reasons).toContain("low_confidence");
  });

  test("judge failure falls open to the current tier", () => {
    const { decision } = judged(req(), emptySession(), null);
    expect(decision.candidate).toBe("fast");
    expect(decision.source).toBe("fallback");
  });

  test("an empty answer set counts as no judge", () => {
    const { decision } = judged(req(), emptySession(), {});
    expect(decision.source).toBe("fallback");
    expect(decision.reasons).toContain("judge_empty");
  });

  test("a non-finite confidence fails closed to the current tier", () => {
    const { decision } = judged(req(), emptySession(), {
      difficulty: { type: "score", score: 3.4, probabilities: {}, confidence: Number.NaN },
      needs_reasoning: noul(0.9),
      stakes: score(2.5),
      output_kind: choice("code_edit"),
      long_context: noul(0.2),
    });
    expect(decision.candidate).toBe("fast");
    expect(decision.reasons).toContain("low_confidence");
  });

  test("fail_closed routes an unjudged turn to the most capable candidate", () => {
    const raw = minimalPolicy();
    raw.judge.on_error = "fail_closed";
    const { decision } = judged(req(), emptySession(), null, loadPolicy(raw));
    expect(decision.candidate).toBe("frontier");
    expect(decision.source).toBe("fallback");
    expect(decision.reasons).toEqual(expect.arrayContaining(["judge_unavailable", "fail_closed"]));
  });

  test("counterfactuals cover every candidate, including filtered ones", () => {
    const raw = minimalPolicy();
    raw.candidates.fast.capabilities = { vision: false };
    const { decision } = judged(
      req({ hasImages: true }),
      emptySession(),
      {
        difficulty: score(1),
        needs_reasoning: noul(0.1),
        stakes: score(1),
        output_kind: choice("short_answer"),
        long_context: noul(0.1),
      },
      loadPolicy(raw),
    );
    expect(decision.candidate).toBe("mid");
    expect(Object.keys(decision.counterfactuals).sort()).toEqual(["fast", "frontier", "mid"]);
  });

  test("requested effort is clamped to what the candidate supports", () => {
    const { decision } = judged(req({ requestedEffort: "xhigh" }), emptySession(), {
      difficulty: score(2.6),
      needs_reasoning: noul(0.3),
      stakes: score(1),
      output_kind: choice("code_edit"),
      long_context: noul(0.1),
    });
    expect(decision.candidate).toBe("mid");
    expect(decision.effort).toBe("high");
  });

  test("prefer_effort_over_model raises effort instead of switching", () => {
    const raw = minimalPolicy();
    raw.policies.default.switch = { prefer_effort_over_model: true };
    const p = loadPolicy(raw);
    const session: SessionState = {
      ...emptySession(),
      turn: 2,
      current: { candidate: "mid", effort: "low", lease: "one_call", sinceTurn: 0 },
    };
    const { decision } = judged(
      req({ harness: "codex" }),
      session,
      {
        difficulty: score(3.4),
        needs_reasoning: noul(0.9),
        stakes: score(2.5),
        output_kind: choice("code_edit"),
        long_context: noul(0.2),
      },
      p,
    );
    expect(decision.candidate).toBe("mid");
    expect(decision.effort).toBe("high");
    expect(decision.reasons).toContain("effort_over_model");
  });

  test("execution-phase answers with allow_down de-escalate a producing agent", () => {
    const prod = [ok("Edit"), ok("Write"), ok("Edit")];
    const session: SessionState = {
      ...emptySession(),
      turn: 6,
      current: { candidate: "mid", lease: "one_call", sinceTurn: 1 },
      ledger: [prod, prod, prod],
    };
    const { decision } = judged(req({ isNewUserTurn: false, toolOutcomes: prod }), session, {
      tools_failed: noul(0.05),
      spinning: noul(0.1),
      producing: noul(0.9),
    });
    expect(decision.candidate).toBe("fast");
    expect(decision.source).toBe("judge");
  });

  test("execution-phase answers escalate on failures", () => {
    const mixed = [err("Bash"), ok("Read")];
    const session: SessionState = {
      ...emptySession(),
      turn: 4,
      current: { candidate: "fast", lease: "one_call", sinceTurn: 0 },
      ledger: [mixed],
    };
    const { decision } = judged(req({ isNewUserTurn: false, toolOutcomes: [ok("Read")] }), session, {
      tools_failed: noul(0.85),
      spinning: noul(0.2),
      producing: noul(0.1),
    });
    expect(decision.candidate).toBe("mid");
    expect(decision.source).toBe("judge");
  });
});
