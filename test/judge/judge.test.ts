import { describe, expect, test } from "bun:test";
import { endpointFor, HttpJudge, JudgeError } from "../../src/judge/http";
import { MockJudge } from "../../src/judge/mock";
import type { JudgeRequest } from "../../src/judge/types";

const request: JudgeRequest = {
  state: { task: "fix the bug" },
  questions: {
    difficulty: { type: "score", instructions: "How hard?", criteria: ["trivial", "routine", "hard"] },
    urgent: { type: "noul", instructions: "Urgent?" },
  },
  sessionId: "abc",
};

describe("mock judge", () => {
  test("returns configured answers and records requests", async () => {
    const judge = new MockJudge({
      difficulty: { type: "score", score: 1.2, probabilities: {}, confidence: 0.8 },
      urgent: { type: "noul", noul: 0.1 },
    });
    const res = await judge.evaluate(request);
    expect(res.answers.difficulty?.type).toBe("score");
    expect(judge.requests).toHaveLength(1);
    expect(judge.requests[0]?.sessionId).toBe("abc");
  });
});

describe("http judge", () => {
  test("resolves endpoint, model, and auth per transport", () => {
    expect(endpointFor("typesafe")).toEqual({ url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" });
    expect(endpointFor("vercel")).toEqual({ url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone", model: "typesafe-ai/jev" });
    expect(endpointFor("openrouter")).toEqual({ url: "https://openrouter.ai/api/alpha/decisions", model: "typesafe/jev-1.13" });
  });

  test("sends the TypeSafe request shape and normalizes the response", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          answers: {
            difficulty: { type: "score", score: 1.9, probabilities: { "0": 0, "1": 0.1, "2": 0.9 }, confidence: 0.85 },
            urgent: { type: "noul", noul: 0.96 },
          },
          usage: { input_tokens: 476, output_tokens: 70, cost: 0.00002 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const judge = new HttpJudge({ transport: "openrouter", apiKey: "sk-or-test", fetch: fetchImpl });
    const res = await judge.evaluate(request);

    expect(calls[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-or-test");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.session_id).toBe("abc");
    expect(body.questions.difficulty.criteria).toEqual(["trivial", "routine", "hard"]);
    expect(body.state).toEqual({ task: "fix the bug" });

    expect(res.answers.urgent).toEqual({ type: "noul", noul: 0.96 });
    expect(res.usage).toEqual({ inputTokens: 476, outputTokens: 70, costUsd: 0.00002 });
    expect(res.model).toBe("typesafe/jev-1.13-20260917");
    expect(typeof res.latencyMs).toBe("number");
  });

  test("omits session_id on transports that do not accept it", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        model: "jev-1.13.0",
        answers: { difficulty: { type: "score", score: 1, probabilities: { "0": 1 }, confidence: 1 }, urgent: { type: "noul", noul: 0.1 } },
        usage: { input_tokens: 1, output_tokens: 0 },
      });
    };
    await new HttpJudge({ transport: "typesafe", apiKey: "k", fetch: fetchImpl }).evaluate(request);
    expect("session_id" in body).toBe(false);
    expect(body.model).toBe("jev-latest");
  });

  test("retries once on 429 with backoff, then succeeds", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      if (n === 1) return new Response("slow down", { status: 429 });
      return Response.json({
        model: "jev-1.13.0",
        answers: { difficulty: { type: "score", score: 1, probabilities: { "0": 1 }, confidence: 1 }, urgent: { type: "noul", noul: 0.1 } },
        usage: { input_tokens: 1, output_tokens: 0 },
      });
    };
    const judge = new HttpJudge({ transport: "typesafe", apiKey: "k", fetch: fetchImpl, retryDelayMs: 1 });
    await judge.evaluate(request);
    expect(n).toBe(2);
  });

  test("does not retry permanent failures and surfaces the status", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      return new Response(JSON.stringify({ message: "bad key", error_type: "authentication" }), { status: 401 });
    };
    const judge = new HttpJudge({ transport: "typesafe", apiKey: "k", fetch: fetchImpl, retryDelayMs: 1 });
    await expect(judge.evaluate(request)).rejects.toBeInstanceOf(JudgeError);
    await expect(judge.evaluate(request)).rejects.toMatchObject({ status: 401, retryable: false });
    expect(n).toBe(2);
  });

  test("an already-aborted signal is rejected before any fetch", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      return Response.json({ model: "m", answers: {}, usage: {} });
    };
    const ctrl = new AbortController();
    ctrl.abort();
    const judge = new HttpJudge({ transport: "typesafe", apiKey: "k", fetch: fetchImpl });
    await expect(judge.evaluate(request, { signal: ctrl.signal })).rejects.toMatchObject({ code: "cancelled", retryable: false });
    expect(n).toBe(0);
  });

  test("an abort during retry backoff prevents the next attempt", async () => {
    let n = 0;
    const ctrl = new AbortController();
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      ctrl.abort();
      return new Response("busy", { status: 429 });
    };
    const judge = new HttpJudge({ transport: "typesafe", apiKey: "k", fetch: fetchImpl, retryDelayMs: 5 });
    await expect(judge.evaluate(request, { signal: ctrl.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(n).toBe(1);
  });

  test("malformed or incomplete answers are rejected as invalid responses", async () => {
    const good = {
      difficulty: { type: "score", score: 1.2, probabilities: { "0": 0.1, "1": 0.9 }, confidence: 0.8 },
      urgent: { type: "noul", noul: 0.4 },
    };
    const bad: Record<string, unknown>[] = [
      { difficulty: { type: "score", score: 1.2 }, urgent: good.urgent },
      { difficulty: { ...good.difficulty, score: "high" }, urgent: good.urgent },
      { difficulty: { ...good.difficulty, confidence: 1.7 }, urgent: good.urgent },
      { urgent: good.urgent },
      { difficulty: good.difficulty, urgent: { type: "noul", noul: 2 } },
      { difficulty: { type: "noul", noul: 0.5 }, urgent: good.urgent },
    ];
    for (const answers of bad) {
      const fetchImpl: typeof fetch = async () => Response.json({ model: "m", answers, usage: { input_tokens: 1, output_tokens: 0 } });
      const judge = new HttpJudge({ transport: "typesafe", apiKey: "k", fetch: fetchImpl });
      await expect(judge.evaluate(request)).rejects.toMatchObject({ code: "invalid_response", retryable: false });
    }
    const okFetch: typeof fetch = async () => Response.json({ model: "m", answers: good, usage: { input_tokens: 1, output_tokens: 0 } });
    const res = await new HttpJudge({ transport: "typesafe", apiKey: "k", fetch: okFetch }).evaluate(request);
    expect(res.answers.difficulty?.type).toBe("score");
  });

  test("times out and reports a retryable error", async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const judge = new HttpJudge({ transport: "typesafe", apiKey: "k", fetch: fetchImpl, timeoutMs: 20 });
    await expect(judge.evaluate(request)).rejects.toMatchObject({ retryable: true, code: "timeout" });
  });
});
