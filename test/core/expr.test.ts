import { describe, expect, test } from "bun:test";
import { compileExpr, evaluateExpr } from "../../src/core/policy/expr";

describe("rule expressions", () => {
  test("numeric comparisons and boolean operators", () => {
    const ctx = { difficulty: 2.4, needs_reasoning: 0.9, stakes: 1 };
    expect(evaluateExpr("difficulty >= 2 or needs_reasoning > 0.8", ctx)).toBe(true);
    expect(evaluateExpr("stakes >= 2 and difficulty >= 3", ctx)).toBe(false);
    expect(evaluateExpr("not (stakes >= 2)", ctx)).toBe(true);
    expect(evaluateExpr("difficulty == 2.4 and stakes != 2", ctx)).toBe(true);
  });

  test("membership over bare identifiers and strings", () => {
    expect(evaluateExpr("request_class in [auxiliary, compaction]", { request_class: "auxiliary" })).toBe(true);
    expect(evaluateExpr('output_kind in ["code_edit", plan]', { output_kind: "plan" })).toBe(true);
    expect(evaluateExpr("request_class in [auxiliary]", { request_class: "main" })).toBe(false);
  });

  test("bare boolean identifiers and dotted names", () => {
    expect(evaluateExpr("context_compacted", { context_compacted: true })).toBe(true);
    expect(evaluateExpr("context_compacted", {})).toBe(false);
    expect(evaluateExpr("difficulty.confidence < 0.6", { "difficulty.confidence": 0.4 })).toBe(true);
  });

  test("unknown identifiers compare as false, never throw", () => {
    expect(evaluateExpr("missing > 1", {})).toBe(false);
    expect(evaluateExpr("missing > 1 or present", { present: true })).toBe(true);
  });

  test("rejects anything outside the whitelist at compile time", () => {
    expect(() => compileExpr("difficulty >= 2; process.exit()")).toThrow();
    expect(() => compileExpr("difficulty => 2")).toThrow();
    expect(() => compileExpr("(difficulty >= 2")).toThrow();
    expect(() => compileExpr("")).toThrow();
  });

  test("compiled expressions report referenced identifiers", () => {
    const c = compileExpr("difficulty >= 2 or tools_failed > 0.7");
    expect([...c.identifiers].sort()).toEqual(["difficulty", "tools_failed"]);
  });
});
