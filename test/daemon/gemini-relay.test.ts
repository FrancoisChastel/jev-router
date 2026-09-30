import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { loadPolicy } from "../../src/core/policy";
import type { PolicyInput } from "../../src/core/policy/types";
import type { DecisionRecord } from "../../src/core/record";
import { type RunningDaemon, startDaemon } from "../../src/daemon";
import { MockJudge } from "../../src/judge/mock";
import { geminiPolicyParts } from "../../src/runtime/gemini-defaults";
import { codeAssistSse, codeAssistTurn, firstTurn, GEMINI_UA, geminiSse, toolTurn } from "../fixtures/gemini";

interface Captured {
  method: string;
  path: string;
  headers: Record<string, string>;
  raw: string;
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

/** A fake Google upstream: the Gemini API and the Code Assist backend on one port, answering in their own shapes. */
beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    const raw = await readBody(req);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(",") : String(v);
    const path = req.url ?? "";
    captured.push({ method: req.method ?? "", path, headers, raw });
    const served = /models\/([^:]+):/.exec(path)?.[1] ?? (raw ? (JSON.parse(raw) as { model?: string }).model : undefined) ?? "none";
    if (path.startsWith("/v1internal:streamGenerateContent")) {
      res.setHeader("content-type", "text/event-stream");
      res.end(codeAssistSse(served));
      return;
    }
    if (path.includes(":streamGenerateContent")) {
      res.setHeader("content-type", "text/event-stream");
      res.end(geminiSse(served));
      return;
    }
    res.setHeader("content-type", "application/json");
    if (path.includes(":countTokens")) res.end(JSON.stringify({ totalTokens: 10 }));
    else if (path.includes(":loadCodeAssist")) res.end(JSON.stringify({ currentTier: { id: "standard-tier" } }));
    else
      res.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 },
          modelVersion: served,
        }),
      );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const addr = upstream.address();
  upstreamUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

/** The policy `init` generates for Gemini CLI, with the upstream swapped for the fake one. */
function geminiPolicy(auth: "api-key" | "google-login"): PolicyInput {
  const parts = geminiPolicyParts(auth);
  const { fast, mid, frontier } = parts.tiers;
  return {
    version: 1,
    judge: { transport: "mock", timeout_ms: 1000, on_error: "fail_open", mode: "signals" },
    egress: { [parts.egressName]: { ...parts.egress, base_url: upstreamUrl } },
    candidates: parts.candidates,
    routes: [{ id: "auto", harness: "gemini", policy: "gemini" }],
    policies: { gemini: { default: fast, order: [fast, mid, frontier], rules: [] } },
  };
}

const post = (url: string, body: unknown, headers: Record<string, string>) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("gemini api-key relay", () => {
  let daemon: RunningDaemon;
  let records: DecisionRecord[] = [];
  beforeAll(async () => {
    daemon = await startDaemon({
      policy: loadPolicy(geminiPolicy("api-key")),
      judge: new MockJudge({}),
      env: { GEMINI_API_KEY: "relay-gemini-key" },
      port: 0,
      log: (r) => records.push(r),
    });
  });
  afterAll(() => daemon.close());

  test("routes a stream under the mount: model rewritten in the path, key injected, body untouched, model echoed", async () => {
    captured = [];
    records = [];
    const res = await post(`${daemon.url}/gemini/v1beta/models/jev-router/auto:streamGenerateContent?alt=sse`, firstTurn, {
      "user-agent": GEMINI_UA,
      "x-goog-api-key": "the-users-own-key",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-jev-router-model")).toBe("gemini-3.1-flash-lite");
    expect(res.headers.get("x-jev-router-egress")).toBe("google");
    const text = await res.text();
    expect(text).toContain('"modelVersion":"jev-router/auto"');
    expect(text).not.toContain("gemini-3.1-flash-lite");
    expect(text).toContain('"text":"ok"');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.path).toBe("/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?alt=sse");
    expect(captured[0]?.headers["x-goog-api-key"]).toBe("relay-gemini-key");
    expect(captured[0]?.headers.authorization).toBeUndefined();
    expect(captured[0]?.headers["user-agent"]).toBe(GEMINI_UA);
    expect(captured[0]?.raw).toBe(JSON.stringify(firstTurn));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ harness: "gemini", isNewUserTurn: true, decision: { candidate: "gemini-lite" } });
    expect(records[0]?.session.startsWith("prefix:")).toBe(true);
    expect(records[0]?.usage).toEqual({ inputTokens: 120, outputTokens: 20, cacheReadTokens: 100 });
  });

  test("the tool round of the same conversation stays in its session and carries the failed shell call", async () => {
    records = [];
    await (
      await post(`${daemon.url}/gemini/v1beta/models/jev-router/auto:streamGenerateContent?alt=sse`, firstTurn, { "user-agent": GEMINI_UA })
    ).text();
    await (
      await post(`${daemon.url}/gemini/v1beta/models/jev-router/auto:streamGenerateContent?alt=sse`, toolTurn, { "user-agent": GEMINI_UA })
    ).text();
    expect(records).toHaveLength(2);
    expect(records[1]?.session).toBe(records[0]?.session as string);
    expect(records[1]?.toolOutcomes).toEqual([{ name: "run_shell_command", isError: true }]);
    expect(records[1]?.isNewUserTurn).toBe(false);
  });

  test("a non-streaming generateContent is echoed and metered from usageMetadata", async () => {
    records = [];
    const res = await post(`${daemon.url}/gemini/v1beta/models/jev-router/auto:generateContent`, firstTurn, { "user-agent": GEMINI_UA });
    const json = (await res.json()) as { modelVersion: string };
    expect(json.modelVersion).toBe("jev-router/auto");
    expect(records[0]?.usage).toEqual({ inputTokens: 50, outputTokens: 5 });
  });

  test("the top-level Gemini path routes too, and an unrecognised caller there counts as Gemini CLI", async () => {
    captured = [];
    records = [];
    const res = await post(`${daemon.url}/v1beta/models/jev-router/auto:streamGenerateContent?alt=sse`, firstTurn, {});
    expect(res.status).toBe(200);
    await res.text();
    expect(captured[0]?.path).toBe("/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?alt=sse");
    expect(records[0]?.harness).toBe("gemini");
  });

  test("a model the policy does not route passes through to the Gemini egress, key swapped, nothing logged", async () => {
    captured = [];
    records = [];
    const res = await post(`${daemon.url}/gemini/v1beta/models/gemini-3.5-flash-lite:generateContent`, firstTurn, {
      "user-agent": GEMINI_UA,
      "x-goog-api-key": "the-users-own-key",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-jev-router-source")).toBe("passthrough");
    expect(captured[0]?.path).toBe("/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect(captured[0]?.headers["x-goog-api-key"]).toBe("relay-gemini-key");
    expect(((await res.json()) as { modelVersion: string }).modelVersion).toBe("gemini-3.5-flash-lite");
    expect(records).toHaveLength(0);
  });

  test("token counting and other API calls under the mount are proxied with the key as x-goog-api-key", async () => {
    captured = [];
    const res = await post(
      `${daemon.url}/gemini/v1beta/models/gemini-3.1-flash-lite:countTokens`,
      { contents: [] },
      {
        "user-agent": GEMINI_UA,
      },
    );
    expect(await res.json()).toEqual({ totalTokens: 10 });
    expect(res.headers.get("x-jev-router-source")).toBe("proxy");
    expect(captured[0]?.headers["x-goog-api-key"]).toBe("relay-gemini-key");
    expect(captured[0]?.headers.authorization).toBeUndefined();
  });
});

describe("gemini google-login relay (Code Assist)", () => {
  let daemon: RunningDaemon;
  let records: DecisionRecord[] = [];
  beforeAll(async () => {
    daemon = await startDaemon({
      policy: loadPolicy(geminiPolicy("google-login")),
      judge: new MockJudge({}),
      env: {},
      port: 0,
      log: (r) => records.push(r),
    });
  });
  afterAll(() => daemon.close());

  test("routes under the mount with the login forwarded, the body model rewritten, and the session from session_id", async () => {
    captured = [];
    records = [];
    const res = await post(`${daemon.url}/code-assist/v1internal:streamGenerateContent?alt=sse`, codeAssistTurn, {
      "user-agent": `${GEMINI_UA} google-api-nodejs-client/10.9.0`,
      authorization: "Bearer ya29.google-login",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text.slice("data: ".length).trim()).response.modelVersion).toBe("jev-router/auto");
    expect(captured[0]?.path).toBe("/v1internal:streamGenerateContent?alt=sse");
    expect(captured[0]?.headers.authorization).toBe("Bearer ya29.google-login");
    expect(JSON.parse(captured[0]?.raw ?? "{}")).toEqual({ ...codeAssistTurn, model: "gemini-3.1-flash-lite" });
    expect(records[0]).toMatchObject({ harness: "gemini", session: "gemini:b768a5d1-d830-4b69-aee1-e4e91b469cad" });
    expect(records[0]?.usage).toEqual({ inputTokens: 120, outputTokens: 20, cacheReadTokens: 100 });
  });

  test("Code Assist housekeeping calls are proxied with the login and nothing else", async () => {
    captured = [];
    const res = await post(
      `${daemon.url}/code-assist/v1internal:loadCodeAssist`,
      { metadata: { pluginType: "GEMINI" } },
      {
        authorization: "Bearer ya29.google-login",
      },
    );
    expect(await res.json()).toEqual({ currentTier: { id: "standard-tier" } });
    expect(captured[0]).toMatchObject({ method: "POST", path: "/v1internal:loadCodeAssist" });
    expect(captured[0]?.headers.authorization).toBe("Bearer ya29.google-login");
  });

  test("Gemini CLI hook events join the session its Code Assist requests carry", async () => {
    const res = await post(
      `${daemon.url}/hooks/gemini`,
      {
        session_id: "b768a5d1-d830-4b69-aee1-e4e91b469cad",
        hook_event_name: "AfterTool",
        tool_name: "read_file",
        tool_response: { llmContent: "", error: { message: "File not found" } },
      },
      {},
    );
    expect(await res.json()).toEqual({});
    expect(daemon.store.peekPending("gemini:b768a5d1-d830-4b69-aee1-e4e91b469cad").outcomes).toEqual([
      { name: "read_file", isError: true, errorText: "File not found" },
    ]);
  });
});
