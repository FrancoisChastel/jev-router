import { describe, expect, test } from "bun:test";
import { PiRouter, type PiRouterDeps } from "../../src/adapters/pi/router";
import { loadPolicy } from "../../src/core/policy";
import type { Effort } from "../../src/core/types";
import { MockJudge } from "../../src/judge/mock";
import type { Answer, Judge } from "../../src/judge/types";
import { minimalPolicy } from "../fixtures/policies";

interface Ref {
  provider: string;
  id: string;
}

interface Calls {
  setModel: Ref[];
  setThinking: Effort[];
  notify: string[];
  status: (string | undefined)[];
  log: Record<string, unknown>[];
}

function harness(judge: Judge | undefined, over: Partial<PiRouterDeps<Ref>> = {}) {
  const calls: Calls = { setModel: [], setThinking: [], notify: [], status: [], log: [] };
  let current: Ref | undefined = { provider: "openrouter", id: "openai/gpt-5.4-mini" };
  const deps: PiRouterDeps<Ref> = {
    policy: loadPolicy(minimalPolicy()),
    policyId: "default",
    judge,
    findModel: (provider, id) => ({ provider, id }),
    setModel: async (m) => {
      calls.setModel.push(m);
      current = m;
      return true;
    },
    setThinkingLevel: (l) => {
      calls.setThinking.push(l);
    },
    currentModel: () => current,
    getActiveTools: () => ["read", "edit", "bash"],
    getContextTokens: () => 5000,
    notify: (m) => {
      calls.notify.push(m);
    },
    status: (t) => {
      calls.status.push(t);
    },
    log: (r) => {
      calls.log.push(r as unknown as Record<string, unknown>);
    },
    now: () => 1_000,
    randomId: () => "id-1",
    ...over,
  };
  const router = new PiRouter(deps);
  router.onSessionStart("startup");
  return { router, calls };
}

const midAnswers: Record<string, Answer> = {
  difficulty: { type: "score", score: 2.7, probabilities: {}, confidence: 0.9 },
  needs_reasoning: { type: "noul", noul: 0.4 },
  stakes: { type: "score", score: 1, probabilities: {}, confidence: 0.9 },
  output_kind: { type: "choice", choice: "code_edit", probabilities: { code_edit: 0.9 }, confidence: 0.9 },
  long_context: { type: "noul", noul: 0.1 },
};

describe("pi router", () => {
  test("new user turn asks the judge and switches the model", async () => {
    const judge = new MockJudge(midAnswers);
    const { router, calls } = harness(judge);
    await router.onBeforeAgentStart({ prompt: "refactor the payment module", images: [] });
    expect(judge.requests).toHaveLength(1);
    expect(Object.keys(judge.requests[0]!.questions)).toContain("difficulty");
    expect(calls.setModel).toEqual([{ provider: "openrouter", id: "anthropic/claude-sonnet-5" }]);
    expect(calls.status.at(-1)).toContain("mid");
    expect(calls.log).toHaveLength(1);
    expect(calls.log[0]!.decision).toMatchObject({ candidate: "mid", source: "judge" });
  });

  test("a clean tool continuation reuses the lease without judge or switch", async () => {
    const judge = new MockJudge(midAnswers);
    const { router, calls } = harness(judge);
    await router.onBeforeAgentStart({ prompt: "refactor the payment module", images: [] });
    await router.onTurnEnd({ assistantText: "I will edit the file", toolResults: [{ toolName: "edit", isError: false, text: "ok" }] });
    expect(judge.requests).toHaveLength(1);
    expect(calls.setModel).toHaveLength(1);
    expect(calls.log.at(-1)!.decision).toMatchObject({ source: "lease" });
  });

  test("judge failure falls open and never throws", async () => {
    const failing: Judge = {
      evaluate: async () => {
        throw new Error("boom");
      },
    };
    const { router, calls } = harness(failing);
    await router.onBeforeAgentStart({ prompt: "hello", images: [] });
    expect(calls.setModel).toHaveLength(0);
    expect(calls.log[0]!.decision).toMatchObject({ candidate: "fast", source: "fallback" });
    expect(calls.log[0]!.judge).toMatchObject({ error: "boom" });
  });

  test("without a judge the router still applies deterministic decisions", async () => {
    const { router, calls } = harness(undefined);
    await router.onBeforeAgentStart({ prompt: "hello", images: [] });
    expect(calls.log[0]!.decision).toMatchObject({ candidate: "fast", source: "fallback" });
  });

  test("manual model selection pauses routing until resumed", async () => {
    const judge = new MockJudge(midAnswers);
    const { router, calls } = harness(judge);
    router.onModelSelect({ model: { provider: "openrouter", id: "openai/gpt-6-astra" }, source: "set" });
    await router.onBeforeAgentStart({ prompt: "refactor", images: [] });
    expect(judge.requests).toHaveLength(0);
    expect(calls.setModel).toHaveLength(0);
    expect(router.statusText()).toContain("paused");
    router.setEnabled(true);
    await router.onBeforeAgentStart({ prompt: "refactor", images: [] });
    expect(judge.requests).toHaveLength(1);
  });

  test("its own switches do not count as manual overrides", async () => {
    const judge = new MockJudge(midAnswers);
    let router!: PiRouter<Ref>;
    const h = harness(judge, {
      setModel: async (m) => {
        router.onModelSelect({ model: m, source: "set" });
        return true;
      },
    });
    router = h.router;
    await router.onBeforeAgentStart({ prompt: "refactor", images: [] });
    expect(router.statusText()).not.toContain("paused");
  });

  test("applies effort through the thinking level", async () => {
    const judge = new MockJudge({
      ...midAnswers,
      stakes: { type: "score", score: 2.5, probabilities: {}, confidence: 0.9 },
      difficulty: { type: "score", score: 3.5, probabilities: {}, confidence: 0.9 },
    });
    const { router, calls } = harness(judge);
    await router.onBeforeAgentStart({ prompt: "migrate the auth schema", images: [] });
    expect(calls.setModel.at(-1)).toEqual({ provider: "openrouter", id: "openai/gpt-6-astra" });
    expect(calls.setThinking).toEqual(["high"]);
  });

  test("compaction escalates the next request", async () => {
    const judge = new MockJudge(midAnswers);
    const { router, calls } = harness(judge);
    await router.onBeforeAgentStart({ prompt: "start", images: [] });
    router.onSessionCompact();
    await router.onTurnEnd({ assistantText: "continuing", toolResults: [{ toolName: "read", isError: false, text: "..." }] });
    expect(calls.log.at(-1)!.decision).toMatchObject({ source: "override", candidate: "frontier" });
  });

  test("a rejected model switch is logged, reported, and leaves session state uncommitted", async () => {
    const judge = new MockJudge(midAnswers);
    const { router, calls } = harness(judge, {
      setModel: async () => {
        throw new Error("provider exploded");
      },
    });
    await router.onBeforeAgentStart({ prompt: "refactor", images: [] });
    await router.onBeforeAgentStart({ prompt: "refactor again", images: [] });
    expect(calls.log).toHaveLength(2);
    expect(calls.log[0]!.apply).toMatchObject({ ok: false });
    expect(String((calls.log[0]!.apply as { error?: string }).error)).toContain("provider exploded");
    expect(calls.log.map((r) => r.turn)).toEqual([0, 0]);
    expect(calls.notify.some((m) => m.includes("provider exploded"))).toBe(true);
  });

  test("a compaction reported while a request is in flight still escalates the next request", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: Judge = {
      evaluate: async () => {
        await gate;
        return { model: "m", answers: midAnswers, usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0 };
      },
    };
    const { router, calls } = harness(slow);
    const first = router.onBeforeAgentStart({ prompt: "start", images: [] });
    router.onSessionCompact();
    release?.();
    await first;
    await router.onTurnEnd({ toolResults: [{ toolName: "read", isError: false, text: "..." }] });
    expect(calls.log.at(-1)!.decision).toMatchObject({ source: "override" });
  });

  test("zero context tokens fall back to a character estimate", async () => {
    const { router, calls } = harness(undefined, { getContextTokens: () => 0 });
    await router.onBeforeAgentStart({ prompt: "x".repeat(400), images: [] });
    expect(calls.log[0]!.estimatedInputTokens).toBeGreaterThanOrEqual(100);
  });

  test("an unresolvable model is reported once and does not switch", async () => {
    const judge = new MockJudge(midAnswers);
    const { router, calls } = harness(judge, { findModel: () => undefined });
    await router.onBeforeAgentStart({ prompt: "refactor", images: [] });
    await router.onBeforeAgentStart({ prompt: "refactor again", images: [] });
    expect(calls.setModel).toHaveLength(0);
    expect(calls.notify.filter((m) => m.includes("not found"))).toHaveLength(1);
    expect(calls.log).toHaveLength(2);
  });
});
