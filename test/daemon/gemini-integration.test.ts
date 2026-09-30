import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { loadPolicy } from "../../src/core/policy";
import type { PolicyInput } from "../../src/core/policy/types";
import type { DecisionRecord } from "../../src/core/record";
import { type RunningDaemon, startDaemon } from "../../src/daemon";
import { assessResponse as assess } from "../../src/daemon/cascade/assess";
import { MockJudge } from "../../src/judge/mock";
import { geminiPolicyParts } from "../../src/runtime/gemini-defaults";
import { firstTurn, GEMINI_UA } from "../fixtures/gemini";

/**
 * Gemini next to the rest of the relay: the cascade re-addresses the model-in-path per tier, the egress `dialects`
 * filter keeps other formats off the Google egress (passthrough included), and the JSON content-type gate applies.
 */

interface Captured {
  readonly path: string;
  readonly headers: Record<string, string>;
}

let upstream: Server;
let upstreamUrl = "";
let captured: Captured[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
    });
    req.on("end", () => resolve(s));
  });
}

/** The cheapest Gemini tier answers with nothing, which the cascade reads as an empty reply. */
function geminiChunk(model: string): string {
  const parts = model === "gemini-3.1-flash-lite" ? [] : [{ text: "ok" }];
  const chunk = {
    candidates: [{ content: { parts, role: "model" }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 2 },
    modelVersion: model,
  };
  return `data: ${JSON.stringify(chunk)}\r\n\r\n`;
}

beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    await readBody(req);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(",") : String(v);
    const path = req.url ?? "";
    captured.push({ path, headers });
    if (path.startsWith("/google/")) {
      const model = /models\/([^:]+):/.exec(path)?.[1] ?? "none";
      res.setHeader("content-type", "text/event-stream");
      res.end(geminiChunk(model));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "m1", type: "message", model: "gateway-model", content: [{ type: "text", text: "hi" }], usage: {} }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const addr = upstream.address();
  upstreamUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

/** Google listed first on purpose: a passthrough must still not pick it for another wire format. */
function policy(): PolicyInput {
  const parts = geminiPolicyParts("api-key");
  const { fast, mid, frontier } = parts.tiers;
  return {
    version: 1,
    judge: { transport: "mock", timeout_ms: 1000, on_error: "fail_open", mode: "signals" },
    egress: {
      [parts.egressName]: { ...parts.egress, base_url: `${upstreamUrl}/google` },
      gateway: { base_url: `${upstreamUrl}/gateway`, api_key_env: "GATEWAY_KEY" },
    },
    candidates: parts.candidates,
    routes: [{ id: "auto", harness: "gemini", policy: "gemini" }],
    policies: {
      gemini: {
        default: fast,
        order: [fast, mid, frontier],
        rules: [],
        cascade: { enabled: true, on: ["empty"], max_retries: 1 },
      },
    },
  };
}

describe("cascade reads Gemini replies", () => {
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\r\n\r\n`;
  const chunk = (parts: unknown[], finishReason: string) => ({ candidates: [{ content: { parts, role: "model" }, finishReason }] });

  test("safety stops and blocked prompts are refusals, MAX_TOKENS is truncation, a function call is not empty", () => {
    const at = (dialect: "gemini" | "gemini-code-assist", body: string) =>
      assess({ dialect, status: 200, contentType: "text/event-stream", body });
    expect(at("gemini", sse(chunk([], "SAFETY")))).toMatchObject({ ok: false, trigger: "refusal" });
    expect(at("gemini", sse({ promptFeedback: { blockReason: "OTHER" } }))).toMatchObject({ ok: false, trigger: "refusal" });
    expect(at("gemini", sse(chunk([{ text: "partial" }], "MAX_TOKENS")))).toMatchObject({ ok: false, trigger: "truncated" });
    expect(at("gemini", sse(chunk([{ functionCall: { name: "read_file", args: {} } }], "STOP")))).toEqual({ ok: true });
    expect(at("gemini", sse(chunk([{ text: "thinking", thought: true }], "STOP")))).toMatchObject({ ok: false, trigger: "empty" });
    expect(at("gemini-code-assist", sse({ response: chunk([{ text: "a real answer" }], "STOP"), traceId: "t" }))).toEqual({ ok: true });
  });
});

describe("gemini with cascade, dialect filter, and the JSON gate", () => {
  let daemon: RunningDaemon;
  let records: DecisionRecord[] = [];
  beforeAll(async () => {
    daemon = await startDaemon({
      policy: loadPolicy(policy()),
      judge: new MockJudge({}),
      env: { GEMINI_API_KEY: "relay-gemini-key", GATEWAY_KEY: "relay-gateway-key" },
      port: 0,
      log: (r) => records.push(r),
    });
  });
  afterAll(() => daemon.close());

  test("each cascade attempt puts its own tier's model in the path", async () => {
    captured = [];
    records = [];
    const res = await fetch(`${daemon.url}/gemini/v1beta/models/jev-router/auto:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": GEMINI_UA },
      body: JSON.stringify(firstTurn),
    });
    const text = await res.text();
    expect(res.headers.get("x-jev-router-cascade")).toBe("gemini-lite->gemini-flash (empty)");
    expect(captured.map((c) => c.path)).toEqual([
      "/google/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?alt=sse",
      "/google/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
    ]);
    expect(captured.every((c) => c.headers["x-goog-api-key"] === "relay-gemini-key")).toBe(true);
    expect(text).toContain('"modelVersion":"jev-router/auto"');
    expect(text).toContain('"text":"ok"');
    expect(records[0]?.cascade?.served).toBe("gemini-flash");
  });

  test("an unrouted Anthropic request skips the Google egress even though it is listed first", async () => {
    captured = [];
    const res = await fetch(`${daemon.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "client" },
      body: JSON.stringify({ model: "claude-something", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-jev-router-egress")).toBe("gateway");
    expect(captured[0]?.path).toBe("/gateway/v1/messages");
    expect(captured[0]?.headers.authorization).toBe("Bearer relay-gateway-key");
    expect(captured[0]?.headers["x-goog-api-key"]).toBeUndefined();
  });

  test("an unrouted Gemini request outside the mount still reaches Google", async () => {
    captured = [];
    const res = await fetch(`${daemon.url}/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": GEMINI_UA },
      body: JSON.stringify(firstTurn),
    });
    await res.text();
    expect(res.headers.get("x-jev-router-egress")).toBe("google");
    expect(captured[0]?.path).toBe("/google/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse");
  });

  test("Gemini requests and /hooks/gemini pass the JSON content-type gate only as JSON", async () => {
    const plain = await fetch(`${daemon.url}/hooks/gemini`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ session_id: "s", hook_event_name: "BeforeAgent" }),
    });
    expect(plain.status).toBe(415);
    const json = await fetch(`${daemon.url}/hooks/gemini`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s", hook_event_name: "BeforeAgent" }),
    });
    expect(json.status).toBe(200);
    const inference = await fetch(`${daemon.url}/gemini/v1beta/models/jev-router/auto:generateContent`, {
      method: "POST",
      headers: { "content-type": "text/plain", "user-agent": GEMINI_UA },
      body: JSON.stringify(firstTurn),
    });
    expect(inference.status).toBe(415);
  });
});
