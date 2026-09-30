import { describe, expect, test } from "bun:test";
import { plan } from "../../src/core/decide";
import { compileExpr, loadPolicy, PolicyError } from "../../src/core/policy";
import { emptySession } from "../../src/core/session";
import type { NormalizedRequest, SessionState } from "../../src/core/types";
import type { Answer } from "../../src/judge/types";
import { minimalPolicy } from "../fixtures/policies";

function req(over: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    harness: "claude-code",
    sessionKey: "s1",
    requestedModel: "auto",
    isNewUserTurn: true,
    lastUserText: "design the new storage engine",
    toolNames: ["Read", "Edit"],
    hasImages: false,
    estimatedInputTokens: 8000,
    toolOutcomes: [],
    ...over,
  };
}

const score = (s: number, confidence = 0.9): Answer => ({ type: "score", score: s, probabilities: {}, confidence });
const HARD = { difficulty: score(3), needs_reasoning: score(1), stakes: score(3) };

/** The fixture policy plus the plan caps `init` appends to subscription policies. */
function cappedPolicy() {
  const raw = minimalPolicy();
  raw.policies.default.rules.push(
    { when: "plan_5h >= 0.8", then: { at_most: "mid" } },
    { when: "plan_5h >= 0.95", then: { at_most: "fast" } },
  );
  return loadPolicy(raw);
}

function concludeWith(request: NormalizedRequest, answers: Record<string, Answer>, session: SessionState = emptySession()) {
  const out = plan({ request, session, policy: cappedPolicy(), policyId: "default" });
  if (out.kind !== "judge") throw new Error("expected a judge request");
  return out.conclude(answers).decision;
}

describe("plan window identifiers", () => {
  test("absent plan_5h is unknown: neither a comparison nor its negation fires", () => {
    const e = compileExpr("plan_5h >= 0.8");
    expect(e.evaluate({})).toBe(false);
    expect(compileExpr("not (plan_5h >= 0.8)").evaluate({})).toBe(false);
    expect(e.evaluate({ plan_5h: 0.81 })).toBe(true);
  });

  test("with no plan window observed the caps never apply and hard work still escalates", () => {
    const d = concludeWith(req(), HARD);
    expect(d.candidate).toBe("frontier");
    expect(d.reasons).not.toContain("capped");
  });

  test("plan_5h and plan_7d are accepted by the policy loader", () => {
    const raw = minimalPolicy();
    raw.policies.default.rules.push({ when: "plan_7d > 0.5 and plan_5h < 0.2", then: { allow_down: true } });
    expect(() => loadPolicy(raw)).not.toThrow();
  });
});

describe("at_most", () => {
  test("at 80% of the five-hour window the judge's frontier pick is capped at the middle tier", () => {
    const d = concludeWith(req({ planWindow: { fiveHour: 0.82, sevenDay: 0.3 } }), HARD);
    expect(d.candidate).toBe("mid");
    expect(d.reasons).toContain("capped");
    expect(d.reasons).toContain("rule:5");
  });

  test("at 95% the lowest cap wins", () => {
    const d = concludeWith(req({ planWindow: { fiveHour: 0.96 } }), HARD);
    expect(d.candidate).toBe("fast");
    expect(d.reasons).toEqual(expect.arrayContaining(["rule:5", "rule:6", "capped"]));
  });

  test("a cap below the pick changes nothing and is not reported", () => {
    const d = concludeWith(req({ planWindow: { fiveHour: 0.85 } }), { difficulty: score(0), needs_reasoning: score(0), stakes: score(0) });
    expect(d.candidate).toBe("fast");
    expect(d.reasons).not.toContain("capped");
    expect(d.reasons).not.toContain("rule:5");
  });

  test("caps bound deterministic paths too: overrides and leases never climb past them", () => {
    const policy = cappedPolicy();
    const session: SessionState = { ...emptySession(), turn: 4, current: { candidate: "frontier", lease: "tool_chain", sinceTurn: 3 } };
    const lease = plan({
      request: req({ isNewUserTurn: false, toolOutcomes: [{ name: "Edit", isError: false }], planWindow: { fiveHour: 0.9 } }),
      session,
      policy,
      policyId: "default",
    });
    expect(lease.kind).toBe("decision");
    if (lease.kind !== "decision") return;
    expect(lease.decision.candidate).toBe("mid");
    expect(lease.decision.source).toBe("lease");
    expect(lease.session.current?.candidate).toBe("mid");

    const override = plan({
      request: req({ contextCompacted: true, planWindow: { fiveHour: 0.97 } }),
      session: { ...emptySession(), current: { candidate: "mid", lease: "tool_chain", sinceTurn: 0 } },
      policy,
      policyId: "default",
    });
    if (override.kind !== "decision") throw new Error("expected a decision");
    expect(override.decision.source).toBe("override");
    expect(override.decision.candidate).toBe("fast");
  });

  test("a cap on a tier the request cannot use falls to the nearest usable tier below it", () => {
    const raw = minimalPolicy();
    raw.candidates.mid.capabilities = { vision: false };
    raw.policies.default.rules.push({ when: "plan_5h >= 0.8", then: { at_most: "mid" } });
    const out = plan({
      request: req({ hasImages: true, planWindow: { fiveHour: 0.9 } }),
      session: emptySession(),
      policy: loadPolicy(raw),
      policyId: "default",
    });
    if (out.kind !== "judge") throw new Error("expected a judge request");
    expect(out.conclude(HARD).decision.candidate).toBe("fast");
  });

  test("validation rejects unknown candidates like at_least does", () => {
    const raw = minimalPolicy();
    raw.policies.default.rules.push({ when: "plan_5h >= 0.8", then: { at_most: "nope" } });
    expect(() => loadPolicy(raw)).toThrow(PolicyError);
    expect(() => loadPolicy(raw)).toThrow(/at_most references unknown candidate 'nope'/);
  });
});

describe("dialect filter", () => {
  function localPolicy() {
    const raw = minimalPolicy();
    raw.egress = {
      gateway: { base_url: "https://gw.example", api_key_env: "GW" },
      ollama: { base_url: "http://127.0.0.1:11434", no_auth: true, dialects: ["openai-chat"] },
    };
    return loadPolicy({
      ...raw,
      candidates: { ...raw.candidates, local: { model: "qwen3-coder:30b", via: "ollama", price: { in: 0, out: 0 } } },
      policies: {
        default: {
          ...raw.policies.default,
          default: "fast",
          order: ["local", "fast", "mid", "frontier"],
          rules: [{ when: "request_class in [auxiliary, compaction]", then: { pin: "local" } }, ...raw.policies.default.rules],
        },
      },
    });
  }

  test("an openai-chat request can land on the chat-only local tier", () => {
    const out = plan({
      request: req({ requestClass: "auxiliary", dialect: "openai-chat" }),
      session: emptySession(),
      policy: localPolicy(),
      policyId: "default",
    });
    if (out.kind !== "decision") throw new Error("expected a decision");
    expect(out.decision.candidate).toBe("local");
    expect(out.decision.reasons).not.toContain("dialect_filter");
  });

  test("an Anthropic request skips it and the pin clamps to the next tier up", () => {
    const out = plan({
      request: req({ requestClass: "auxiliary", dialect: "anthropic" }),
      session: emptySession(),
      policy: localPolicy(),
      policyId: "default",
    });
    if (out.kind !== "decision") throw new Error("expected a decision");
    expect(out.decision.candidate).toBe("fast");
    expect(out.decision.reasons).toContain("dialect_filter");
    expect(Object.keys(out.decision.counterfactuals)).toContain("local");
  });

  test("a request without a dialect is not filtered", () => {
    const out = plan({ request: req({ requestClass: "auxiliary" }), session: emptySession(), policy: localPolicy(), policyId: "default" });
    if (out.kind !== "decision") throw new Error("expected a decision");
    expect(out.decision.candidate).toBe("local");
  });

  test("egress dialects and no_auth are validated", () => {
    const raw = minimalPolicy();
    raw.egress = { x: { base_url: "http://x", dialects: ["smoke-signals" as "anthropic"] } };
    expect(() => loadPolicy(raw)).toThrow(/dialects/);
    raw.egress = { x: { base_url: "http://x", dialects: [] } };
    expect(() => loadPolicy(raw)).toThrow(/dialects/);
    raw.egress = { x: { base_url: "http://x", no_auth: "yes" as unknown as boolean } };
    expect(() => loadPolicy(raw)).toThrow(/no_auth/);
  });
});
