import { describe, expect, test } from "bun:test";
import type { Decision } from "../../src/core/types";
import { anthropicDialect } from "../../src/daemon/dialects/anthropic";
import { openaiChatDialect } from "../../src/daemon/dialects/openai-chat";
import { openaiResponsesDialect } from "../../src/daemon/dialects/openai-responses";

const decision = (model: string, effort?: Decision["effort"]): Decision => ({
  candidate: "mid",
  model,
  source: "judge",
  reasons: [],
  counterfactuals: {},
  lease: "tool_chain",
  ...(effort ? { effort } : {}),
});

describe("anthropic messages dialect", () => {
  const body = {
    model: "claude-code/auto",
    max_tokens: 1024,
    stream: true,
    system: [
      { type: "text", text: "attribution", cache_control: { type: "ephemeral" } },
      { type: "text", text: "You are Claude Code." },
    ],
    tools: [
      { name: "Bash", input_schema: {} },
      { name: "Read", input_schema: {} },
    ],
    output_config: { effort: "high" },
    messages: [
      { role: "user", content: "fix the failing test" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will run the tests first." },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } },
          { type: "tool_use", id: "t2", name: "Read", input: { path: "a.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: true, content: "error: 3 tests failed" },
          {
            type: "tool_result",
            tool_use_id: "t2",
            content: [
              { type: "text", text: "export const a = 1;" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "" } },
            ],
          },
        ],
      },
    ],
  };

  test("normalizes tool outcomes, intent, tools, images, and effort", () => {
    const n = anthropicDialect.normalize(body);
    expect(n.requestedModel).toBe("claude-code/auto");
    expect(n.isNewUserTurn).toBe(false);
    expect(n.lastUserText).toBe("fix the failing test");
    expect(n.assistantIntentTail).toContain("run the tests first");
    expect(n.toolNames).toEqual(["Bash", "Read"]);
    expect(n.hasImages).toBe(true);
    expect(n.stream).toBe(true);
    expect(n.requestedEffort).toBe("high");
    expect(n.toolOutcomes).toEqual([
      { name: "Bash", isError: true, errorText: "error: 3 tests failed" },
      { name: "Read", isError: false, excerpt: "export const a = 1;" },
    ]);
    expect(n.prefixDigestInput).toContain("fix the failing test");
  });

  test("a plain user prompt is a new user turn", () => {
    const n = anthropicDialect.normalize({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] });
    expect(n.isNewUserTurn).toBe(true);
    expect(n.lastUserText).toBe("hello");
    expect(n.toolOutcomes).toEqual([]);
  });

  test("rewrite changes only model and an existing effort field", () => {
    const out = anthropicDialect.rewrite(body, decision("anthropic/claude-sonnet-5", "xhigh"));
    expect(out.model).toBe("anthropic/claude-sonnet-5");
    expect(out.output_config).toEqual({ effort: "xhigh" });
    const { model: _m, output_config: _o, ...rest } = out;
    const { model: _m2, output_config: _o2, ...orig } = body;
    expect(rest).toEqual(orig);
    expect(JSON.stringify(rest.system)).toBe(JSON.stringify(body.system));
    // no effort field is added when the request did not carry one
    const bare = anthropicDialect.rewrite({ model: "m", messages: [] }, decision("x", "high"));
    expect("output_config" in bare).toBe(false);
  });

  test("echoModel restores the requested id in JSON responses", () => {
    expect(
      anthropicDialect.echoModel({ id: "msg", model: "claude-sonnet-5-20260101", role: "assistant" }, "claude-code/auto"),
    ).toMatchObject({ model: "claude-code/auto" });
  });
});

describe("openai chat dialect", () => {
  const body = {
    model: "auto",
    reasoning_effort: "medium",
    tools: [{ type: "function", function: { name: "bash", parameters: {} } }],
    messages: [
      { role: "system", content: "You are Pi." },
      { role: "user", content: "refactor foo" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "Error: command not found" },
    ],
  };

  test("normalizes trailing tool messages and effort", () => {
    const n = openaiChatDialect.normalize(body);
    expect(n.isNewUserTurn).toBe(false);
    expect(n.toolNames).toEqual(["bash"]);
    expect(n.toolOutcomes).toEqual([{ name: "bash", isError: true, errorText: "Error: command not found" }]);
    expect(n.requestedEffort).toBe("medium");
    expect(n.lastUserText).toBe("refactor foo");
  });

  test("detects images in content parts and new user turns", () => {
    const n = openaiChatDialect.normalize({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "see" },
            { type: "image_url", image_url: { url: "data:..." } },
          ],
        },
      ],
    });
    expect(n.hasImages).toBe(true);
    expect(n.isNewUserTurn).toBe(true);
    expect(n.lastUserText).toBe("see");
  });

  test("rewrite sets model and reasoning_effort when the decision carries one", () => {
    const out = openaiChatDialect.rewrite(body, decision("openai/gpt-6-astra", "high"));
    expect(out.model).toBe("openai/gpt-6-astra");
    expect(out.reasoning_effort).toBe("high");
    const none = openaiChatDialect.rewrite({ model: "m", messages: [] }, decision("x"));
    expect("reasoning_effort" in none).toBe(false);
  });
});

describe("openai responses dialect", () => {
  const body = {
    model: "auto",
    instructions: "You are Codex.",
    reasoning: { effort: "low", summary: "auto" },
    tools: [{ type: "function", name: "shell", parameters: {} }],
    input: [
      { role: "user", content: [{ type: "input_text", text: "add tests" }] },
      { type: "function_call", call_id: "f1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "f1", output: '{"exit_code":1,"output":"tests failed"}' },
    ],
  };

  test("normalizes function call outputs and effort", () => {
    const n = openaiResponsesDialect.normalize(body);
    expect(n.isNewUserTurn).toBe(false);
    expect(n.toolNames).toEqual(["shell"]);
    expect(n.toolOutcomes[0]).toMatchObject({ name: "shell", isError: true });
    expect(n.requestedEffort).toBe("low");
    expect(n.lastUserText).toBe("add tests");
  });

  test("a string input is a new user turn", () => {
    const n = openaiResponsesDialect.normalize({ model: "m", input: "hello" });
    expect(n.isNewUserTurn).toBe(true);
    expect(n.lastUserText).toBe("hello");
  });

  test("rewrite sets model and reasoning.effort without dropping other reasoning fields", () => {
    const out = openaiResponsesDialect.rewrite(body, decision("openai/gpt-6-astra", "xhigh"));
    expect(out.model).toBe("openai/gpt-6-astra");
    expect(out.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
  });
});
