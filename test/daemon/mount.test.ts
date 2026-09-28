import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { loadPolicy } from "../../src/core/policy";
import type { PolicyInput } from "../../src/core/policy/types";
import type { DecisionRecord } from "../../src/core/record";
import { type RunningDaemon, startDaemon } from "../../src/daemon";
import { MockJudge } from "../../src/judge/mock";

interface Captured {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

let upstream: Server;
let upstreamUrl = "";
let captured: Captured[] = [];
let daemon: RunningDaemon;
let records: DecisionRecord[] = [];

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
    res.setHeader("content-type", "application/json");
    if ((req.url ?? "").startsWith("/backend-api/codex/models")) {
      res.end(
        JSON.stringify({
          models: [
            { slug: "gpt-6-luna", visibility: "list", priority: 3 },
            { slug: "gpt-6-astra", visibility: "list", priority: 1 },
          ],
        }),
      );
      return;
    }
    const body = raw ? (JSON.parse(raw) as { model?: string; stream?: boolean }) : {};
    if (body.stream === true) {
      // chatgpt.com streams Responses events with no content-type header at all, and keeps the connection open a
      // little after the terminal event.
      res.removeHeader("content-type");
      res.write(`event: response.created\ndata: {"type":"response.created","response":{"id":"r2","model":"${body.model}"}}\n\n`);
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n');
      res.write(
        `event: response.completed\ndata: {"type":"response.completed","response":{"id":"r2","model":"${body.model}","usage":{"input_tokens":21,"output_tokens":4}}}\n\n`,
      );
      setTimeout(() => res.end(), 400);
      return;
    }
    res.end(JSON.stringify({ id: "r1", model: body.model, output: [], usage: { input_tokens: 5, output_tokens: 2 } }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const addr = upstream.address();
  upstreamUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";

  const raw: PolicyInput = {
    version: 1,
    judge: { transport: "mock", timeout_ms: 1000, on_error: "fail_open", mode: "signals" },
    egress: {
      "chatgpt-subscription": {
        base_url: `${upstreamUrl}/backend-api/codex`,
        mount: "/backend-api/codex",
        forward_auth: true,
        billing: "subscription",
      },
    },
    candidates: {
      "codex-fast": { model: "gpt-6-luna", via: "chatgpt-subscription", price: { in: 0.1, out: 0.5 } },
      "codex-frontier": { model: "gpt-6-astra", via: "chatgpt-subscription", price: { in: 10, out: 50 } },
    },
    routes: [{ id: "auto", harness: "codex", policy: "codex" }],
    policies: { codex: { default: "codex-fast", order: ["codex-fast", "codex-frontier"], rules: [] } },
  };
  daemon = await startDaemon({ policy: loadPolicy(raw), judge: new MockJudge({}), port: 0, log: (r) => records.push(r) });
});

afterAll(async () => {
  await daemon.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe("mounted subscription egress", () => {
  test("proxies the model catalog with the caller's login and adds an auto entry cloned from the policy default", async () => {
    captured = [];
    const res = await fetch(`${daemon.url}/backend-api/codex/models?client_version=1`, {
      headers: { authorization: "Bearer chatgpt-login", "chatgpt-account-id": "acc-1", originator: "codex_cli_rs" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-jev-router-source")).toBe("proxy");
    const json = (await res.json()) as { models: { slug: string; display_name?: string; priority?: number }[] };
    expect(json.models.map((m) => m.slug)).toEqual(["auto", "gpt-6-luna", "gpt-6-astra"]);
    expect(json.models[0]).toMatchObject({ slug: "auto", priority: 0, visibility: "list" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ method: "GET", path: "/backend-api/codex/models?client_version=1" });
    expect(captured[0]?.headers.authorization).toBe("Bearer chatgpt-login");
    expect(captured[0]?.headers["chatgpt-account-id"]).toBe("acc-1");
    expect(captured[0]?.headers["content-type"]).toBeUndefined();
  });

  test("routes /responses under the mount, forwards the login, rewrites the model, and logs the decision", async () => {
    captured = [];
    records = [];
    const res = await fetch(`${daemon.url}/backend-api/codex/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer chatgpt-login",
        originator: "codex_cli_rs",
        "thread-id": "t-9",
      },
      body: JSON.stringify({ model: "auto", input: [{ role: "user", content: "hi" }], stream: false }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { model: string };
    expect(json.model).toBe("auto");
    expect(captured[0]).toMatchObject({ method: "POST", path: "/backend-api/codex/responses" });
    expect((captured[0]?.body as { model?: string } | undefined)?.model).toBe("gpt-6-luna");
    expect(captured[0]?.headers.authorization).toBe("Bearer chatgpt-login");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ harness: "codex", session: "codex:t-9", decision: { candidate: "codex-fast" } });
  });

  test("a stream with no content-type is still streamed, echoed, and metered when the request asked for one", async () => {
    captured = [];
    records = [];
    const res = await fetch(`${daemon.url}/backend-api/codex/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer chatgpt-login",
        originator: "codex_cli_rs",
        "thread-id": "t-10",
      },
      body: JSON.stringify({ model: "auto", input: [{ role: "user", content: "hi" }], stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"model":"auto"');
    expect(text).not.toContain("gpt-6-luna");
    expect(text).toContain('"delta":"ok"');
    expect(records).toHaveLength(1);
    expect(records[0]?.usage).toMatchObject({ inputTokens: 21, outputTokens: 4 });
  });

  test("a client that hangs up right after the terminal event still counts as a delivered, metered response", async () => {
    records = [];
    const res = await fetch(`${daemon.url}/backend-api/codex/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer chatgpt-login",
        originator: "codex_cli_rs",
        "thread-id": "t-11",
      },
      body: JSON.stringify({ model: "auto", input: [{ role: "user", content: "hi" }], stream: true }),
    });
    const reader = res.body?.getReader();
    let seen = "";
    while (reader && !seen.includes("response.completed")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    await reader?.cancel();
    const deadline = Date.now() + 3000;
    while (records.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(records).toHaveLength(1);
    expect(records[0]?.apply).toEqual({ ok: true });
    expect(records[0]?.usage).toMatchObject({ inputTokens: 21, outputTokens: 4 });
  });

  test("an unknown model under the mount passes through to the mounted egress unchanged", async () => {
    captured = [];
    records = [];
    const res = await fetch(`${daemon.url}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer chatgpt-login", originator: "codex_cli_rs" },
      body: JSON.stringify({ model: "gpt-6-astra", input: [], stream: false }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-jev-router-egress")).toBe("chatgpt-subscription");
    expect((captured[0]?.body as { model?: string } | undefined)?.model).toBe("gpt-6-astra");
    expect(records).toHaveLength(0);
  });

  test("paths outside any mount are still unknown", async () => {
    const res = await fetch(`${daemon.url}/backend-api/other`, { headers: { authorization: "Bearer x" } });
    expect(res.status).toBe(404);
  });
});
