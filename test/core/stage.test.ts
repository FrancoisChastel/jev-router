import { describe, expect, test } from "bun:test";
import { scoreStage } from "../../src/core/signals/stage";
import type { ToolOutcome } from "../../src/core/types";

const ok = (name: string): ToolOutcome => ({ name, isError: false });
const err = (name: string, errorText = "boom"): ToolOutcome => ({ name, isError: true, errorText });

describe("stage scorer", () => {
  test("abstains with no tool history", () => {
    const s = scoreStage([], "claude-code", {});
    expect(s.abstained).toBe(true);
    expect(s.raw).toBe(0);
  });

  test("steady production pushes toward efficient", () => {
    const window = [
      [ok("Read"), ok("Edit")],
      [ok("Edit"), ok("Write")],
      [ok("Edit"), ok("Bash")],
    ];
    const s = scoreStage(window, "claude-code", {});
    expect(s.abstained).toBe(false);
    expect(s.raw).toBeLessThan(0);
    expect(s.dimensions.production_intensity).toBeGreaterThan(0.5);
  });

  test("errors push toward capable and one maxed axis stays inside the ambiguous band", () => {
    const window = [
      [err("Bash", "e1"), err("Bash", "e2")],
      [err("Edit", "e3"), err("Bash", "e4")],
    ];
    const s = scoreStage(window, "claude-code", {});
    expect(s.raw).toBeGreaterThan(0);
    expect(s.dimensions.severity).toBeGreaterThan(0.9);
    // a single maxed dimension yields ~0.46 confidence, per the Switchyard threshold rationale
    expect(s.confidence).toBeGreaterThan(0.4);
    expect(s.confidence).toBeLessThan(0.5);
  });

  test("corroborating recovery signals push decisively past 0.5", () => {
    const spin = err("Bash", "tests failed: 3 errors");
    const window = [
      [spin, spin],
      [spin, spin],
      [spin, spin],
    ];
    const s = scoreStage(window, "claude-code", {});
    expect(s.dimensions.spinning).toBeGreaterThan(0.6);
    expect(s.confidence).toBeGreaterThan(0.5);
  });

  test("exploring without producing leans capable but weakly", () => {
    const window = [
      [ok("Read"), ok("Grep")],
      [ok("Glob"), ok("Read")],
      [ok("Read"), ok("Read")],
    ];
    const s = scoreStage(window, "claude-code", {});
    expect(s.dimensions.exploring).toBeGreaterThan(0.6);
    expect(s.dimensions.production_intensity).toBe(0);
    expect(s.raw).toBeGreaterThan(0);
  });

  test("critical error markers force the override flag", () => {
    const window = [[err("Bash", "Traceback (most recent call last): ... fatal")]];
    const s = scoreStage(window, "claude-code", {});
    expect(s.critical).toBe(true);
  });

  test("only the recent window counts", () => {
    const old = [err("Bash"), err("Bash")];
    const recent = [ok("Edit"), ok("Edit")];
    const s = scoreStage([old, recent, recent, recent], "claude-code", { recentTurnWindow: 3 });
    expect(s.dimensions.severity).toBe(0);
  });
});
