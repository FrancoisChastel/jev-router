import { describe, expect, test } from "bun:test";
import { type Concluded, plan } from "../../src/core/decide";
import { loadPolicy } from "../../src/core/policy";
import type { Policy } from "../../src/core/policy/types";
import { emptySession } from "../../src/core/session";
import type { Effort, LastUsage, NormalizedRequest, SessionState, ToolOutcome } from "../../src/core/types";
import type { Answer } from "../../src/judge/types";
import { minimalPolicy, type TestPolicy } from "../fixtures/policies";

const ok = (name: string): ToolOutcome => ({ name, isError: false });
const err = (name: string, errorText = "boom"): ToolOutcome => ({ name, isError: true, errorText });
const score = (s: number, confidence = 0.9): Answer => ({ type: "score", score: s, probabilities: {}, confidence });
const noul = (p: number): Answer => ({ type: "noul", noul: p });
const choice = (c: string, confidence = 0.9): Answer => ({ type: "choice", choice: c, probabilities: { [c]: 0.9 }, confidence });

function req(over: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    harness: "codex",
    sessionKey: "s1",
    requestedModel: "auto",
    isNewUserTurn: true,
    lastUserText: "fix the flaky test",
    toolNames: ["Read", "Edit", "Bash"],
    hasImages: false,
    estimatedInputTokens: 8000,
    toolOutcomes: [],
    ...over,
  };
}

function withSwitch(tweak: (raw: TestPolicy) => void = () => {}): Policy {
  const raw = minimalPolicy();
  tweak(raw);
  return loadPolicy(raw);
}

function judged(p: Policy, request: NormalizedRequest, session: SessionState, answers: Record<string, Answer>): Concluded {
  const out = plan({ request, session, policy: p, policyId: "default" });
  if (out.kind !== "judge") throw new Error(`expected judge, got ${out.decision.source}`);
  return out.conclude(answers);
}

/** An ambiguous continuation on `candidate` whose execution answers trigger the `up: 1` rule. */
const mixed = [err("Bash"), ok("Read")];
function continuation(candidate: string, effort?: Effort, over: Partial<SessionState> = {}): SessionState {
  return {
    ...emptySession(),
    turn: 4,
    current: { candidate, ...(effort ? { effort } : {}), lease: "one_call", sinceTurn: 0 },
    ledger: [mixed],
    ...over,
  };
}
const failingAnswers = { tools_failed: noul(0.85), spinning: noul(0.2), producing: noul(0.1) };
const hardHighStakes = {
  difficulty: score(3.4),
  needs_reasoning: noul(0.9),
  stakes: score(2.5),
  output_kind: choice("code_edit"),
  long_context: noul(0.2),
};
const easy = {
  difficulty: score(0.5),
  needs_reasoning: noul(0.1),
  stakes: score(0.5),
  output_kind: choice("short_answer"),
  long_context: noul(0.1),
};

const policyOff = withSwitch((raw) => {
  raw.policies.default.switch = { prefer_effort_over_model: false, cache_penalty: false };
});

describe("effort first, model second", () => {
  const effortFirst = withSwitch((raw) => {
    raw.policies.default.switch = { prefer_effort_over_model: true };
  });

  test("an up action steps effort through the current model's levels and switches only at the top", () => {
    const steps: [Effort, string, Effort | undefined][] = [
      ["low", "mid", "medium"],
      ["medium", "mid", "high"],
      ["high", "frontier", undefined],
    ];
    for (const [inUse, candidate, effort] of steps) {
      const { decision } = judged(
        effortFirst,
        req({ isNewUserTurn: false, toolOutcomes: [ok("Read")] }),
        continuation("mid", inUse),
        failingAnswers,
      );
      expect(decision.candidate).toBe(candidate);
      if (effort) {
        expect(decision.effort).toBe(effort);
        expect(decision.reasons).toContain("effort_first");
      } else {
        expect(decision.reasons).not.toContain("effort_first");
      }
    }
  });

  test("the chosen session state carries the raised effort into the next decision", () => {
    const { session } = judged(
      effortFirst,
      req({ isNewUserTurn: false, toolOutcomes: [ok("Read")] }),
      continuation("mid", "low"),
      failingAnswers,
    );
    expect(session.current).toMatchObject({ candidate: "mid", effort: "medium" });
  });

  test("without an effort in use it starts from the requested effort", () => {
    const { decision } = judged(
      effortFirst,
      req({ isNewUserTurn: false, toolOutcomes: [ok("Read")], requestedEffort: "low" }),
      continuation("mid"),
      failingAnswers,
    );
    expect(decision.candidate).toBe("mid");
    expect(decision.effort).toBe("medium");
  });

  test("a candidate without effort levels switches model", () => {
    const { decision } = judged(
      effortFirst,
      req({ isNewUserTurn: false, toolOutcomes: [ok("Read")] }),
      continuation("fast"),
      failingAnswers,
    );
    expect(decision.candidate).toBe("mid");
    expect(decision.reasons).not.toContain("effort_first");
  });

  test("an at_least from a stakes rule still switches model", () => {
    const session: SessionState = {
      ...emptySession(),
      turn: 2,
      current: { candidate: "mid", effort: "low", lease: "one_call", sinceTurn: 0 },
    };
    const { decision } = judged(effortFirst, req(), session, hardHighStakes);
    expect(decision.candidate).toBe("frontier");
    expect(decision.effort).toBe("high");
    expect(decision.reasons).not.toContain("effort_first");
  });

  test("decisive tool signals raise effort before switching", () => {
    const failing = err("Bash", "tests failed: 3 errors");
    const session = continuation("mid", "low", { turn: 6, ledger: [[failing], [failing]] });
    const out = plan({
      request: req({ isNewUserTurn: false, toolOutcomes: [failing, ok("Read")] }),
      session,
      policy: effortFirst,
      policyId: "default",
    });
    if (out.kind !== "decision") throw new Error("expected decision");
    expect(out.decision.source).toBe("signals");
    expect(out.decision.candidate).toBe("mid");
    expect(out.decision.effort).toBe("medium");
    expect(out.decision.reasons).toEqual(["signals_capable", "effort_first"]);
  });

  test("hard overrides switch model immediately", () => {
    const session = continuation("mid", "low", { turn: 5, consecutiveFailures: 2 });
    const out = plan({
      request: req({ isNewUserTurn: false, toolOutcomes: [err("Bash")] }),
      session,
      policy: effortFirst,
      policyId: "default",
    });
    if (out.kind !== "decision") throw new Error("expected decision");
    expect(out.decision.source).toBe("override");
    expect(out.decision.candidate).toBe("frontier");
  });

  test("downward moves are unaffected", () => {
    const prod = [ok("Edit"), ok("Write"), ok("Edit")];
    const session = continuation("mid", "high", { turn: 6, ledger: [prod, prod, prod] });
    const { decision } = judged(effortFirst, req({ isNewUserTurn: false, toolOutcomes: prod }), session, {
      tools_failed: noul(0.05),
      spinning: noul(0.1),
      producing: noul(0.9),
    });
    expect(decision.candidate).toBe("fast");
  });

  test("with the switch off an up action switches model", () => {
    const { decision } = judged(
      policyOff,
      req({ isNewUserTurn: false, toolOutcomes: [ok("Read")] }),
      continuation("mid", "low"),
      failingAnswers,
    );
    expect(decision.candidate).toBe("frontier");
  });
});

describe("cache-aware switching", () => {
  /** mid close to frontier in input price, so a frontier -> mid downgrade saves little per turn. */
  const close = (window = 3, cache = true) =>
    withSwitch((raw) => {
      raw.candidates.mid.price = { in: 8, out: 30 };
      raw.policies.default.default = "mid";
      raw.policies.default.recent_turn_window = window;
      raw.policies.default.switch = { cache_penalty: cache };
    });
  const bigPrefix: LastUsage = { inputTokens: 2_000, outputTokens: 400, cacheReadTokens: 100_000 };
  const onFrontier = (lastUsage?: LastUsage): SessionState => ({
    ...emptySession(),
    turn: 3,
    current: { candidate: "frontier", effort: "high", lease: "one_call", sinceTurn: 0 },
    ...(lastUsage ? { lastUsage } : {}),
  });

  test("a small downgrade with a big cached prefix is blocked and explained", () => {
    const { decision, session } = judged(close(), req(), onFrontier(bigPrefix), easy);
    expect(decision.candidate).toBe("frontier");
    expect(decision.effort).toBe("high");
    expect(decision.reasons).toContain("cache_penalty_blocked");
    // penalty: 100k x ($8 - $10 x 0.1) / 1M = 0.70; saving: 3 x (8k x $2 + 600 x $10) / 1M = 0.066
    expect(decision.cache?.penaltyUsd).toBeCloseTo(0.7, 10);
    expect(decision.cache?.savingUsd).toBeCloseTo(0.066, 10);
    expect(session.current?.candidate).toBe("frontier");
  });

  test("a large saving over the horizon overrides the penalty", () => {
    const { decision } = judged(close(20), req({ estimatedInputTokens: 30_000 }), onFrontier(bigPrefix), easy);
    expect(decision.candidate).toBe("mid");
    expect(decision.reasons).not.toContain("cache_penalty_blocked");
    expect(decision.cache).toBeDefined();
    expect(decision.cache?.savingUsd ?? 0).toBeGreaterThan(decision.cache?.penaltyUsd ?? 0);
  });

  test("without usage, or without cache reads, nothing changes", () => {
    for (const lastUsage of [undefined, { inputTokens: 2_000, outputTokens: 400 }]) {
      const { decision } = judged(close(), req(), onFrontier(lastUsage), easy);
      expect(decision.candidate).toBe("mid");
      expect(decision.cache).toBeUndefined();
    }
  });

  test("with cache_penalty off the downgrade goes through", () => {
    const { decision } = judged(close(3, false), req(), onFrontier(bigPrefix), easy);
    expect(decision.candidate).toBe("mid");
    expect(decision.cache).toBeUndefined();
  });

  test("upgrades are never blocked but still report the estimate", () => {
    const session: SessionState = {
      ...emptySession(),
      turn: 3,
      current: { candidate: "mid", lease: "one_call", sinceTurn: 0 },
      lastUsage: { inputTokens: 2_000, outputTokens: 400, cacheReadTokens: 1_000_000 },
    };
    const { decision } = judged(close(), req(), session, hardHighStakes);
    expect(decision.candidate).toBe("frontier");
    expect(decision.reasons).not.toContain("cache_penalty_blocked");
    expect(decision.cache?.penaltyUsd ?? 0).toBeGreaterThan(0);
    expect(decision.cache?.savingUsd ?? 0).toBeLessThan(0);
  });

  test("staying on the same model reports no estimate", () => {
    const session: SessionState = { ...onFrontier(bigPrefix) };
    const { decision } = judged(close(), req(), session, hardHighStakes);
    expect(decision.candidate).toBe("frontier");
    expect(decision.cache).toBeUndefined();
  });
});
