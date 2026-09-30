import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { loadPolicy } from "../../src/core/policy";
import type { PolicyInput } from "../../src/core/policy/types";
import type { DecisionRecord } from "../../src/core/record";
import { type RunningDaemon, startDaemon } from "../../src/daemon";
import type { StatusReport } from "../../src/daemon/status";
import { MockJudge } from "../../src/judge/mock";
import type { Answer } from "../../src/judge/types";
import { planRulesFor, rulesFor } from "../../src/runtime/defaults";

interface Captured {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly model?: string;
}

let upstream: Server;
let daemon: RunningDaemon;
let captured: Captured[] = [];
let records: DecisionRecord[] = [];
/** Five-hour utilization the fake Anthropic upstream reports on its next response. */
let reportFiveHour = "0.9";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
    });
    req.on("end", () => resolve(s));
  });
}

const score = (s: number): Answer => ({ type: "score", score: s, probabilities: {}, confidence: 0.9 });

beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    const raw = await readBody(req);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(",") : String(v);
    const body = raw ? (JSON.parse(raw) as { model?: string }) : {};
    captured.push({ path: req.url ?? "", headers, ...(body.model ? { model: body.model } : {}) });
    res.setHeader("content-type", "application/json");
    if ((req.url ?? "").startsWith("/anthropic")) {
      res.setHeader("anthropic-ratelimit-unified-5h-utilization", reportFiveHour);
      res.setHeader("anthropic-ratelimit-unified-7d-utilization", "0.44");
      res.setHeader("anthropic-ratelimit-unified-5h-reset", String(Math.floor(Date.now() / 1000) + 3600));
      res.end(
        JSON.stringify({ id: "m", type: "message", model: body.model, content: [], usage: { input_tokens: 1000, output_tokens: 100 } }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        id: "c",
        object: "chat.completion",
        model: body.model,
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const addr = upstream.address();
  const base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
  const tiers = { fast: "claude-haiku", mid: "claude-sonnet", frontier: "claude-opus" };
  const raw: PolicyInput = {
    version: 1,
    judge: { transport: "mock" },
    egress: {
      "anthropic-subscription": { base_url: `${base}/anthropic`, forward_auth: true, billing: "subscription" },
      ollama: { base_url: `${base}/ollama`, no_auth: true, dialects: ["openai-chat"], billing: "usd" },
    },
    candidates: {
      "claude-haiku": { model: "claude-haiku-4-5", via: "anthropic-subscription", price: { in: 1, out: 5 } },
      "claude-sonnet": { model: "claude-sonnet-5", via: "anthropic-subscription", price: { in: 2, out: 10 } },
      "claude-opus": { model: "claude-opus-5-5", via: "anthropic-subscription", price: { in: 4, out: 20 } },
      local: { model: "qwen3-coder:30b", via: "ollama", price: { in: 0, out: 0 } },
    },
    routes: [
      { id: "claude-code/auto", harness: "claude-code", policy: "claude-code" },
      { id: "local/auto", harness: "any", policy: "local" },
    ],
    policies: {
      "claude-code": {
        default: "claude-sonnet",
        order: ["claude-haiku", "claude-sonnet", "claude-opus"],
        rules: [...rulesFor(tiers), ...planRulesFor(tiers)],
      },
      local: { default: "local", order: ["local"], rules: [] },
    },
  };
  const judge = new MockJudge({ difficulty: score(3), needs_reasoning: score(1), stakes: score(3) });
  daemon = await startDaemon({ policy: loadPolicy(raw), judge, port: 0, env: {}, log: (r) => records.push(r) });
});

afterAll(async () => {
  await daemon.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

async function claudeTurn(session: string): Promise<Response> {
  return fetch(`${daemon.url}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer claude-oauth",
      "user-agent": "claude-cli/3.0",
      "x-claude-code-session-id": session,
    },
    body: JSON.stringify({ model: "claude-code/auto", max_tokens: 10, messages: [{ role: "user", content: "design a storage engine" }] }),
  });
}

const status = async (): Promise<StatusReport> => (await (await fetch(`${daemon.url}/status`)).json()) as StatusReport;

describe("plan-window awareness through the relay", () => {
  test("/status is empty before any traffic", async () => {
    const s = await status();
    expect(s.plans).toEqual({});
    expect(s.sessions).toEqual({});
    expect(s.today.decisions).toBe(0);
  });

  test("a subscription response's usage headers land in /status, and the next decision is capped by them", async () => {
    records = [];
    const first = await claudeTurn("s-1");
    expect(first.status).toBe(200);
    await first.text();
    // Nothing was known when the first turn was decided: the judge's hard verdict took it to Opus.
    expect(records[0]?.decision.candidate).toBe("claude-opus");
    expect(records[0]?.plan).toBeUndefined();

    const s = await status();
    expect(s.plans["anthropic-subscription"]).toMatchObject({ fiveHour: 0.9, sevenDay: 0.44 });
    expect(s.plans.ollama).toBeUndefined();
    expect(s.sessions["cc:s-1"]).toMatchObject({
      candidate: "claude-opus",
      model: "claude-opus-5-5",
      egress: "anthropic-subscription",
      source: "judge",
    });
    // 1000 in / 100 out on Opus at 4/20 per million.
    expect(s.sessions["cc:s-1"]?.costUsd).toBeCloseTo(0.006, 6);
    expect(s.sessions["cc:s-1"]?.savedUsd).toBe(0);

    const second = await claudeTurn("s-2");
    await second.text();
    expect(records[1]?.plan).toEqual({ fiveHour: 0.9, sevenDay: 0.44 });
    expect(records[1]?.decision.candidate).toBe("claude-sonnet");
    expect(records[1]?.decision.reasons).toContain("capped");
    expect(captured.at(-1)?.model).toBe("claude-sonnet-5");

    const after = await status();
    expect(after.sessions["cc:s-2"]).toMatchObject({ candidate: "claude-sonnet" });
    expect(after.sessions["cc:s-2"]?.savedUsd).toBeCloseTo(0.006 - 0.003, 6);
    expect(after.today.decisions).toBe(2);
  });

  test("at 95% the router drops to the cheapest tier", async () => {
    reportFiveHour = "0.97";
    records = [];
    await (await claudeTurn("s-3")).text();
    await (await claudeTurn("s-4")).text();
    expect(records[1]?.decision.candidate).toBe("claude-haiku");
  });
});

describe("no_auth egress", () => {
  test("forwards without any credential and strips the caller's", async () => {
    captured = [];
    const res = await fetch(`${daemon.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer something-local" },
      body: JSON.stringify({ model: "local/auto", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-jev-router-egress")).toBe("ollama");
    expect(captured[0]?.path).toBe("/ollama/v1/chat/completions");
    expect(captured[0]?.model).toBe("qwen3-coder:30b");
    expect(captured[0]?.headers.authorization).toBeUndefined();
    expect(captured[0]?.headers["x-api-key"]).toBeUndefined();
  });
});
