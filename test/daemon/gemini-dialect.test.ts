import { describe, expect, test } from "bun:test";
import { resolveSessionKey } from "../../src/core/session";
import { classifyTool } from "../../src/core/signals/tool-semantics";
import type { Decision } from "../../src/core/types";
import { geminiDialect, geminiModelFromPath } from "../../src/daemon/dialects/gemini";
import { geminiCodeAssistDialect } from "../../src/daemon/dialects/gemini-code-assist";
import { geminiHookToObserve } from "../../src/daemon/hooks";
import { detectHarness, errorBody, mergeUsage, upstreamHeaders, usageOf } from "../../src/daemon/http-util";
import { createSseTransform } from "../../src/daemon/sse";
import { codeAssistSse, codeAssistTurn, firstTurn, GEMINI_UA, geminiSse, readErrorTurn, toolTurn } from "../fixtures/gemini";

const STREAM_PATH = "/v1beta/models/jev-router/auto:streamGenerateContent";

const decision = (model: string, effort?: Decision["effort"]): Decision => ({
  candidate: "gemini-flash",
  model,
  source: "rules",
  reasons: [],
  counterfactuals: {},
  lease: "tool_chain",
  ...(effort ? { effort } : {}),
});

describe("gemini dialect", () => {
  test("reads the model from the path, slashes included, and the stream flag from the method", () => {
    expect(geminiModelFromPath(STREAM_PATH)).toBe("jev-router/auto");
    expect(geminiModelFromPath("/v1/models/gemini-3.8-flash:generateContent")).toBe("gemini-3.8-flash");
    expect(geminiModelFromPath("/v1beta/models/gemini-3.8-flash:countTokens")).toBeUndefined();
    const n = geminiDialect.normalize(firstTurn, STREAM_PATH);
    expect(n.requestedModel).toBe("jev-router/auto");
    expect(n.stream).toBe(true);
    expect(geminiDialect.normalize(firstTurn, "/v1beta/models/x:generateContent").stream).toBe(false);
  });

  test("a first turn is a new user turn with its text, tools, and a prefix digest input", () => {
    const n = geminiDialect.normalize(firstTurn, STREAM_PATH);
    expect(n.isNewUserTurn).toBe(true);
    expect(n.lastUserText).toContain("list /nonexistent-dir-xyz with ls");
    expect(n.toolNames).toEqual(["read_file", "replace", "run_shell_command"]);
    expect(n.toolOutcomes).toEqual([]);
    expect(n.hasImages).toBe(false);
    expect(n.requestedEffort).toBeUndefined();
    expect(n.sessionKey).toBeUndefined();
    expect(n.prefixDigestInput.startsWith("You are Gemini CLI")).toBe(true);
    expect(n.prefixDigestInput).toContain("list /nonexistent-dir-xyz");
  });

  test("trailing functionResponse parts are tool outcomes; a shell exit code or response.error is a failure", () => {
    const n = geminiDialect.normalize(toolTurn, STREAM_PATH);
    expect(n.isNewUserTurn).toBe(false);
    expect(n.assistantIntentTail).toBe("I will list it.");
    expect(n.lastUserText).toContain("list /nonexistent-dir-xyz");
    expect(n.toolOutcomes).toHaveLength(1);
    expect(n.toolOutcomes[0]).toMatchObject({ name: "run_shell_command", isError: true });
    expect(n.toolOutcomes[0]?.errorText).toContain("Exit Code: 1");

    const m = geminiDialect.normalize(readErrorTurn, STREAM_PATH);
    expect(m.toolOutcomes).toEqual([
      { name: "read_file", isError: true, errorText: "File not found: a.ts" },
      { name: "read_file", isError: false, excerpt: "export const b = 1;" },
    ]);
  });

  test("images arrive as inlineData or fileData parts", () => {
    const withImage = {
      ...firstTurn,
      contents: [{ role: "user", parts: [{ text: "what is this" }, { inlineData: { mimeType: "image/png", data: "" } }] }],
    };
    expect(geminiDialect.normalize(withImage, STREAM_PATH).hasImages).toBe(true);
  });

  test("routing rewrites only the model in the path; the body is untouched without a thinkingLevel", () => {
    expect(geminiDialect.rewritePath?.(STREAM_PATH, decision("gemini-3.8-flash"))).toBe(
      "/v1beta/models/gemini-3.8-flash:streamGenerateContent",
    );
    expect(geminiDialect.rewritePath?.("/v1beta/models/x:countTokens", decision("y"))).toBe("/v1beta/models/x:countTokens");
    expect(geminiDialect.rewrite(firstTurn, decision("gemini-3.8-flash", "high"))).toBe(firstTurn);
  });

  test("a thinkingLevel the client sent is read as effort and rewritten to the decided one", () => {
    const body = { ...firstTurn, generationConfig: { temperature: 1, thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" } } };
    expect(geminiDialect.normalize(body, STREAM_PATH).requestedEffort).toBe("high");
    const out = geminiDialect.rewrite(body, decision("gemini-3.1-flash-lite", "minimal"));
    expect(out.generationConfig).toEqual({ temperature: 1, thinkingConfig: { includeThoughts: true, thinkingLevel: "MINIMAL" } });
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("HIGH");
    const max = geminiDialect.rewrite(body, decision("gemini-3.1-pro-preview", "max"));
    expect((max.generationConfig as { thinkingConfig: { thinkingLevel: string } }).thinkingConfig.thinkingLevel).toBe("HIGH");
  });

  test("echoModel sets modelVersion to the requested id", () => {
    expect(geminiDialect.echoModel({ candidates: [], modelVersion: "gemini-3.8-flash" }, "jev-router/auto")).toEqual({
      candidates: [],
      modelVersion: "jev-router/auto",
    });
    const plain = { candidates: [] };
    expect(geminiDialect.echoModel(plain, "jev-router/auto")).toBe(plain);
  });
});

describe("gemini code assist dialect", () => {
  test("reads the model from the body and keys the session on request.session_id", () => {
    const n = geminiCodeAssistDialect.normalize(codeAssistTurn, "/v1internal:streamGenerateContent");
    expect(n.requestedModel).toBe("jev-router/auto");
    expect(n.stream).toBe(true);
    expect(n.isNewUserTurn).toBe(true);
    expect(n.sessionKey).toBe("gemini:b768a5d1-d830-4b69-aee1-e4e91b469cad");
    expect(n.toolNames).toEqual(["read_file", "replace", "run_shell_command"]);
  });

  test("rewrites the body model and nothing else; echo reaches into the response wrapper", () => {
    const out = geminiCodeAssistDialect.rewrite(codeAssistTurn, decision("gemini-3-flash"));
    expect(out).toEqual({ ...codeAssistTurn, model: "gemini-3-flash" });
    expect(out.request).toEqual(codeAssistTurn.request);
    expect(geminiCodeAssistDialect.rewritePath).toBeUndefined();
    expect(geminiCodeAssistDialect.echoModel({ response: { modelVersion: "gemini-3-flash" }, traceId: "t" }, "jev-router/auto")).toEqual({
      response: { modelVersion: "jev-router/auto" },
      traceId: "t",
    });
  });
});

async function pipe(input: string, requestedModel: string): Promise<{ out: string; usage: Record<string, unknown>[]; terminal: number }> {
  const usage: Record<string, unknown>[] = [];
  let terminal = 0;
  const t = createSseTransform({ requestedModel, onUsage: (u) => usage.push(u), onTerminal: () => (terminal += 1) });
  const stream = new Response(input).body?.pipeThrough(t);
  const out = await new Response(stream).text();
  return { out, usage, terminal };
}

describe("gemini streams", () => {
  test("modelVersion is echoed, CRLF framing kept, usageMetadata reported, finishReason ends the stream", async () => {
    const { out, usage, terminal } = await pipe(geminiSse("gemini-3.8-flash"), "jev-router/auto");
    expect(out).not.toContain("gemini-3.8-flash");
    expect(out.match(/"modelVersion":"jev-router\/auto"/g)).toHaveLength(2);
    expect(out.split("\r\n\r\n")).toHaveLength(3);
    expect(usage).toHaveLength(2);
    expect(terminal).toBe(1);
    const merged = usage.reduce((acc, u) => mergeUsage(acc, u), mergeUsage(undefined, {}));
    expect(merged).toEqual({ inputTokens: 120, outputTokens: 20, cacheReadTokens: 100 });
  });

  test("the Code Assist wrapper is rewritten and metered too", async () => {
    const { out, usage, terminal } = await pipe(codeAssistSse("gemini-3-flash"), "jev-router/auto");
    expect(JSON.parse(out.slice("data: ".length).trim()).response.modelVersion).toBe("jev-router/auto");
    expect(usage[0]).toMatchObject({ promptTokenCount: 120 });
    expect(terminal).toBe(1);
  });

  test("usageOf finds usageMetadata at the top level and under response", () => {
    expect(usageOf({ usageMetadata: { promptTokenCount: 1 } })).toEqual({ promptTokenCount: 1 });
    expect(usageOf({ response: { usageMetadata: { promptTokenCount: 2 } } })).toEqual({ promptTokenCount: 2 });
    expect(usageOf({ usage: { input_tokens: 3 } })).toEqual({ input_tokens: 3 });
    expect(usageOf({})).toBeUndefined();
  });
});

describe("gemini harness plumbing", () => {
  test("the Gemini CLI user agent, in every form it takes, is the gemini harness", () => {
    expect(detectHarness({ "user-agent": GEMINI_UA })).toBe("gemini");
    expect(detectHarness({ "user-agent": "GeminiCLI/0.62.0/gemini-3.8-flash (linux; x64; terminal)" })).toBe("gemini");
    expect(
      detectHarness({ "user-agent": "CloudCodeVSCode/0.62.0 (aidev_client; os_type=macOS; host_path=VSCode/1.1; proxy_client=geminicli)" }),
    ).toBe("gemini");
  });

  test("an API key goes upstream as x-goog-api-key, replacing the client's; a forwarded login is kept", () => {
    const incoming = { "x-goog-api-key": "client-key", "user-agent": GEMINI_UA, "x-goog-api-client": "google-genai-sdk/1.30.0" };
    const injected = upstreamHeaders(incoming, { apiKey: "relay-key", forwardAuth: false, dialect: "gemini" });
    expect(injected["x-goog-api-key"]).toBe("relay-key");
    expect(injected.authorization).toBeUndefined();
    expect(injected["x-goog-api-client"]).toBe("google-genai-sdk/1.30.0");
    const forwarded = upstreamHeaders(
      { authorization: "Bearer ya29.login", "x-goog-api-key": "k" },
      { forwardAuth: true, dialect: "gemini-code-assist" },
    );
    expect(forwarded.authorization).toBe("Bearer ya29.login");
    expect(forwarded["x-goog-api-key"]).toBe("k");
    // Other dialects never leak a client's Google key upstream.
    expect(upstreamHeaders({ "x-goog-api-key": "k" }, { apiKey: "o", forwardAuth: false, dialect: "openai-chat" })["x-goog-api-key"]).toBe(
      undefined,
    );
  });

  test("errors in the Gemini dialects use Google's error shape", () => {
    expect(JSON.parse(errorBody("gemini", 502, "no egress"))).toEqual({
      error: { code: 502, message: "no egress", status: "UNAVAILABLE" },
    });
  });

  test("a session key in the body wins over the prefix digest but not over harness headers", () => {
    expect(resolveSessionKey({}, "d", "gemini:s1")).toEqual({ key: "gemini:s1", source: "body" });
    expect(resolveSessionKey({}, "d")).toEqual({ key: "prefix:d", source: "prefix" });
    expect(resolveSessionKey({ "x-session-id": "p" }, "d", "gemini:s1").key).toBe("sid:p");
  });

  test("Gemini CLI tools map onto the tool classes", () => {
    expect(classifyTool("read_file", "gemini")).toBe("observe");
    expect(classifyTool("grep_search", "gemini")).toBe("observe");
    expect(classifyTool("replace", "gemini")).toBe("mutate");
    expect(classifyTool("write_file", "gemini")).toBe("mutate");
    expect(classifyTool("run_shell_command", "gemini")).toBe("shell");
    expect(classifyTool("write_todos", "gemini")).toBe("plan");
    expect(classifyTool("invoke_agent", "gemini")).toBe("plan");
  });
});

describe("gemini hooks", () => {
  const base = { session_id: "c78431d7", transcript_path: "/t.jsonl", cwd: "/w", timestamp: "2026-09-30T02:31:14.093Z" };

  test("AfterTool is a tool result; an error field or a shell exit code marks it failed", () => {
    // Captured payload shape.
    expect(
      geminiHookToObserve({
        ...base,
        hook_event_name: "AfterTool",
        tool_name: "run_shell_command",
        tool_input: { command: "ls /nonexistent-dir-xyz" },
        tool_response: {
          llmContent:
            "<untrusted_context>\nOutput: ls: /nonexistent-dir-xyz: No such file or directory\nExit Code: 1\n</untrusted_context>",
          returnDisplay: "ls: /nonexistent-dir-xyz: No such file or directory",
        },
      }),
    ).toMatchObject({ session: "gemini:c78431d7", event: "tool_result", tool: { name: "run_shell_command", isError: true } });
    expect(
      geminiHookToObserve({
        ...base,
        hook_event_name: "AfterTool",
        tool_name: "read_file",
        tool_response: { llmContent: "", error: { message: "File not found", type: "file_not_found" } },
      }),
    ).toEqual({ session: "gemini:c78431d7", event: "tool_result", tool: { name: "read_file", isError: true, text: "File not found" } });
    expect(
      geminiHookToObserve({ ...base, hook_event_name: "AfterTool", tool_name: "read_file", tool_response: { llmContent: "const a = 1;" } }),
    ).toEqual({ session: "gemini:c78431d7", event: "tool_result", tool: { name: "read_file", isError: false, text: "const a = 1;" } });
  });

  test("BeforeAgent is a prompt; PreCompress (fired every turn, compacted or not), other events, and missing sessions are ignored", () => {
    expect(geminiHookToObserve({ ...base, hook_event_name: "PreCompress", trigger: "auto" })).toBeUndefined();
    expect(geminiHookToObserve({ ...base, hook_event_name: "BeforeAgent", prompt: "hi" })).toEqual({
      session: "gemini:c78431d7",
      event: "prompt",
    });
    expect(geminiHookToObserve({ ...base, hook_event_name: "SessionStart" })).toBeUndefined();
    expect(geminiHookToObserve({ hook_event_name: "AfterTool" })).toBeUndefined();
  });
});
