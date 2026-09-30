import { describe, expect, test } from "bun:test";
import { loadPolicy } from "../../src/core/policy";
import type { DecisionRecord } from "../../src/core/record";
import { replay } from "../../src/measure/replay";
import { summarize } from "../../src/measure/stats";
import { minimalPolicy } from "../fixtures/policies";

const policy = loadPolicy(minimalPolicy());

function rec(
  over: Partial<DecisionRecord> & { candidate: string; inTok: number; outTok: number; session?: string; turn?: number },
): DecisionRecord {
  const { candidate, inTok, outTok, ...rest } = over;
  const model = policy.candidates[candidate]?.model ?? "x";
  return {
    id: `r${Math.random()}`,
    ts: 1_000,
    session: over.session ?? "s1",
    harness: "claude-code",
    turn: over.turn ?? 0,
    isNewUserTurn: true,
    estimatedInputTokens: inTok,
    decision: { candidate, model, source: "judge", reasons: [], counterfactuals: {}, lease: "tool_chain" },
    apply: { ok: true },
    usage: { inputTokens: inTok, outputTokens: outTok },
    ...rest,
  };
}

describe("stats", () => {
  test("reports actual cost, every single-candidate baseline, and judge overhead honestly", () => {
    const records = [
      rec({ candidate: "fast", inTok: 10_000, outTok: 1_000, judge: { questions: ["difficulty"], costUsd: 0.00002, latencyMs: 120 } }),
      rec({ candidate: "mid", inTok: 10_000, outTok: 1_000, judge: { questions: ["difficulty"], costUsd: 0.00002, latencyMs: 80 } }),
      rec({ candidate: "frontier", inTok: 10_000, outTok: 1_000 }),
    ];
    const s = summarize(records, policy);
    // fast: 10k*0.15/1M + 1k*0.6/1M = 0.0015+0.0006 = 0.0021 ; mid: 0.03+0.015 = 0.045 ; frontier: 0.1+0.04 = 0.14
    expect(s.decisions).toBe(3);
    expect(s.actualCostUsd).toBeCloseTo(0.0021 + 0.045 + 0.14, 6);
    expect(s.baselines.fast!.costUsd).toBeCloseTo(0.0021 * 3, 6);
    expect(s.baselines.frontier!.costUsd).toBeCloseTo(0.14 * 3, 6);
    expect(s.baselines.fast!.savingsUsd).toBeLessThan(0);
    expect(s.baselines.frontier!.savingsUsd).toBeGreaterThan(0);
    expect(s.judge.calls).toBe(2);
    expect(s.judge.costUsd).toBeCloseTo(0.00004, 8);
    expect(s.judge.latencyP50Ms).toBe(120);
    expect(s.byCandidate.fast).toBe(1);
    expect(s.bySource.judge).toBe(3);
    expect(s.withUsage).toBe(3);
  });

  test("shadow-mode records are priced by the candidate that was actually served", () => {
    const shadowed = { ...rec({ candidate: "frontier", inTok: 1_000_000, outTok: 1_000_000 }), shadow: { served: "fast" } };
    const s = summarize([shadowed], policy);
    expect(s.actualCostUsd).toBeCloseTo(0.15 + 0.6, 6);
    expect(s.byCandidate.frontier).toBe(1);
  });

  test("records without usage are counted but excluded from cost", () => {
    const withUsage = rec({ candidate: "fast", inTok: 1000, outTok: 100 });
    const { usage: _u, ...without } = rec({ candidate: "mid", inTok: 0, outTok: 0 });
    const s = summarize([withUsage, without as DecisionRecord], policy);
    expect(s.decisions).toBe(2);
    expect(s.withUsage).toBe(1);
    expect(s.actualCostUsd).toBeCloseTo(0.00015 + 0.00006, 8);
  });
});

describe("replay", () => {
  test("re-decides recorded turns under a new policy using the recorded judge answers", () => {
    const answers = {
      difficulty: { type: "score" as const, score: 2.6, probabilities: {}, confidence: 0.9 },
      needs_reasoning: { type: "noul" as const, noul: 0.2 },
      stakes: { type: "score" as const, score: 1, probabilities: {}, confidence: 0.9 },
      output_kind: { type: "choice" as const, choice: "code_edit", probabilities: {}, confidence: 0.9 },
      long_context: { type: "noul" as const, noul: 0.1 },
    };
    const recorded = [
      rec({
        candidate: "mid",
        inTok: 5000,
        outTok: 500,
        turn: 0,
        judge: { questions: Object.keys(answers), answers },
        toolNames: ["Read", "Edit"],
      }),
      rec({
        candidate: "mid",
        inTok: 5000,
        outTok: 500,
        turn: 1,
        isNewUserTurn: false,
        toolOutcomes: [{ name: "Edit", isError: false }],
        decision: { candidate: "mid", model: "m", source: "lease", reasons: [], counterfactuals: {}, lease: "tool_chain" },
      }),
    ];
    const stricter = minimalPolicy();
    stricter.policies.default.rules = [{ when: "difficulty >= 3.5", then: { at_least: "mid" } }];
    const out = replay(recorded, loadPolicy(stricter), "default");
    expect(out.results).toHaveLength(2);
    expect(out.results[0]!.replayed.candidate).toBe("fast");
    expect(out.results[0]!.recorded.candidate).toBe("mid");
    expect(out.results[1]!.replayed.source).toBe("lease");
    expect(out.changed).toBe(2);
    expect(out.replayedCostUsd).toBeLessThan(out.recordedCostUsd);
  });

  test("the recorded plan window is replayed, so plan caps apply to it", () => {
    const answers = {
      difficulty: { type: "score" as const, score: 3, probabilities: {}, confidence: 0.9 },
      needs_reasoning: { type: "noul" as const, noul: 0.9 },
      stakes: { type: "score" as const, score: 3, probabilities: {}, confidence: 0.9 },
    };
    const judged = { judge: { questions: Object.keys(answers), answers } };
    const capped = minimalPolicy();
    capped.policies.default.rules.push({ when: "plan_5h >= 0.8", then: { at_most: "mid" } });
    const out = replay(
      [
        rec({ candidate: "frontier", inTok: 100, outTok: 10, session: "a", ...judged }),
        rec({ candidate: "frontier", inTok: 100, outTok: 10, session: "b", plan: { fiveHour: 0.85 }, ...judged }),
      ],
      loadPolicy(capped),
      "default",
    );
    expect(out.results.map((r) => r.replayed.candidate)).toEqual(["frontier", "mid"]);
  });

  test("turns whose judge answers were not recorded fall open in replay and are flagged", () => {
    const recorded = [
      rec({
        candidate: "mid",
        inTok: 100,
        outTok: 10,
        decision: {
          candidate: "mid",
          model: "m",
          source: "fallback",
          reasons: ["judge_unavailable"],
          counterfactuals: {},
          lease: "tool_chain",
        },
      }),
    ];
    const out = replay(recorded, policy, "default");
    expect(out.results[0]!.replayed.source).toBe("fallback");
    expect(out.unjudged).toBe(1);
  });

  test("recorded usage feeds cache-aware switching on the next replayed turn", () => {
    const score = (s: number) => ({ type: "score" as const, score: s, probabilities: {}, confidence: 0.9 });
    const noul = (p: number) => ({ type: "noul" as const, noul: p });
    const task = (difficulty: number, stakes: number) => ({
      difficulty: score(difficulty),
      needs_reasoning: noul(0.9),
      stakes: score(stakes),
      output_kind: { type: "choice" as const, choice: "code_edit", probabilities: {}, confidence: 0.9 },
      long_context: noul(0.1),
    });
    const hard = task(3.4, 2.5);
    const easy = task(0.5, 0.5);
    const recorded = [
      rec({ candidate: "frontier", inTok: 8000, outTok: 500, turn: 0, judge: { questions: Object.keys(hard), answers: hard } }),
      rec({ candidate: "frontier", inTok: 8000, outTok: 500, turn: 1, judge: { questions: Object.keys(easy), answers: easy } }),
    ];
    const withCache = { ...recorded[0]!, usage: { inputTokens: 8000, outputTokens: 500, cacheReadTokens: 100_000 } };
    const close = minimalPolicy();
    close.candidates.mid.price = { in: 8, out: 30 };
    close.policies.default.default = "mid";
    const p = loadPolicy(close);
    expect(replay(recorded, p, "default").results[1]!.replayed.candidate).toBe("mid");
    const out = replay([withCache, recorded[1]!], p, "default");
    expect(out.results[1]!.replayed.candidate).toBe("frontier");
    expect(out.results[1]!.replayed.reasons).toContain("cache_penalty_blocked");
  });
});
