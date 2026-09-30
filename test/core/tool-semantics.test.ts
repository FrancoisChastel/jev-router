import { describe, expect, test } from "bun:test";
import { classifyTool } from "../../src/core/signals/tool-semantics";

describe("tool semantics", () => {
  test("built-in vocabularies per harness", () => {
    expect(classifyTool("Read", "claude-code")).toBe("observe");
    expect(classifyTool("Edit", "claude-code")).toBe("mutate");
    expect(classifyTool("TodoWrite", "claude-code")).toBe("plan");
    expect(classifyTool("Bash", "claude-code")).toBe("shell");
    expect(classifyTool("apply_patch", "codex")).toBe("mutate");
    expect(classifyTool("update_plan", "codex")).toBe("plan");
    expect(classifyTool("write", "pi")).toBe("mutate");
    expect(classifyTool("grep", "pi")).toBe("observe");
    expect(classifyTool("todowrite", "opencode")).toBe("plan");
    expect(classifyTool("codebase_search", "cursor")).toBe("observe");
    expect(classifyTool("edit_file", "cursor")).toBe("mutate");
    expect(classifyTool("todo_write", "cursor")).toBe("plan");
    expect(classifyTool("run_terminal_cmd", "cursor")).toBe("shell");
  });

  test("generic fallback by name pattern, case-insensitive", () => {
    expect(classifyTool("mcp__fs__read_text_file", "unknown")).toBe("observe");
    expect(classifyTool("KB_search", "unknown")).toBe("observe");
    expect(classifyTool("send_payment_request", "unknown")).toBe("mutate");
    expect(classifyTool("create_research_plan", "unknown")).toBe("plan");
    expect(classifyTool("run_command", "unknown")).toBe("shell");
    expect(classifyTool("frobnicate", "unknown")).toBe("other");
  });

  test("policy overrides win over built-ins", () => {
    const overrides = { observe: ["get_customer_by_phone"], mutate: ["Read"] };
    expect(classifyTool("get_customer_by_phone", "unknown", overrides)).toBe("observe");
    expect(classifyTool("Read", "claude-code", overrides)).toBe("mutate");
  });
});
