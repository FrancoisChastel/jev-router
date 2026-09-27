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
    (badAction.policies.default.rules[0] as { then: Record<string, unknown> }).then = { teleport: true };
    expect(() => loadPolicy(badAction)).toThrow(/action/);
  });

  test("rejects out-of-range knobs", () => {
    const raw = minimalPolicy();
    raw.policies.default.min_confidence = 1.5;
    expect(() => loadPolicy(raw)).toThrow(/min_confidence/);
  });

  test("loading never mutates the input", () => {
    const raw = minimalPolicy();
    const snapshot = JSON.stringify(raw);
    loadPolicy(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });
});
