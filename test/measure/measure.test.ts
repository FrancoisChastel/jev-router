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

  test("a cascade charges every attempt, while baselines price only the answer the client got", () => {
    const failed = { inputTokens: 1_000_000, outputTokens: 0 };
    const answer = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const cascaded: DecisionRecord = {
      ...rec({ candidate: "fast", inTok: 2_000_000, outTok: 1_000_000 }),
      cascade: {
        attempts: [
          { candidate: "fast", model: "openai/gpt-5.4-mini", outcome: "empty", usage: failed, costUsd: 0.15 },
          { candidate: "mid", model: "anthropic/claude-sonnet-5", outcome: "served", usage: answer, costUsd: 18 },
        ],
        served: "mid",
      },
    };
    const s = summarize([cascaded], policy);
    // fast attempt: 1M in * 0.15 = 0.15 ; mid attempt: 1M in * 3 + 1M out * 15 = 18
    expect(s.actualCostUsd).toBeCloseTo(18.15, 6);
    expect(s.baselines.mid!.costUsd).toBeCloseTo(18, 6);
    expect(s.baselines.fast!.costUsd).toBeCloseTo(0.75, 6);
    expect(s.cascades).toEqual({ requests: 1, retries: 1, discardedCostUsd: expect.closeTo(0.15, 6) as unknown as number });
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
});
