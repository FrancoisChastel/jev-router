import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { loadPolicy } from "../../src/core/policy";
import type { DecisionRecord } from "../../src/core/record";
import { type RunningDaemon, startDaemon } from "../../src/daemon";
import { MockJudge } from "../../src/judge/mock";
import type { Answer } from "../../src/judge/types";
import { minimalPolicy } from "../fixtures/policies";

interface Captured {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const midAnswers: Record<string, Answer> = {
  difficulty: { type: "score", score: 2.7, probabilities: {}, confidence: 0.9 },
  needs_reasoning: { type: "noul", noul: 0.4 },
  stakes: { type: "score", score: 1, probabilities: {}, confidence: 0.9 },
  output_kind: { type: "choice", choice: "code_edit", probabilities: { code_edit: 0.9 }, confidence: 0.9 },
  long_context: { type: "noul", noul: 0.1 },
};

const ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"anthropic/claude-sonnet-5","usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
  'event: ping\ndata: {"type":"ping"}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

let upstream: Server;
let upstreamUrl = "";
let captured: Captured[] = [];
let upstreamMode: "sse" | "json" | "error" = "sse";
let daemon: RunningDaemon;
let records: DecisionRecord[] = [];
const judge = new MockJudge(midAnswers);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
    });
    req.on("end", () => resolve(s));
  });
}

beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    const raw = await readBody(req);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(",") : String(v);
    captured.push({ method: req.method ?? "", path: req.url ?? "", headers, body: raw ? JSON.parse(raw) : undefined });
    if (upstreamMode === "error") {
      res.writeHead(400, { "content-type": "application/json", "x-should-retry": "false" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad thing" } }));
      return;
    }
    if (upstreamMode === "json" || req.url?.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "m1",
          model: "anthropic/claude-sonnet-5",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      );
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "anthropic-ratelimit-unified-status": "allowed",
    });
    for (const chunk of ANTHROPIC_SSE) {
      res.write(chunk);
      await new Promise((r) => setTimeout(r, 2));
    }
    res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const addr = upstream.address();
  upstreamUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";

  const raw = minimalPolicy();
  (raw as { egress?: unknown }).egress = { openrouter: { base_url: upstreamUrl, api_key_env: "TEST_UPSTREAM_KEY" } };
  for (const c of Object.values(raw.candidates)) (c as { via?: string }).via = "openrouter";
  raw.routes = [
    { id: "claude-code/auto", harness: "claude-code", policy: "default" },
    { id: "auto", harness: "any", policy: "default" },
  ];
  const policy = loadPolicy(raw);
  daemon = await startDaemon({
    policy,
    judge,
    env: { TEST_UPSTREAM_KEY: "up-secret" },
    log: (r) => {
      records.push(r);
    },
    host: "127.0.0.1",
    port: 0,
  });
});

afterAll(async () => {
  await daemon.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

const reset = () => {
  captured = [];
  records = [];
  upstreamMode = "sse";
};

const anthropicBody = (model = "claude-code/auto", extra: Record<string, unknown> = {}) => ({
  model,
  max_tokens: 64,
  stream: true,
  system: [
    { type: "text", text: "attribution block" },
    { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } },
  ],
  tools: [{ name: "Bash", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "refactor the payment module" }] }],
  ...extra,
});

describe("relay: anthropic messages", () => {
  test("rewrites the model, forwards anthropic headers and the system array untouched, and swaps auth", async () => {
    reset();
    const res = await fetch(`${daemon.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "context-1m-2025-08-07,interleaved-thinking",
        "x-api-key": "client-key",
        authorization: "Bearer client-token",
        "x-claude-code-session-id": "sess-1",
        "user-agent": "claude-cli/2.1.300 (external, cli)",
      },
      body: JSON.stringify(anthropicBody()),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-jev-router-model")).toBe("anthropic/claude-sonnet-5");
    expect(res.headers.get("x-jev-router-candidate")).toBe("mid");
    expect(res.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed");
    const text = await res.text();
    expect(text).toContain('"model":"claude-code/auto"');
    expect(text).not.toContain('"model":"anthropic/claude-sonnet-5"');
    expect(text).toContain('event: ping\ndata: {"type":"ping"}\n\n');
    expect(text.endsWith('event: message_stop\ndata: {"type":"message_stop"}\n\n')).toBe(true);

    const up = captured[0]!;
    expect(up.path).toBe("/v1/messages?beta=true");
    expect(up.headers["anthropic-version"]).toBe("2023-06-01");
    expect(up.headers["anthropic-beta"]).toBe("context-1m-2025-08-07,interleaved-thinking");
    expect(up.headers.authorization).toBe("Bearer up-secret");
    expect(up.headers["x-api-key"]).toBe("up-secret");
    expect(up.headers["accept-encoding"]).toBe("identity");
    const body = up.body as Record<string, unknown>;
    expect(body.model).toBe("anthropic/claude-sonnet-5");
    expect(JSON.stringify(body.system)).toBe(JSON.stringify(anthropicBody().system));
    expect(JSON.stringify(body.messages)).toBe(JSON.stringify(anthropicBody().messages));

    expect(records).toHaveLength(1);
    expect(records[0]!.decision).toMatchObject({ candidate: "mid", source: "judge" });
    expect(records[0]!.apply).toMatchObject({ ok: true });
    expect(records[0]!.usage).toMatchObject({ inputTokens: 12, outputTokens: 7 });
    expect(records[0]!.session).toBe("cc:sess-1");
  });

  test("a second request in the same session reuses the lease without a judge call", async () => {
    reset();
    const before = judge.requests.length;
    const continuation = anthropicBody("claude-code/auto", {
      messages: [
        { role: "user", content: [{ type: "text", text: "refactor the payment module" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
    });
    const res = await fetch(`${daemon.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-1" },
      body: JSON.stringify(continuation),
    });
    await res.text();
    expect(judge.requests.length).toBe(before);
    expect(records[0]!.decision.source).toBe("lease");
  });

  test("auxiliary request class is pinned to the cheap tier without the judge", async () => {
    reset();
    const before = judge.requests.length;
    const res = await fetch(`${daemon.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-aux", "x-claude-code-request-class": "auxiliary" },
      body: JSON.stringify(anthropicBody()),
    });
    await res.text();
    expect(judge.requests.length).toBe(before);
    expect(records[0]!.decision).toMatchObject({ candidate: "fast", source: "rules" });
    expect(records[0]!.requestClass).toBe("auxiliary");
  });

  test("non-streaming JSON responses echo the requested model", async () => {
    reset();
    upstreamMode = "json";
    const res = await fetch(`${daemon.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-json" },
      body: JSON.stringify(anthropicBody("claude-code/auto", { stream: false })),
    });
    const json = (await res.json()) as { model: string; usage: unknown };
    expect(json.model).toBe("claude-code/auto");
    expect(records[0]!.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
  });

  test("upstream errors pass through unmodified and do not commit the session", async () => {
    reset();
    upstreamMode = "error";
    const res = await fetch(`${daemon.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-err" },
      body: JSON.stringify(anthropicBody()),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("x-should-retry")).toBe("false");
    expect(await res.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "bad thing" } });
    expect(records[0]!.apply).toMatchObject({ ok: false });
  });

  test("unknown model ids pass through to the default egress unchanged", async () => {
    reset();
    upstreamMode = "json";
    const res = await fetch(`${daemon.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(anthropicBody("claude-opus-5-5", { stream: false })),
    });
    expect(res.status).toBe(200);
    expect((captured[0]!.body as { model: string }).model).toBe("claude-opus-5-5");
    expect(res.headers.get("x-jev-router-source")).toBe("passthrough");
    expect(records).toHaveLength(0);
  });

  test("count_tokens is forwarded", async () => {
    reset();
    const res = await fetch(`${daemon.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-code/auto", messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(captured[0]!.path).toBe("/v1/messages/count_tokens");
  });
});

describe("relay: openai dialects", () => {
  test("responses dialect rewrites model and reasoning effort", async () => {
    reset();
    upstreamMode = "json";
    const body = {
      model: "auto",
      stream: false,
      reasoning: { effort: "low" },
      input: [{ role: "user", content: [{ type: "input_text", text: "migrate the auth schema carefully" }] }],
    };
    const res = await fetch(`${daemon.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", originator: "codex_cli_rs", session_id: "cx-1" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(captured[0]!.path).toBe("/v1/responses");
    const up = captured[0]!.body as { model: string; reasoning: { effort: string } };
    expect(up.model).toBe("anthropic/claude-sonnet-5");
    expect(records[0]!.harness).toBe("codex");
    expect(records[0]!.session).toBe("codex:cx-1");
  });

  test("chat completions dialect routes and echoes", async () => {
    reset();
    upstreamMode = "json";
    const res = await fetch(`${daemon.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "pi-1" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(res.status).toBe(200);
    expect(captured[0]!.path).toBe("/v1/chat/completions");
    expect(((await res.json()) as { model: string }).model).toBe("auto");
    expect(records[0]!.session).toBe("sid:pi-1");
  });
});

describe("daemon endpoints", () => {
  test("model listing, hello probe, and health", async () => {
    const models = (await (await fetch(`${daemon.url}/v1/models?limit=1000`)).json()) as {
      data: { id: string; display_name?: string; object?: string }[];
    };
    expect(models.data.map((m) => m.id).sort()).toEqual(["auto", "claude-code/auto"]);
    expect(models.data[0]!.object).toBe("model");
    expect((await fetch(`${daemon.url}/api/hello`, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(`${daemon.url}/healthz`)).status).toBe(200);
  });

  test("/observe compaction escalates the next relay request and /decide answers plugins", async () => {
    reset();
    await fetch(`${daemon.url}/observe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: "cc:sess-1", event: "compaction" }),
    });
    const res = await fetch(`${daemon.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-1" },
      body: JSON.stringify(anthropicBody()),
    });
    await res.text();
    expect(records[0]!.decision.source).toBe("override");

    const decide = await fetch(`${daemon.url}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        harness: "hermes",
        sessionKey: "h-1",
        request: { isNewUserTurn: true, lastUserText: "write a haiku", toolNames: [], hasImages: false, toolOutcomes: [] },
      }),
    });
    expect(decide.status).toBe(200);
    const out = (await decide.json()) as { decision: { candidate: string; model: string } };
    expect(out.decision.model).toBeDefined();
  });

  test("malformed JSON gets a dialect-shaped 400", async () => {
    const res = await fetch(`${daemon.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
  });
});

describe("native hook ingest", () => {
  test("claude code hook payloads are accepted and feed the next relay decision", async () => {
    reset();
    const body = {
      session_id: "hook-sess",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_use_error: "exit 1",
      cwd: "/",
      transcript_path: "/t",
    };
    for (let i = 0; i < 3; i += 1) {
      const r = await fetch(`${daemon.url}/hooks/claude-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({});
    }
    const res = await fetch(`${daemon.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": "hook-sess" },
      body: JSON.stringify(anthropicBody()),
    });
    await res.text();
    expect(["override", "signals", "judge"]).toContain(records[0]!.decision.source);
    expect(records[0]!.signals?.severity).toBeGreaterThan(0.9);
  });

  test("unknown hook events are acknowledged without effect and bad JSON is a 400", async () => {
    const r = await fetch(`${daemon.url}/hooks/codex`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "x", hook_event_name: "Stop" }),
    });
    expect(r.status).toBe(200);
    const bad = await fetch(`${daemon.url}/hooks/claude-code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "nope",
    });
    expect(bad.status).toBe(400);
  });
});

describe("token gate", () => {
  test("a non-loopback bind without a token is refused, and a token guards every endpoint but health", async () => {
    await expect(startDaemon({ policy: loadPolicy(minimalPolicy()), port: 0, host: "0.0.0.0" })).rejects.toThrow(/token/);
    const guarded = await startDaemon({ policy: loadPolicy(minimalPolicy()), port: 0, token: "s3cret" });
    try {
      expect((await fetch(`${guarded.url}/healthz`)).status).toBe(200);
      expect((await fetch(`${guarded.url}/v1/models`)).status).toBe(401);
      expect((await fetch(`${guarded.url}/v1/models`, { headers: { authorization: "Bearer s3cret" } })).status).toBe(200);
      expect((await fetch(`${guarded.url}/v1/models`, { headers: { "x-api-key": "s3cret" } })).status).toBe(200);
    } finally {
      await guarded.close();
    }
  });
});

describe("shadow mode", () => {
  test("serves the pinned candidate while logging the router's decision", async () => {
    reset();
    upstreamMode = "json";
    const shadowRecords: DecisionRecord[] = [];
    const raw = minimalPolicy();
    (raw as { egress?: unknown }).egress = { openrouter: { base_url: upstreamUrl, api_key_env: "TEST_UPSTREAM_KEY" } };
    for (const c of Object.values(raw.candidates)) (c as { via?: string }).via = "openrouter";
    const shadowDaemon = await startDaemon({
      policy: loadPolicy(raw),
      judge,
      env: { TEST_UPSTREAM_KEY: "k" },
      log: (r) => {
        shadowRecords.push(r);
      },
      port: 0,
      shadow: "fast",
    });
    try {
      const res = await fetch(`${shadowDaemon.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-claude-code-session-id": "shadow-1" },
        body: JSON.stringify(anthropicBody("auto", { stream: false })),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-jev-router-source")).toBe("shadow");
      expect(res.headers.get("x-jev-router-candidate")).toBe("fast");
      expect(res.headers.get("x-jev-router-decision")).toBe("mid");
      expect((captured.at(-1)!.body as { model: string }).model).toBe("openai/gpt-5.4-mini");
      expect(shadowRecords[0]!.decision.candidate).toBe("mid");
      expect(shadowRecords[0]!.shadow).toEqual({ served: "fast" });
    } finally {
      await shadowDaemon.close();
    }
  });
});
