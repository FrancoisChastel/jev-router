import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadPolicy } from "../../src/core/policy";
import type { DecisionRecord } from "../../src/core/record";
import { type RunningDaemon, startDaemon } from "../../src/daemon";
import { summarize } from "../../src/measure/stats";
import { minimalPolicy, type TestPolicy } from "../fixtures/policies";

const FAST = "openai/gpt-5.4-mini";
const MID = "anthropic/claude-sonnet-5";
const FRONTIER = "openai/gpt-6-astra";

type Responder = (res: ServerResponse) => Promise<void> | void;

const sseEvent = (e: unknown) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`;

/** An Anthropic Messages stream: message_start with the upstream model, optional text, a stop reason, usage. */
function anthropicStream(model: string, opts: { text?: string; stop?: string; input?: number; output?: number } = {}): string[] {
  return [
    sseEvent({ type: "message_start", message: { id: "m", model, usage: { input_tokens: opts.input ?? 1000, output_tokens: 1 } } }),
    'event: ping\ndata: {"type":"ping"}\n\n',
    ...(opts.text !== undefined
      ? [
          sseEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
          sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: opts.text } }),
          sseEvent({ type: "content_block_stop", index: 0 }),
        ]
      : []),
    sseEvent({ type: "message_delta", delta: { stop_reason: opts.stop ?? "end_turn" }, usage: { output_tokens: opts.output ?? 100 } }),
    sseEvent({ type: "message_stop" }),
  ];
}

const streams =
  (chunks: readonly string[]): Responder =>
  async (res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "x-upstream-tag": "yes" });
    for (const chunk of chunks) {
      res.write(chunk);
      await new Promise((r) => setTimeout(r, 1));
    }
    res.end();
  };

const status =
  (code: number, body: unknown): Responder =>
  (res) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

let upstream: Server;
let upstreamUrl = "";
let script: Record<string, Responder> = {};
let calls: string[] = [];
const daemons: RunningDaemon[] = [];

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
    const body = JSON.parse(await readBody(req)) as { model: string };
    calls.push(body.model);
    const respond = script[body.model];
    if (respond) await respond(res);
    else status(500, { error: "unscripted model" })(res);
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const addr = upstream.address();
  upstreamUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
});

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.close()));
  script = {};
  calls = [];
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

interface Harness {
  readonly daemon: RunningDaemon;
  readonly records: DecisionRecord[];
  readonly policy: ReturnType<typeof loadPolicy>;
}

async function start(
  cascade: Record<string, unknown>,
  tweak: (p: TestPolicy) => void = () => undefined,
  shadow?: string,
): Promise<Harness> {
  const raw = minimalPolicy();
  raw.egress = { gw: { base_url: upstreamUrl, api_key_env: "K" } };
  for (const c of Object.values(raw.candidates)) c.via = "gw";
  (raw.policies.default as { cascade?: unknown }).cascade = { enabled: true, ...cascade };
  tweak(raw);
  const policy = loadPolicy(raw);
  const records: DecisionRecord[] = [];
  const daemon = await startDaemon({
    policy,
    env: { K: "secret" },
    log: (r) => {
      records.push(r);
    },
    port: 0,
    ...(shadow ? { shadow } : {}),
  });
  daemons.push(daemon);
  return { daemon, records, policy };
}

const ask = (d: RunningDaemon, session: string, extra: Record<string, unknown> = {}, path = "/v1/messages") =>
  fetch(`${d.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-code-session-id": session },
    body: JSON.stringify({
      model: "auto",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text: "rename the helper" }] }],
      ...extra,
    }),
  });

describe("cascade: retry one tier up", () => {
  test("an empty first answer is replaced by the next tier's, and both attempts are recorded and charged", async () => {
    const h = await start({});
    script = { [FAST]: streams(anthropicStream(FAST)), [MID]: streams(anthropicStream(MID, { text: "renamed it" })) };
    const res = await ask(h.daemon, "c-empty");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(calls).toEqual([FAST, MID]);
    expect(res.headers.get("x-jev-router-cascade")).toBe("fast->mid (empty)");
    expect(res.headers.get("x-jev-router-candidate")).toBe("mid");
    expect(res.headers.get("x-jev-router-decision")).toBe("fast");
    expect(text).toContain("renamed it");
    expect(text.match(/message_start/g)).toHaveLength(2); // one event line + one type field, from the retry only
    expect(text).not.toContain(FAST);
    expect(text).toContain('"model":"auto"');

    const record = h.records[0]!;
    expect(record.decision.candidate).toBe("fast");
    expect(record.cascade?.served).toBe("mid");
    expect(record.cascade?.attempts.map((a) => [a.candidate, a.outcome])).toEqual([
      ["fast", "empty"],
      ["mid", "served"],
    ]);
    // fast: 1000 in * 0.15/M + 100 out * 0.6/M ; mid: 1000 * 3/M + 100 * 15/M
    expect(record.cascade?.attempts[0]?.costUsd).toBeCloseTo(0.00021, 8);
    expect(record.cascade?.attempts[1]?.costUsd).toBeCloseTo(0.0045, 8);
    expect(record.usage).toEqual({ inputTokens: 2000, outputTokens: 200 });
    expect(record.apply).toEqual({ ok: true });
    expect(h.daemon.store.get("cc:c-empty")?.current?.candidate).toBe("mid");
    // Cache-aware switching sees the served attempt's usage, the model the session now continues on.
    expect(h.daemon.store.get("cc:c-empty")?.lastUsage).toEqual({ inputTokens: 1000, outputTokens: 100 });

    const stats = summarize(h.records, h.policy);
    expect(stats.actualCostUsd).toBeCloseTo(0.00021 + 0.0045, 8);
    expect(stats.cascades.retries).toBe(1);
  });

  test("a 529 overloaded answer is retried on the next tier", async () => {
    const h = await start({});
    script = {
      [FAST]: status(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
      [MID]: streams(anthropicStream(MID, { text: "done" })),
    };
    const res = await ask(h.daemon, "c-529");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("done");
    expect(res.headers.get("x-jev-router-cascade")).toBe("fast->mid (upstream_error)");
    expect(h.records[0]!.cascade?.attempts[0]).toMatchObject({ candidate: "fast", outcome: "upstream_error", detail: "HTTP 529" });
    expect(h.records[0]!.cascade?.attempts[0]?.costUsd).toBeUndefined();
  });

  test("non-stream JSON bodies are assessed too", async () => {
    const h = await start({});
    script = {
      [FAST]: status(200, {
        type: "message",
        model: FAST,
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 0 },
      }),
      [MID]: status(200, {
        type: "message",
        model: MID,
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    };
    const res = await ask(h.daemon, "c-json", { stream: false });
    const json = (await res.json()) as { model: string; content: unknown[] };
    expect(json.model).toBe("auto");
    expect(json.content).toEqual([{ type: "text", text: "ok" }]);
    expect(h.records[0]!.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  test("a short refusal is retried when refusal is a trigger", async () => {
    const h = await start({ on: ["refusal"] });
    script = {
      [FAST]: streams(anthropicStream(FAST, { text: "I can't help with that request." })),
      [MID]: streams(anthropicStream(MID, { text: "Here is the rename." })),
    };
    const res = await ask(h.daemon, "c-refusal");
    expect(await res.text()).toContain("Here is the rename.");
    expect(res.headers.get("x-jev-router-cascade")).toBe("fast->mid (refusal)");
  });

  test("truncated triggers only when listed in `on`", async () => {
    const cut = anthropicStream(FAST, { text: "def rename(", stop: "max_tokens" });
    const on = await start({ on: ["upstream_error", "empty", "truncated"] });
    script = { [FAST]: streams(cut), [MID]: streams(anthropicStream(MID, { text: "def rename(): pass" })) };
    const retried = await ask(on.daemon, "c-trunc-on");
    expect(await retried.text()).toContain("def rename(): pass");
    expect(retried.headers.get("x-jev-router-cascade")).toBe("fast->mid (truncated)");

    calls = [];
    const off = await start({});
    const kept = await ask(off.daemon, "c-trunc-off");
    expect(await kept.text()).toContain("def rename(");
    expect(calls).toEqual([FAST]);
    expect(kept.headers.get("x-jev-router-cascade")).toBeNull();
    expect(off.records[0]!.cascade).toBeUndefined();
    expect(off.records[0]!.usage).toEqual({ inputTokens: 1000, outputTokens: 100 });
  });

  test("with retries exhausted the last response is returned, even an error", async () => {
    const h = await start({});
    script = { [FAST]: streams(anthropicStream(FAST)), [MID]: status(503, { error: "down" }) };
    const res = await ask(h.daemon, "c-exhausted");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "down" });
    expect(h.records[0]!.apply).toMatchObject({ ok: false });
    expect(h.records[0]!.cascade?.served).toBe("mid");
    expect(h.daemon.store.get("cc:c-exhausted")).toBeUndefined();
  });

  test("an unreachable final tier falls back to the response already held", async () => {
    const h = await start({ max_retries: 2 }, (p) => {
      p.egress = { ...p.egress, dead: { base_url: "http://127.0.0.1:9", api_key_env: "K" } };
      p.candidates.frontier.via = "dead";
    });
    script = { [FAST]: streams(anthropicStream(FAST)), [MID]: streams(anthropicStream(MID, { text: "  " })) };
    const res = await ask(h.daemon, "c-fallback");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"text":"  "');
    expect(calls).toEqual([FAST, MID]);
    expect(res.headers.get("x-jev-router-cascade")).toBe("fast->mid (empty)->frontier (empty); served mid");
    expect(h.records[0]!.cascade?.attempts.map((a) => a.outcome)).toEqual(["empty", "empty", "unreachable"]);
    expect(h.records[0]!.cascade?.served).toBe("mid");
  });

  test("buffer: false retries upstream errors but streams answers without assessing them", async () => {
    const h = await start({ buffer: false });
    script = { [FAST]: status(429, { error: "slow down" }), [MID]: streams(anthropicStream(MID)) };
    const res = await ask(h.daemon, "c-nobuffer");
    expect(res.status).toBe(200);
    await res.text();
    expect(calls).toEqual([FAST, MID]);

    calls = [];
    script = { [FAST]: streams(anthropicStream(FAST)) };
    await (await ask(h.daemon, "c-nobuffer-2")).text();
    expect(calls).toEqual([FAST]);
  });
});

describe("cascade: cursor", () => {
  const chatChunks = (model: string, text: string) => [
    `data: ${JSON.stringify({ id: "c", model, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}\n\n`,
    ...(text ? [`data: ${JSON.stringify({ id: "c", model, choices: [{ index: 0, delta: { content: text } }] })}\n\n`] : []),
    `data: ${JSON.stringify({ id: "c", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];

  test("a Responses-shaped body on the chat path is rewritten per tier and its chat-shaped reply assessed", async () => {
    const h = await start({});
    script = { [FAST]: streams(chatChunks(FAST, "")), [MID]: streams(chatChunks(MID, "fixed")) };
    const res = await fetch(`${h.daemon.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Cursor/1.0", "x-session-id": "c-cursor" },
      body: JSON.stringify({
        model: "auto",
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "fix the test" }] }],
      }),
    });
    const text = await res.text();
    expect(calls).toEqual([FAST, MID]);
    expect(text).toContain("fixed");
    expect(res.headers.get("x-jev-router-cascade")).toBe("fast->mid (empty)");
    expect(h.records[0]!.harness).toBe("cursor");
  });
});

describe("cascade: caps and exclusions", () => {
  test("hitting buffer_max_bytes flushes the original bytes unchanged and makes no retry", async () => {
    const warn = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = await start({ buffer_max_bytes: 64 });
      const chunks = anthropicStream(FAST);
      script = { [FAST]: streams(chunks) };
      const res = await ask(h.daemon, "c-cap");
      const text = await res.text();
      expect(text).toBe(chunks.join("").replace(`"model":"${FAST}"`, '"model":"auto"'));
      expect(res.headers.get("x-upstream-tag")).toBe("yes");
      expect(calls).toEqual([FAST]);
      expect(h.records[0]!.cascade).toMatchObject({ served: "fast", abandoned: "buffer_max_bytes" });
      expect(h.records[0]!.usage).toEqual({ inputTokens: 1000, outputTokens: 100 });
      expect(warn.mock.calls.some(([m]) => String(m).includes("cascade abandoned") && String(m).includes("buffer_max_bytes"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("hitting buffer_max_ms flushes what arrived and streams the rest", async () => {
    const warn = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const h = await start({ buffer_max_ms: 30 });
      const chunks = anthropicStream(FAST, { text: "slow" });
      script = {
        [FAST]: async (res) => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const chunk of chunks) {
            res.write(chunk);
            await new Promise((r) => setTimeout(r, 20));
          }
          res.end();
        },
      };
      const res = await ask(h.daemon, "c-slow");
      expect(await res.text()).toBe(chunks.join("").replace(`"model":"${FAST}"`, '"model":"auto"'));
      expect(calls).toEqual([FAST]);
      expect(h.records[0]!.cascade?.abandoned).toBe("buffer_max_ms");
    } finally {
      warn.mockRestore();
    }
  });

  test("budget_usd blocks a retry whose estimate would exceed it", async () => {
    const h = await start({ budget_usd: 0.000001 });
    const chunks = anthropicStream(FAST);
    script = { [FAST]: streams(chunks), [MID]: streams(anthropicStream(MID, { text: "never" })) };
    const res = await ask(h.daemon, "c-budget");
    expect(await res.text()).toBe(chunks.join("").replace(`"model":"${FAST}"`, '"model":"auto"'));
    expect(calls).toEqual([FAST]);
    expect(res.headers.get("x-jev-router-cascade")).toBe("fast; abandoned: budget_usd");
    expect(h.records[0]!.cascade).toMatchObject({ served: "fast", abandoned: "budget_usd" });
    expect(h.records[0]!.cascade?.attempts).toHaveLength(1);
  });

  test("requests already on the top tier never cascade", async () => {
    const h = await start({}, (p) => {
      p.policies.default.default = "frontier";
    });
    script = { [FRONTIER]: streams(anthropicStream(FRONTIER)) };
    const res = await ask(h.daemon, "c-top");
    await res.text();
    expect(calls).toEqual([FRONTIER]);
    expect(res.headers.get("x-jev-router-cascade")).toBeNull();
    expect(h.records[0]!.cascade).toBeUndefined();
  });

  test("shadow mode never cascades", async () => {
    const h = await start({}, () => undefined, "fast");
    script = { [FAST]: streams(anthropicStream(FAST)) };
    const res = await ask(h.daemon, "c-shadow");
    await res.text();
    expect(calls).toEqual([FAST]);
    expect(res.headers.get("x-jev-router-source")).toBe("shadow");
    expect(h.records[0]!.cascade).toBeUndefined();
  });

  test("passthrough and count_tokens never cascade", async () => {
    const h = await start({});
    script = { "claude-opus-5-5": streams(anthropicStream("claude-opus-5-5")), [FAST]: status(200, { input_tokens: 3 }) };
    await (await ask(h.daemon, "c-pass", { model: "claude-opus-5-5" })).text();
    await (await ask(h.daemon, "c-count", {}, "/v1/messages/count_tokens")).text();
    expect(calls).toEqual(["claude-opus-5-5", FAST]);
    expect(h.records).toHaveLength(0);
  });

  test("a disabled cascade leaves the relay exactly as before", async () => {
    const h = await start({ enabled: false });
    script = { [FAST]: streams(anthropicStream(FAST)) };
    await (await ask(h.daemon, "c-off")).text();
    expect(calls).toEqual([FAST]);
    expect(h.records[0]!.cascade).toBeUndefined();
  });
});
