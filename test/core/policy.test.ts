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

describe("candidate subsets and mounted egress", () => {
  test("a policy may use a subset of candidates, but its default and rule targets must be in it", () => {
    const raw = minimalPolicy();
    raw.policies.default.order = ["fast", "frontier"];
    raw.policies.default.rules = [{ when: "stakes >= 2.5", then: { at_least: "frontier" } }];
    expect(tierOrder(loadPolicy(raw), "default")).toEqual(["fast", "frontier"]);
    raw.policies.default.rules = [{ when: "stakes >= 2.5", then: { at_least: "mid" } }];
    expect(() => loadPolicy(raw)).toThrow(/unknown candidate 'mid'/);
    raw.policies.default.rules = [];
    raw.policies.default.default = "mid";
    expect(() => loadPolicy(raw)).toThrow(/must be listed in order/);
    raw.policies.default.default = "fast";
    raw.policies.default.order = ["fast", "fast"];
    expect(() => loadPolicy(raw)).toThrow(/repeat/);
  });

  test("egress mounts are absolute paths without a trailing slash, distinct, and billing is usd or subscription", () => {
    const raw = minimalPolicy();
    raw.egress = { a: { base_url: "https://x", mount: "/backend-api/codex", forward_auth: true, billing: "subscription" } };
    expect(loadPolicy(raw).egress.a?.mount).toBe("/backend-api/codex");
    raw.egress = { a: { base_url: "https://x", mount: "backend/" } };
    expect(() => loadPolicy(raw)).toThrow(/mount/);
    raw.egress = { a: { base_url: "https://x", mount: "/m" }, b: { base_url: "https://y", mount: "/m" } };
    expect(() => loadPolicy(raw)).toThrow(/distinct/);
    raw.egress = { a: { base_url: "https://x", billing: "credits" as "usd" } };
    expect(() => loadPolicy(raw)).toThrow(/billing/);
  });
});
