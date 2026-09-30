import { describe, expect, test } from "bun:test";
import { effortStepUp, higherEffort, resolveEffort } from "../../src/core/effort";
import type { Candidate } from "../../src/core/policy/types";

const mid: Candidate = { model: "m", price: { in: 3, out: 15 }, effort: ["high", "low", "medium"] };

describe("effortStepUp", () => {
  test("steps one level above the level in use", () => {
    expect(effortStepUp(mid, "low")).toBe("medium");
    expect(effortStepUp(mid, "medium")).toBe("high");
  });

  test("returns undefined at the top level or without an effort list", () => {
    expect(effortStepUp(mid, "high")).toBeUndefined();
    expect(effortStepUp(mid, "max")).toBeUndefined();
    expect(effortStepUp({ model: "x", price: { in: 1, out: 1 } }, "low")).toBeUndefined();
  });

  test("falls back to the default effort, then the middle of the list", () => {
    expect(effortStepUp({ ...mid, default_effort: "low" }, undefined)).toBe("medium");
    expect(effortStepUp(mid, undefined)).toBe("high");
  });

  test("clamps an unsupported level in use before stepping", () => {
    expect(effortStepUp(mid, "minimal")).toBe("medium");
    expect(effortStepUp({ ...mid, effort: ["low", "high"] }, "medium")).toBe("high");
  });
});

describe("resolveEffort and higherEffort", () => {
  test("resolveEffort clamps down to the supported list and flags it", () => {
    expect(resolveEffort(mid, "xhigh")).toEqual({ effort: "high", clamped: true });
    expect(resolveEffort(mid, "low")).toEqual({ effort: "low", clamped: false });
    expect(resolveEffort(mid, undefined)).toEqual({ clamped: false });
  });

  test("higherEffort picks the higher level and tolerates absence", () => {
    expect(higherEffort("low", "high")).toBe("high");
    expect(higherEffort(undefined, "low")).toBe("low");
    expect(higherEffort("medium", undefined)).toBe("medium");
  });
});
