import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadPolicy } from "../../src/core/policy";
import type { DecisionRecord } from "../../src/core/record";
import { resolveSessionKey } from "../../src/core/session";
import { type RunningDaemon, startDaemon } from "../../src/daemon";
import { cursorUpstreamPath, isResponsesShaped } from "../../src/daemon/cursor";
import { detectHarness } from "../../src/daemon/http-util";
import { minimalPolicy } from "../fixtures/policies";

const CURSOR_UA = { "user-agent": "Cursor/1.0" };

describe("Cursor detection", () => {
  test("Cursor's backend user agent identifies the harness; look-alikes do not", () => {
    expect(detectHarness(CURSOR_UA)).toBe("cursor");
    expect(detectHarness({ "user-agent": "cursor/2.3" })).toBe("cursor");
    expect(detectHarness({ "user-agent": "Mozilla/5.0 Cursor/1.0" })).toBe("unknown");
    expect(detectHarness({ "user-agent": "OpenAI/JS 5.0" })).toBe("unknown");
  });

  test("with no Cursor session header, the session is keyed by the conversation prefix", () => {
    expect(resolveSessionKey(CURSOR_UA, "abc")).toEqual({ key: "prefix:abc", source: "prefix" });
  });
});

describe("Cursor request shapes", () => {
  test("OpenRouter chat completions go to its Cursor surface; other paths and egresses are untouched", () => {
    expect(cursorUpstreamPath("https://openrouter.ai/api", "/v1/chat/completions")).toBe("/v1/cursor/chat/completions");
    expect(cursorUpstreamPath("https://openrouter.ai/api", "/v1/responses")).toBe("/v1/responses");
    expect(cursorUpstreamPath("https://ai-gateway.vercel.sh", "/v1/chat/completions")).toBe("/v1/chat/completions");
    expect(cursorUpstreamPath("https://openrouter.ai.evil.example", "/v1/chat/completions")).toBe("/v1/chat/completions");
    expect(cursorUpstreamPath("not a url", "/v1/chat/completions")).toBe("/v1/chat/completions");
  });

  test("a Responses body is recognised by input without messages", () => {
    expect(isResponsesShaped({ input: [] })).toBe(true);
    expect(isResponsesShaped({ messages: [] })).toBe(false);
    expect(isResponsesShaped({ input: [], messages: [] })).toBe(false);
  });
});

describe("relay: Cursor through an OpenRouter egress", () => {
  let daemon: RunningDaemon;
  let calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  let records: DecisionRecord[] = [];

  beforeAll(async () => {
    const raw = minimalPolicy();
    raw.egress = { openrouter: { base_url: "https://openrouter.ai/api", api_key_env: "TEST_OR_KEY" } };
    for (const c of Object.values(raw.candidates)) c.via = "openrouter";
    raw.candidates.fast.default_effort = "low";
    raw.candidates.fast.effort = ["low", "medium"];
    const stub = async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ id: "c1", model: "openai/gpt-5.4-mini", choices: [], usage: { prompt_tokens: 3 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    daemon = await startDaemon({
      policy: loadPolicy(raw),
      env: { TEST_OR_KEY: "or-secret" },
      fetch: stub,
      log: (r) => records.push(r),
      port: 0,
      token: "relay-token",
    });
  });

  afterAll(async () => {
    await daemon.close();
  });

  const post = (body: Record<string, unknown>) =>
    fetch(`${daemon.url}/v1/chat/completions`, {
      method: "POST",
      headers: { ...CURSOR_UA, "content-type": "application/json", authorization: "Bearer relay-token" },
      body: JSON.stringify(body),
    });

  test("jev-router/auto routes as auto, goes to OpenRouter's Cursor surface with the real key, and echoes the model", async () => {
    calls = [];
    records = [];
    const res = await post({ model: "jev-router/auto", stream: false, messages: [{ role: "user", content: "rename a variable" }] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { model: string }).model).toBe("jev-router/auto");
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/cursor/chat/completions");
    expect(calls[0]?.auth).toBe("Bearer or-secret");
    expect(calls[0]?.body.model).toBe("openai/gpt-5.4-mini");
    expect(calls[0]?.body.reasoning_effort).toBe("low");
    expect(records[0]?.harness).toBe("cursor");
  });

  test("a Responses body on the chat path is read and rewritten as Responses", async () => {
    calls = [];
    records = [];
    const res = await post({
      model: "jev-router/auto",
      stream: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "fix the failing test" }] }],
      reasoning: { effort: "medium", summary: "auto" },
    });
    expect(res.status).toBe(200);
    const up = calls[0]?.body as { model: string; input: unknown[]; reasoning: Record<string, unknown>; reasoning_effort?: unknown };
    expect(up.model).toBe("openai/gpt-5.4-mini");
    expect(up.input).toHaveLength(1);
    // The requested effort is read from reasoning.effort (allowed for the candidate, so kept) and written back there.
    expect(up.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(up.reasoning_effort).toBeUndefined();
    expect(records[0]?.harness).toBe("cursor");
  });

  test("the token gate still applies to Cursor", async () => {
    const res = await fetch(`${daemon.url}/v1/chat/completions`, {
      method: "POST",
      headers: { ...CURSOR_UA, "content-type": "application/json" },
      body: JSON.stringify({ model: "jev-router/auto", messages: [] }),
    });
    expect(res.status).toBe(401);
  });
});

describe("CORS", () => {
  test("a guarded relay answers preflights and tags browser responses; it still needs the token", async () => {
    const guarded = await startDaemon({ policy: loadPolicy(minimalPolicy()), port: 0, token: "s3cret" });
    try {
      const pre = await fetch(`${guarded.url}/v1/chat/completions`, {
        method: "OPTIONS",
        headers: {
          origin: "vscode-file://vscode-app",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization",
        },
      });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe("*");
      expect(pre.headers.get("access-control-allow-headers")).toBe("authorization");
      const denied = await fetch(`${guarded.url}/v1/models`, { headers: { origin: "vscode-file://vscode-app" } });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("access-control-allow-origin")).toBe("*");
      const allowed = await fetch(`${guarded.url}/v1/models`, {
        headers: { origin: "vscode-file://vscode-app", authorization: "Bearer s3cret" },
      });
      expect(allowed.status).toBe(200);
    } finally {
      await guarded.close();
    }
  });

  test("a relay without a token never opts into CORS", async () => {
    const open = await startDaemon({ policy: loadPolicy(minimalPolicy()), port: 0 });
    try {
      const pre = await fetch(`${open.url}/v1/chat/completions`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      });
      expect(pre.status).toBe(404);
      expect(pre.headers.get("access-control-allow-origin")).toBeNull();
      const models = await fetch(`${open.url}/v1/models`, { headers: { origin: "https://evil.example" } });
      expect(models.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await open.close();
    }
  });
});
