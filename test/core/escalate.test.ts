import { describe, expect, test } from "bun:test";
import { nextTier, reassignServed } from "../../src/core/escalate";
import { loadPolicy } from "../../src/core/policy";
import type { Decision, NormalizedRequest, SessionState } from "../../src/core/types";
import { minimalPolicy } from "../fixtures/policies";

const request = (over: Partial<NormalizedRequest> = {}): NormalizedRequest => ({
  harness: "claude-code",
  sessionKey: "s",
  requestedModel: "auto",
  isNewUserTurn: true,
  toolNames: [],
  hasImages: false,
  estimatedInputTokens: 1000,
  toolOutcomes: [],
  ...over,
});

const decision = (candidate: string, over: Partial<Decision> = {}): Decision => ({
  candidate,
  model: "m",
  source: "judge",
  reasons: ["rule:1"],
  counterfactuals: {},
  lease: "tool_chain",
  ...over,
});

describe("nextTier", () => {
  const policy = loadPolicy(minimalPolicy());

  test("steps one tier up the ladder and stops at the top", () => {
    const up = nextTier(policy, "default", request(), decision("fast"));
    expect(up).toMatchObject({ candidate: "mid", model: "anthropic/claude-sonnet-5", source: "judge", lease: "tool_chain" });
    expect(up?.reasons).toEqual(["rule:1", "cascade"]);
    expect(nextTier(policy, "default", request(), decision("frontier"))).toBeUndefined();
  });

  test("skips candidates that cannot serve the request", () => {
    const raw = minimalPolicy();
    raw.candidates.mid.capabilities = { vision: false };
    const p = loadPolicy(raw);
    expect(nextTier(p, "default", request({ hasImages: true }), decision("fast"))?.candidate).toBe("frontier");
    expect(nextTier(p, "default", request(), decision("fast"))?.candidate).toBe("mid");
  });

  test("clamps the effort to the new candidate's list", () => {
    const up = nextTier(policy, "default", request({ requestedEffort: "max" }), decision("fast"));
    expect(up?.effort).toBe("high");
    expect(up?.reasons).toContain("effort_clamped");
    const kept = nextTier(policy, "default", request(), decision("mid", { effort: "high" }));
    expect(kept).toMatchObject({ candidate: "frontier", effort: "high" });
    const dropped = nextTier(policy, "default", request(), decision("mid", { effort: "low" }));
    expect(dropped?.effort).toBe("medium");
  });
});

describe("reassignServed", () => {
  const session: SessionState = {
    turn: 3,
    ledger: [],
    consecutiveFailures: 0,
    current: { candidate: "fast", lease: "tool_chain", sinceTurn: 2 },
  };

  test("moves the current assignment to the serving tier, keeping lease and start turn", () => {
    const next = reassignServed(session, "mid", "high");
    expect(next.current).toEqual({ candidate: "mid", effort: "high", lease: "tool_chain", sinceTurn: 2 });
    expect(session.current?.candidate).toBe("fast");
  });

  test("is a no-op when nothing changes or there is no assignment", () => {
    expect(reassignServed(session, "fast", undefined)).toBe(session);
    const bare: SessionState = { turn: 0, ledger: [], consecutiveFailures: 0 };
    expect(reassignServed(bare, "mid", undefined)).toBe(bare);
  });
});
