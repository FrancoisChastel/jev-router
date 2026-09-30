import { describe, expect, test } from "bun:test";
import { PlanWindowStore, parsePlanWindow, toFraction, toIso } from "../../src/daemon/plan-window";

const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;

// Values as observed live on 2026-09-29 through the relay (Claude Max and ChatGPT Plus logins).
const ANTHROPIC = {
  "anthropic-ratelimit-unified-5h-utilization": "0.65",
  "anthropic-ratelimit-unified-5h-reset": "1790737200",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.44",
  "anthropic-ratelimit-unified-7d-reset": "1790827200",
};
const CODEX = {
  "x-codex-primary-used-percent": "43",
  "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-at": "1790753352",
  "x-codex-secondary-used-percent": "2",
  "x-codex-secondary-window-minutes": "10080",
  "x-base-model-inference-primary-used-percent": "90",
};

describe("value parsing", () => {
  test("fractions stay fractions, percentages are scaled, junk is ignored", () => {
    expect(toFraction("0.65")).toBe(0.65);
    expect(toFraction("1")).toBe(1);
    expect(toFraction("1.02")).toBe(1);
    expect(toFraction("43")).toBe(0.43);
    expect(toFraction("43%")).toBe(0.43);
    expect(toFraction("0", true)).toBe(0);
    expect(toFraction("1", true)).toBe(0.01);
    expect(toFraction("abc")).toBeUndefined();
    expect(toFraction("")).toBeUndefined();
    expect(toFraction("-3")).toBeUndefined();
    expect(toFraction(null)).toBeUndefined();
  });

  test("reset times from Unix seconds, milliseconds, or dates", () => {
    expect(toIso("1790737200")).toBe(new Date(1790737200 * 1000).toISOString());
    expect(toIso("1790737200000")).toBe(new Date(1790737200 * 1000).toISOString());
    expect(toIso("2026-09-30T02:20:00Z")).toBe("2026-09-30T02:20:00.000Z");
    expect(toIso("soon")).toBeUndefined();
  });
});

describe("parsePlanWindow", () => {
  test("Anthropic's unified five-hour and seven-day utilization", () => {
    expect(parsePlanWindow(headers(ANTHROPIC), 5)).toEqual({
      fiveHour: 0.65,
      sevenDay: 0.44,
      resetsAt: new Date(1790737200 * 1000).toISOString(),
      observedAt: 5,
    });
  });

  test("Codex's primary and secondary windows, matched by their length rather than their slot", () => {
    expect(parsePlanWindow(headers(CODEX), 7)).toEqual({
      fiveHour: 0.43,
      sevenDay: 0.02,
      resetsAt: new Date(1790753352 * 1000).toISOString(),
      observedAt: 7,
    });
    const swapped = parsePlanWindow(
      headers({
        "x-codex-primary-used-percent": "10",
        "x-codex-primary-window-minutes": "10080",
        "x-codex-secondary-used-percent": "70",
        "x-codex-secondary-window-minutes": "300",
      }),
      1,
    );
    expect(swapped).toMatchObject({ fiveHour: 0.7, sevenDay: 0.1 });
  });

  test("responses without usage headers report nothing", () => {
    expect(parsePlanWindow(headers({ "content-type": "application/json" }), 1)).toBeUndefined();
  });
});

describe("PlanWindowStore", () => {
  test("keeps the latest window per egress and merges partial reports", () => {
    const store = new PlanWindowStore();
    store.update("a", headers(ANTHROPIC), 1);
    store.update("a", headers({ "anthropic-ratelimit-unified-5h-utilization": "0.7" }), 2);
    expect(store.get("a")).toMatchObject({ fiveHour: 0.7, sevenDay: 0.44, observedAt: 2 });
    store.update("a", headers({}), 3);
    expect(store.get("a")?.observedAt).toBe(2);
    expect(Object.keys(store.snapshot())).toEqual(["a"]);
  });

  test("the five-hour value is withheld from rules once its window has reset", () => {
    const store = new PlanWindowStore();
    store.update("a", headers(ANTHROPIC), 1);
    const before = 1790737200 * 1000 - 1;
    expect(store.utilization("a", before)).toEqual({ fiveHour: 0.65, sevenDay: 0.44 });
    expect(store.utilization("a", before + 2)).toEqual({ sevenDay: 0.44 });
    expect(store.utilization("missing", before)).toBeUndefined();
  });
});
