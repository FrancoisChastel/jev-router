import { describe, expect, test } from "bun:test";
import { formatStatusLine, sessionIdFrom, shortModel, statusLine } from "../../src/cli/statusline";
import { formatDecision, formatWhy, matchesSession, selectRecords } from "../../src/cli/why";
import { loadPolicy } from "../../src/core/policy";
import type { DecisionRecord } from "../../src/core/record";
import type { StatusReport } from "../../src/daemon/status";
import { minimalPolicy } from "../fixtures/policies";

const policy = loadPolicy(minimalPolicy());

function record(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "r",
    ts: Date.UTC(2026, 8, 29, 12, 0, 0),
    session: "cc:abc",
    harness: "claude-code",
    turn: 3,
    requestClass: "main",
    isNewUserTurn: true,
    estimatedInputTokens: 9000,
    judge: {
      questions: ["difficulty"],
      model: "jev",
      latencyMs: 180.4,
      costUsd: 0.00003,
      answers: { difficulty: { type: "score", score: 2.6, probabilities: {}, confidence: 0.8 }, long_context: { type: "noul", noul: 0.1 } },
    },
    decision: {
      candidate: "mid",
      model: "anthropic/claude-sonnet-5",
      effort: "high",
      source: "judge",
      confidence: 0.8,
      reasons: ["rule:1"],
      counterfactuals: { fast: { estCostUsd: 0.0017 }, mid: { estCostUsd: 0.036 }, frontier: { estCostUsd: 0.114 } },
      lease: "tool_chain",
    },
    apply: { ok: true },
    usage: { inputTokens: 10_000, outputTokens: 1000 },
    plan: { fiveHour: 0.43, sevenDay: 0.12 },
    ...over,
  };
}

describe("why", () => {
  test("one block with the decision, reasons, compact judge answers, cost, counterfactuals, and plan", () => {
    const text = formatDecision(record(), policy);
    expect(text).toContain("2026-09-29T12:00:00.000Z  cc:abc  turn 3  main  user turn");
    expect(text).toContain("decision  mid -> anthropic/claude-sonnet-5 (high)  via judge @0.80");
    expect(text).toContain("reasons   rule:1");
    expect(text).toContain("judge     difficulty=2.60@0.80 long_context=0.1  (jev, 180ms, $0.000030)");
    // 10k in / 1k out: mid costs 0.03 + 0.015, frontier 0.1 + 0.04.
    expect(text).toContain("usage     10000 in / 1000 out  cost $0.0450  saved $0.0950 vs the priciest tier");
    expect(text).toContain("estimate  fast $0.001700  mid $0.0360  frontier $0.1140");
    expect(text).toContain("plan      5h 43%  7d 12%");
    expect(text).not.toContain("cascade");
  });

  test("shows a cascade trace when the record carries one, and apply failures", () => {
    const withCascade = {
      ...record({ apply: { ok: false, error: "upstream responded 529" } }),
      cascade: {
        attempts: [
          { candidate: "fast", model: "openai/gpt-5.4-mini", outcome: "empty", costUsd: 0.0002 },
          { candidate: "mid", model: "anthropic/claude-sonnet-5", outcome: "served" },
        ],
        served: "mid",
      },
    };
    const text = formatDecision(withCascade as DecisionRecord);
    expect(text).toContain("(served mid)");
    expect(text).toContain("cascade   fast->mid (empty)  [fast empty $0.000200, mid served]");
    expect(text).toContain("apply     failed: upstream responded 529");
    // Without a policy the cost line keeps tokens only.
    expect(text).toContain("usage     10000 in / 1000 out\n");
  });

  test("selects by session with or without the harness prefix and keeps the last N", () => {
    const log = [
      record({ id: "1", session: "cc:abc" }),
      record({ id: "2", session: "codex:t1" }),
      record({ id: "3", session: "cc:abc:agent-7" }),
    ];
    expect(matchesSession(log[2] as DecisionRecord, "cc:abc")).toBe(true);
    expect(selectRecords(log, { session: "abc", last: 5 }).map((r) => r.id)).toEqual(["1", "3"]);
    expect(selectRecords(log, { session: "t1", last: 5 }).map((r) => r.id)).toEqual(["2"]);
    expect(selectRecords(log, { last: 2 }).map((r) => r.id)).toEqual(["2", "3"]);
    expect(formatWhy(log, { last: 2 }).split("\n\n")).toHaveLength(2);
    expect(formatWhy(log, { session: "nope", last: 1 })).toBe("no decisions for session nope");
    expect(formatWhy([], { last: 1 })).toBe("no decisions logged yet");
  });
});

const report: StatusReport = {
  plans: {
    "anthropic-subscription": { fiveHour: 0.43, sevenDay: 0.1, observedAt: 2 },
    "chatgpt-subscription": { fiveHour: 0.05, observedAt: 1 },
  },
  sessions: {
    "cc:abc": {
      candidate: "claude-sonnet",
      model: "claude-sonnet-5",
      egress: "anthropic-subscription",
      source: "judge",
      reasons: [],
      ts: 1,
    },
    "cc:gw": { candidate: "mid", model: "anthropic/claude-opus-5.5", egress: "openrouter", source: "judge", reasons: [], ts: 1 },
  },
  today: { day: "2026-09-29", decisions: 12, costUsd: 1, savedUsd: 0.4216 },
};

describe("statusline", () => {
  test("names the session's model, today's saving, and its plan window", () => {
    expect(formatStatusLine(report, "abc")).toBe("jev-router · sonnet-5 · saved $0.42 today · plan 5h 43%");
  });

  test("a gateway session shows no plan window; an unknown session shows the latest one", () => {
    expect(formatStatusLine(report, "gw")).toBe("jev-router · opus-5.5 · saved $0.42 today");
    expect(formatStatusLine(report, "zzz")).toBe("jev-router · saved $0.42 today · plan 5h 43%");
    expect(formatStatusLine({ plans: {}, sessions: {}, today: { day: "", decisions: 0, costUsd: 0, savedUsd: 0 } }, undefined)).toBe(
      "jev-router",
    );
  });

  test("reads the session id from Claude Code's stdin JSON and shortens model ids", () => {
    expect(sessionIdFrom(JSON.stringify({ session_id: "abc", model: { id: "claude-code/auto" } }))).toBe("abc");
    expect(sessionIdFrom("not json")).toBeUndefined();
    expect(shortModel("gpt-6-luna")).toBe("gpt-6-luna");
  });

  test("asks the loopback relay's /status and prints nothing when it cannot", async () => {
    const seen: string[] = [];
    const ok = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seen.push(`${String(url)} ${new Headers(init?.headers).get("authorization") ?? "-"}`);
      return Response.json(report);
    };
    const line = await statusLine({ url: "http://127.0.0.1:4141", stdin: '{"session_id":"abc"}', token: "t", fetch: ok });
    expect(line).toBe("jev-router · sonnet-5 · saved $0.42 today · plan 5h 43%");
    expect(seen).toEqual(["http://127.0.0.1:4141/status Bearer t"]);

    const down = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    };
    expect(await statusLine({ url: "http://127.0.0.1:4141", stdin: "", fetch: down })).toBe("");
    expect(await statusLine({ url: "http://127.0.0.1:4141", stdin: "", fetch: async () => new Response("", { status: 401 }) })).toBe("");
    expect(await statusLine({ url: "http://127.0.0.1:4141", stdin: "", fetch: async () => Response.json({ weird: true }) })).toBe("");
    expect(await statusLine({ url: "https://relay.example.com", stdin: "", fetch: ok })).toBe("");
    expect(seen).toHaveLength(1);
  });

  test("a relay slower than the timeout yields an empty line quickly", async () => {
    const slow = (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const start = Date.now();
    expect(await statusLine({ url: "http://127.0.0.1:4141", stdin: "", fetch: slow, timeoutMs: 50 })).toBe("");
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
