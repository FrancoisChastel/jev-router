import { describe, expect, test } from "bun:test";
import { claudeCodeHookToObserve, codexHookToObserve } from "../../src/daemon/hooks";

describe("claude code hook mapping", () => {
  const base = { session_id: "S1", transcript_path: "/t", cwd: "/w", hook_event_name: "PostToolUse", effort: { level: "high" } };

  test("tool success and failure become tool_result events on the session key the relay uses", () => {
    const ok = claudeCodeHookToObserve({
      ...base,
      tool_name: "Read",
      tool_input: {},
      tool_use_id: "u1",
      tool_output: { content: "file body" },
    });
    expect(ok).toEqual({ session: "cc:S1", event: "tool_result", tool: { name: "Read", isError: false, text: "file body" } });
    const fail = claudeCodeHookToObserve({
      ...base,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: {},
      tool_use_id: "u2",
      tool_use_error: "exit 1: tests failed",
    });
    expect(fail).toEqual({ session: "cc:S1", event: "tool_result", tool: { name: "Bash", isError: true, text: "exit 1: tests failed" } });
  });

  test("subagents get their own session key", () => {
    const e = claudeCodeHookToObserve({ ...base, agent_id: "A9", agent_type: "Explore", tool_name: "Grep", tool_output: "x" });
    expect(e?.session).toBe("cc:S1:A9");
  });

  test("compaction, api failure, subagent start, and prompts map to their events", () => {
    expect(claudeCodeHookToObserve({ ...base, hook_event_name: "PostCompact", reason: "auto" })).toMatchObject({ event: "compaction" });
    expect(claudeCodeHookToObserve({ ...base, hook_event_name: "PreCompact", reason: "auto" })).toBeUndefined();
    expect(
      claudeCodeHookToObserve({ ...base, hook_event_name: "StopFailure", error: "overloaded", error_type: "overloaded" }),
    ).toMatchObject({ event: "api_error", error: "overloaded: overloaded" });
    expect(claudeCodeHookToObserve({ ...base, hook_event_name: "SubagentStart", agent_id: "A1", agent_type: "Plan" })).toMatchObject({
      event: "subagent_start",
    });
    expect(claudeCodeHookToObserve({ ...base, hook_event_name: "UserPromptSubmit", text: "hi" })).toMatchObject({ event: "prompt" });
    expect(claudeCodeHookToObserve({ ...base, hook_event_name: "Notification" })).toBeUndefined();
  });

  test("rejects payloads without a session id and bounds tool text", () => {
    expect(claudeCodeHookToObserve({ hook_event_name: "PostToolUse", tool_name: "Read" })).toBeUndefined();
    const e = claudeCodeHookToObserve({ ...base, tool_name: "Read", tool_output: "x".repeat(5000) });
    expect((e?.tool?.text ?? "").length).toBeLessThanOrEqual(200);
  });
});

describe("codex hook mapping", () => {
  const base = {
    session_id: "C1",
    transcript_path: null,
    cwd: "/w",
    hook_event_name: "PostToolUse",
    model: "gpt-6-sol",
    permission_mode: "auto",
    turn_id: "t1",
  };

  test("tool responses are classified by content since codex carries no error flag", () => {
    const ok = codexHookToObserve({
      ...base,
      tool_name: "shell",
      tool_use_id: "u1",
      tool_input: {},
      tool_response: { output: "all good" },
    });
    expect(ok).toEqual({ session: "codex:C1", event: "tool_result", tool: { name: "shell", isError: false, text: "all good" } });
    const fail = codexHookToObserve({
      ...base,
      tool_name: "shell",
      tool_use_id: "u2",
      tool_input: {},
      tool_response: "Error: command failed with exit code 2",
    });
    expect(fail?.tool).toMatchObject({ name: "shell", isError: true });
    const exit = codexHookToObserve({
      ...base,
      tool_name: "shell",
      tool_use_id: "u3",
      tool_input: {},
      tool_response: { exit_code: 1, output: "boom" },
    });
    expect(exit?.tool?.isError).toBe(true);
  });

  test("compaction and prompts map, other events are ignored", () => {
    expect(codexHookToObserve({ ...base, hook_event_name: "PostCompact", trigger: "auto" })).toMatchObject({
      session: "codex:C1",
      event: "compaction",
    });
    expect(codexHookToObserve({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" })).toMatchObject({ event: "prompt" });
    expect(codexHookToObserve({ ...base, hook_event_name: "Stop" })).toBeUndefined();
  });
});
