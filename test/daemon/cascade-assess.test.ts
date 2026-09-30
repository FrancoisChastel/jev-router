import { describe, expect, test } from "bun:test";
import { assessResponse } from "../../src/daemon/cascade/assess";
import { usageFromBody } from "../../src/daemon/cascade/body";

const SSE = "text/event-stream";
const JSON_CT = "application/json";
const sse = (events: readonly unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

const anthropicStream = (opts: { text?: string; tool?: boolean; stop?: string; thinking?: boolean }) =>
  [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":20,"output_tokens":1}}}\n\n',
    'event: ping\ndata: {"type":"ping"}\n\n',
    opts.thinking
      ? sse([
          { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
        ])
      : "",
    opts.text !== undefined
      ? sse([
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: opts.text } },
          { type: "content_block_stop", index: 1 },
        ])
      : "",
    opts.tool
      ? sse([
          { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t", name: "Bash", input: {} } },
          { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } },
        ])
      : "",
    sse([
      { type: "message_delta", delta: { stop_reason: opts.stop ?? "end_turn" }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ]),
  ].join("");

const chatStream = (opts: { text?: string; tool?: boolean; finish?: string; refusal?: string }) =>
  `${sse([
    { id: "c", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
    ...(opts.text !== undefined ? [{ id: "c", choices: [{ index: 0, delta: { content: opts.text } }] }] : []),
    ...(opts.refusal ? [{ id: "c", choices: [{ index: 0, delta: { refusal: opts.refusal } }] }] : []),
    ...(opts.tool
      ? [{ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "x", function: { name: "sh", arguments: "" } }] } }] }]
      : []),
    {
      id: "c",
      choices: [{ index: 0, delta: {}, finish_reason: opts.finish ?? "stop" }],
      usage: { prompt_tokens: 30, completion_tokens: 4 },
    },
  ])}data: [DONE]\n\n`;

const responsesStream = (opts: { text?: string; tool?: boolean; status?: string; reason?: string }) => {
  const output = [
    ...(opts.text !== undefined ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: opts.text }] }] : []),
    ...(opts.tool ? [{ type: "function_call", name: "shell", call_id: "c1", arguments: "{}" }] : []),
  ];
  const status = opts.status ?? "completed";
  const terminal = status === "completed" ? "response.completed" : `response.${status}`;
  return sse([
    { type: "response.created", response: { id: "r", model: "m", status: "in_progress", output: [] } },
    ...(opts.text ? [{ type: "response.output_text.delta", delta: opts.text }] : []),
    ...(opts.tool ? [{ type: "response.output_item.added", item: output[output.length - 1] }] : []),
    {
      type: terminal,
      response: {
        id: "r",
        model: "m",
        status,
        output,
        ...(opts.reason ? { incomplete_details: { reason: opts.reason } } : {}),
        usage: { input_tokens: 40, output_tokens: 5 },
      },
    },
  ]);
};

describe("assessResponse: HTTP status", () => {
  test("429, 5xx and 529 are upstream errors; other 4xx are not a cascade case", () => {
    for (const status of [429, 500, 503, 529])
      expect(assessResponse({ dialect: "anthropic", status, contentType: JSON_CT, body: "{}" })).toMatchObject({
        ok: false,
        trigger: "upstream_error",
        detail: `HTTP ${status}`,
      });
    expect(assessResponse({ dialect: "anthropic", status: 400, contentType: JSON_CT, body: "{}" })).toEqual({ ok: true });
    expect(assessResponse({ dialect: "anthropic", status: 529, contentType: JSON_CT, body: "{}", on: ["empty"] })).toEqual({ ok: true });
  });
});

describe("assessResponse: anthropic", () => {
  const assess = (body: string, on?: Parameters<typeof assessResponse>[0]["on"]) =>
    assessResponse({ dialect: "anthropic", status: 200, contentType: SSE, body, ...(on ? { on } : {}) });

  test("text or a tool call is a good answer; thinking alone is empty", () => {
    expect(assess(anthropicStream({ text: "Here is the fix." }))).toEqual({ ok: true });
    expect(assess(anthropicStream({ tool: true }))).toEqual({ ok: true });
    expect(assess(anthropicStream({ thinking: true }))).toMatchObject({ ok: false, trigger: "empty" });
    expect(assess(anthropicStream({ text: "   " }))).toMatchObject({ ok: false, trigger: "empty" });
  });

  test("a mid-stream error event is an upstream error", () => {
    const body = `${anthropicStream({ text: "partial" }).split("event: message_delta")[0]}${sse([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }])}`;
    expect(assess(body)).toMatchObject({ ok: false, trigger: "upstream_error", detail: "error event: overloaded_error" });
  });

  test("short refusals trigger, long answers and tool calls do not", () => {
    expect(assess(anthropicStream({ text: "I can’t help with that." }))).toMatchObject({ ok: false, trigger: "refusal" });
    expect(assess(anthropicStream({ text: "As an AI, I won't do this." }))).toMatchObject({ ok: false, trigger: "refusal" });
    expect(assess(anthropicStream({ text: "I cannot find the file, so I will create it." }), ["empty"])).toEqual({ ok: true });
    expect(assess(anthropicStream({ text: `I cannot use that API. ${"Instead, here is the code. ".repeat(30)}` }))).toEqual({ ok: true });
    expect(assess(anthropicStream({ text: "I cannot run it directly.", tool: true }))).toEqual({ ok: true });
    expect(assess(anthropicStream({ text: "", stop: "refusal" }), ["refusal"])).toMatchObject({ ok: false, trigger: "refusal" });
  });

  test("max_tokens is truncated only when asked for", () => {
    const body = anthropicStream({ text: "def f(", stop: "max_tokens" });
    expect(assess(body)).toMatchObject({ ok: false, trigger: "truncated", detail: "stop reason max_tokens" });
    expect(assess(body, ["upstream_error", "empty"])).toEqual({ ok: true });
  });

  test("non-stream JSON messages", () => {
    const msg = (content: unknown[], stop = "end_turn") =>
      JSON.stringify({ type: "message", model: "m", content, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } });
    const json = (body: string) => assessResponse({ dialect: "anthropic", status: 200, contentType: JSON_CT, body });
    expect(json(msg([{ type: "text", text: "ok" }]))).toEqual({ ok: true });
    expect(json(msg([]))).toMatchObject({ ok: false, trigger: "empty" });
    expect(json(msg([{ type: "tool_use", id: "t", name: "Bash", input: {} }]))).toEqual({ ok: true });
    expect(json(msg([{ type: "text", text: "x" }], "max_tokens"))).toMatchObject({ trigger: "truncated" });
    expect(json("not json")).toEqual({ ok: true });
  });
});

describe("assessResponse: openai chat", () => {
  const assess = (body: string) => assessResponse({ dialect: "openai-chat", status: 200, contentType: SSE, body });
  test("content, tool calls, refusals, length, and error chunks", () => {
    expect(assess(chatStream({ text: "done" }))).toEqual({ ok: true });
    expect(assess(chatStream({ tool: true }))).toEqual({ ok: true });
    expect(assess(chatStream({}))).toMatchObject({ ok: false, trigger: "empty" });
    expect(assess(chatStream({ refusal: "I'm sorry, I can't assist." }))).toMatchObject({ ok: false, trigger: "refusal" });
    expect(assess(chatStream({ text: "I'm unable to do that." }))).toMatchObject({ ok: false, trigger: "refusal" });
    expect(assess(chatStream({ text: "partial", finish: "length" }))).toMatchObject({ ok: false, trigger: "truncated" });
    expect(assess(sse([{ error: { code: "server_error", message: "boom" } }]))).toMatchObject({ trigger: "upstream_error" });
  });

  test("non-stream completions", () => {
    const body = JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "x" }] } }] });
    expect(assessResponse({ dialect: "openai-chat", status: 200, contentType: JSON_CT, body })).toEqual({ ok: true });
    const empty = JSON.stringify({ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] });
    expect(assessResponse({ dialect: "openai-chat", status: 200, contentType: JSON_CT, body: empty })).toMatchObject({ trigger: "empty" });
  });
});

describe("assessResponse: openai responses", () => {
  const assess = (body: string) => assessResponse({ dialect: "openai-responses", status: 200, contentType: SSE, body });
  test("completed output items, function calls, incomplete, failed", () => {
    expect(assess(responsesStream({ text: "ok" }))).toEqual({ ok: true });
    expect(assess(responsesStream({ tool: true }))).toEqual({ ok: true });
    expect(assess(responsesStream({}))).toMatchObject({ ok: false, trigger: "empty" });
    expect(assess(responsesStream({ text: "cut", status: "incomplete", reason: "max_output_tokens" }))).toMatchObject({
      trigger: "truncated",
      detail: "stop reason max_output_tokens",
    });
    expect(assess(responsesStream({ status: "failed" }))).toMatchObject({ trigger: "upstream_error" });
    expect(assess(sse([{ type: "error", code: "rate_limit_exceeded", message: "slow down" }]))).toMatchObject({
      trigger: "upstream_error",
    });
  });

  test("non-stream response objects", () => {
    const body = JSON.stringify({ object: "response", status: "completed", output: [] });
    expect(assessResponse({ dialect: "openai-responses", status: 200, contentType: JSON_CT, body })).toMatchObject({ trigger: "empty" });
  });
});

describe("usageFromBody", () => {
  test("folds usage from each dialect's stream and from JSON bodies", () => {
    expect(usageFromBody(true, anthropicStream({ text: "x" }))).toEqual({ inputTokens: 20, outputTokens: 9 });
    expect(usageFromBody(true, chatStream({ text: "x" }))).toEqual({ inputTokens: 30, outputTokens: 4 });
    expect(usageFromBody(true, responsesStream({ text: "x" }))).toEqual({ inputTokens: 40, outputTokens: 5 });
    expect(usageFromBody(false, JSON.stringify({ usage: { input_tokens: 3, output_tokens: 2 } }))).toEqual({
      inputTokens: 3,
      outputTokens: 2,
    });
    expect(usageFromBody(false, "nope")).toBeUndefined();
  });
});
