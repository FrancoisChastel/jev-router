import { describe, expect, test } from "bun:test";
import { loadPolicy, tierOrder } from "../../src/core/policy";
import { minimalPolicy } from "../fixtures/policies";

describe("policy loading", () => {
  test("accepts the v1 example and orders tiers by input price when no order is given", () => {
    const p = loadPolicy(minimalPolicy());
    expect(tierOrder(p, "default")).toEqual(["fast", "mid", "frontier"]);
  });

  test("explicit order wins", () => {
    const raw = minimalPolicy();
    raw.policies.default.order = ["frontier", "fast", "mid"];
    const p = loadPolicy(raw);
    expect(tierOrder(p, "default")).toEqual(["frontier", "fast", "mid"]);
  });

  test("rejects unknown candidates, bad expressions, and unknown keys", () => {
    const missing = minimalPolicy();
    missing.policies.default.default = "nope";
    expect(() => loadPolicy(missing)).toThrow(/candidate/);

    const badExpr = minimalPolicy();
    badExpr.policies.default.rules.push({ when: "difficulty >= (2", then: { up: 1 } });
    expect(() => loadPolicy(badExpr)).toThrow(/rule/);

    const badAction = minimalPolicy();
    (badAction.policies.default.rules[0] as unknown as { then: Record<string, unknown> }).then = { teleport: true };
    expect(() => loadPolicy(badAction)).toThrow(/action/);
  });

  test("rejects out-of-range knobs", () => {
    const raw = minimalPolicy();
    raw.policies.default.min_confidence = 1.5;
    expect(() => loadPolicy(raw)).toThrow(/min_confidence/);
  });

  test("rejects malformed capabilities, routes, and egress entries", () => {
    const caps = minimalPolicy();
    (caps.candidates.fast as { capabilities?: unknown }).capabilities = { context: "128k" };
    expect(() => loadPolicy(caps)).toThrow(/capabilities/);

    const route = minimalPolicy();
    (route.routes[0] as { harness: string }).harness = "clod-code";
    expect(() => loadPolicy(route)).toThrow(/harness/);

    const egress = minimalPolicy();
    (egress as { egress?: unknown }).egress = { openrouter: { api_key_env: "X" } };
    expect(() => loadPolicy(egress)).toThrow(/egress/);
  });

  test("rejects rules that reference unknown identifiers", () => {
    const typo = minimalPolicy();
    typo.policies.default.rules.push({ when: "dificulty >= 2", then: { up: 1 } });
    expect(() => loadPolicy(typo)).toThrow(/dificulty/);

    const compacted = minimalPolicy();
    compacted.policies.default.rules.push({ when: "context_compacted", then: { up: 1 } });
    expect(() => loadPolicy(compacted)).toThrow(/context_compacted/);
  });

  test("rejects a confidence_threshold below the single-axis floor", () => {
    const raw = minimalPolicy();
    raw.policies.default.confidence_threshold = 0.4;
    expect(() => loadPolicy(raw)).toThrow(/confidence_threshold/);
  });

  test("loading never mutates the input", () => {
    const raw = minimalPolicy();
    const snapshot = JSON.stringify(raw);
    loadPolicy(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });
});
