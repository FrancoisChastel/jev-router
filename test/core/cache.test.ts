import { describe, expect, test } from "bun:test";
import { CACHE_READ_DISCOUNT, cachePenaltyUsd, estimateSwitch, switchSavingUsd } from "../../src/core/cache";
import type { Candidate } from "../../src/core/policy/types";

const cheap: Candidate = { model: "cheap", price: { in: 1, out: 4 } };
const pricey: Candidate = { model: "pricey", price: { in: 3, out: 15 } };

describe("cachePenaltyUsd", () => {
  test("charges the cached prefix at the new model's full price minus the discounted read staying would pay", () => {
    const lastUsage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 100_000 };
    const penalty = cachePenaltyUsd({ lastUsage, from: pricey, to: cheap });
    // 100k at $1/M full price = 0.10, minus 100k at $3/M x 0.1 = 0.03
    expect(penalty).toBeCloseTo(0.1 - 0.03, 10);
    expect(CACHE_READ_DISCOUNT).toBe(0.9);
  });

  test("is zero without cache reads and never negative", () => {
    expect(cachePenaltyUsd({ lastUsage: { inputTokens: 10, outputTokens: 1 }, from: pricey, to: cheap })).toBe(0);
    const tiny: Candidate = { model: "tiny", price: { in: 0.01, out: 0.04 } };
    const lastUsage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1_000_000 };
    expect(cachePenaltyUsd({ lastUsage, from: pricey, to: tiny })).toBe(0);
  });
});

describe("switchSavingUsd", () => {
  test("is the per-turn price difference times the horizon", () => {
    const saving = switchSavingUsd({ estimatedInputTokens: 10_000, estOutputTokens: 1_000, from: pricey, to: cheap, horizonTurns: 3 });
    // per turn: (0.03 + 0.015) - (0.01 + 0.004) = 0.031
    expect(saving).toBeCloseTo(0.031 * 3, 10);
  });

  test("is negative for an upgrade", () => {
    const saving = switchSavingUsd({ estimatedInputTokens: 10_000, estOutputTokens: 1_000, from: cheap, to: pricey, horizonTurns: 1 });
    expect(saving).toBeLessThan(0);
  });
});

describe("estimateSwitch", () => {
  const base = { estimatedInputTokens: 10_000, estOutputTokens: 600, from: pricey, to: cheap, horizonTurns: 3 };

  test("returns undefined when cache reads are unknown", () => {
    expect(estimateSwitch({ ...base, lastUsage: undefined })).toBeUndefined();
    expect(estimateSwitch({ ...base, lastUsage: { inputTokens: 1, outputTokens: 1 } })).toBeUndefined();
  });

  test("returns both numbers when cache reads are known", () => {
    const est = estimateSwitch({ ...base, lastUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 50_000 } });
    expect(est?.penaltyUsd).toBeCloseTo(0.05 - 0.015, 10);
    expect(est?.savingUsd).toBeCloseTo(switchSavingUsd(base), 10);
  });
});
