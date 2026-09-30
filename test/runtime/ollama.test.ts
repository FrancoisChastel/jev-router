import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan } from "../../src/core/decide";
import { loadPolicy, tierOrder } from "../../src/core/policy";
import { emptySession } from "../../src/core/session";
import { buildDefaultPolicy, detectKeys, planRulesFor } from "../../src/runtime/defaults";
import { initPolicy } from "../../src/runtime/init";
import { chooseOllamaModel, detectOllama, parseOllamaTags } from "../../src/runtime/ollama";
import { CODEX_BUILT_IN_MODELS } from "../../src/runtime/subscriptions";

const tagsFetch =
  (names: readonly string[], seen: string[] = []) =>
  async (url: RequestInfo | URL): Promise<Response> => {
    seen.push(String(url));
    if (String(url).endsWith("/api/tags")) return Response.json({ models: names.map((name) => ({ name, model: name })) });
    return Response.json({ data: [] });
  };

describe("Ollama detection", () => {
  test("prefers coding models in a fixed order, else the first tag", () => {
    expect(chooseOllamaModel(["llama3.2:3b", "qwen2.5-coder:7b", "qwen3-coder:30b"])).toBe("qwen3-coder:30b");
    expect(chooseOllamaModel(["llama3.2:3b", "devstral:24b", "codellama:13b"])).toBe("devstral:24b");
    expect(chooseOllamaModel(["llama3.2:3b", "mistral:7b"])).toBe("llama3.2:3b");
    expect(chooseOllamaModel([])).toBeUndefined();
  });

  test("probes /api/tags on loopback and parses the tag names", async () => {
    const seen: string[] = [];
    const d = await detectOllama(tagsFetch(["mistral:7b", "deepseek-coder:6.7b"], seen));
    expect(seen).toEqual(["http://127.0.0.1:11434/api/tags"]);
    expect(d).toEqual({ baseUrl: "http://127.0.0.1:11434", model: "deepseek-coder:6.7b", tags: ["mistral:7b", "deepseek-coder:6.7b"] });
    expect(parseOllamaTags({ nope: 1 })).toEqual([]);
  });

  test("stays silent when Ollama is down, answers badly, or has no models", async () => {
    const down = async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    };
    expect(await detectOllama(down)).toBeUndefined();
    expect(await detectOllama(async () => new Response("nope", { status: 500 }))).toBeUndefined();
    expect(await detectOllama(async () => new Response("not json"))).toBeUndefined();
    expect(await detectOllama(tagsFetch([]))).toBeUndefined();
  });
});

describe("policy generation with a local tier", () => {
  const ollama = { baseUrl: "http://127.0.0.1:11434", model: "qwen3-coder:30b" };

  test("adds a no-auth, chat-only ollama egress, a free local candidate at the bottom, and pins auxiliary work to it", () => {
    const raw = buildDefaultPolicy({ detection: detectKeys({ OPENROUTER_API_KEY: "k" }), ollama });
    expect(raw.egress?.ollama).toEqual({ base_url: "http://127.0.0.1:11434", no_auth: true, dialects: ["openai-chat"], billing: "usd" });
    expect(raw.candidates.local).toEqual({
      model: "qwen3-coder:30b",
      via: "ollama",
      price: { in: 0, out: 0 },
      capabilities: { tools: true, vision: false },
    });
    // The gateway stays the first egress, so candidates without `via` keep resolving to it.
    expect(Object.keys(raw.egress ?? {})[0]).toBe("openrouter");
    const p = loadPolicy(raw);
    expect(tierOrder(p, "default")).toEqual(["local", "fast", "mid", "frontier"]);
    expect(p.policies.default?.default).toBe("fast");
    expect(p.policies.default?.rules[0]?.then).toEqual({ pin: "local" });
    expect(p.policies.default?.rules[1]?.then).toEqual({ pin: "fast" });
  });

  test("compaction calls in chat format go local; Anthropic-format ones fall back to fast", () => {
    const p = loadPolicy(buildDefaultPolicy({ detection: detectKeys({ OPENROUTER_API_KEY: "k" }), ollama }));
    const request = {
      harness: "opencode" as const,
      sessionKey: "s",
      requestedModel: "auto",
      requestClass: "compaction" as const,
      isNewUserTurn: true,
      toolNames: [],
      hasImages: false,
      estimatedInputTokens: 1000,
      toolOutcomes: [],
    };
    const chat = plan({ request: { ...request, dialect: "openai-chat" }, session: emptySession(), policy: p, policyId: "default" });
    const messages = plan({ request: { ...request, dialect: "anthropic" }, session: emptySession(), policy: p, policyId: "default" });
    expect(chat.kind === "decision" && chat.decision.candidate).toBe("local");
    expect(messages.kind === "decision" && messages.decision.candidate).toBe("fast");
  });

  test("subscription policies are untouched by the local tier", () => {
    const p = loadPolicy(
      buildDefaultPolicy({
        detection: detectKeys({}),
        ollama,
        subscriptions: { anthropic: { plan: "max" }, chatgpt: { plan: "plus", models: CODEX_BUILT_IN_MODELS, modelsFrom: "built-in" } },
      }),
    );
    expect(tierOrder(p, "claude-code")).not.toContain("local");
    expect(tierOrder(p, "codex")).not.toContain("local");
  });

  test("initPolicy probes Ollama with the injected fetch, and ollama: false skips it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-ollama-"));
    const r = await initPolicy({ subscriptions: false, path: join(dir, "a.json"), env: {}, fetch: tagsFetch(["codestral:22b"]) });
    expect(r.ollama?.model).toBe("codestral:22b");
    expect(r.policy.candidates.local?.model).toBe("codestral:22b");
    const off = await initPolicy({
      subscriptions: false,
      path: join(dir, "b.json"),
      env: {},
      fetch: tagsFetch(["codestral:22b"]),
      ollama: false,
    });
    expect(off.ollama).toBeUndefined();
    expect(off.policy.candidates.local).toBeUndefined();
  });
});

describe("plan caps in generated subscription policies", () => {
  test("Claude Code and Codex policies end with the 80% and 95% five-hour caps", () => {
    const p = loadPolicy(
      buildDefaultPolicy({
        detection: detectKeys({}),
        subscriptions: { anthropic: { plan: "max" }, chatgpt: { plan: "plus", models: CODEX_BUILT_IN_MODELS, modelsFrom: "built-in" } },
      }),
    );
    const tail = (id: string) => p.policies[id]?.rules.slice(-2).map((r) => ({ when: r.when, then: r.then }));
    expect(tail("claude-code")).toEqual([
      { when: "plan_5h >= 0.8", then: { at_most: "claude-sonnet" } },
      { when: "plan_5h >= 0.95", then: { at_most: "claude-haiku" } },
    ]);
    expect(tail("codex")).toEqual([
      { when: "plan_5h >= 0.8", then: { at_most: "codex-mid" } },
      { when: "plan_5h >= 0.95", then: { at_most: "codex-fast" } },
    ]);
    expect(p.policies.default?.rules.some((r) => r.when.includes("plan_5h"))).toBe(false);
  });

  test("two tiers get only the hard cap, one tier gets none", () => {
    expect(planRulesFor({ fast: "a", frontier: "b" })).toEqual([{ when: "plan_5h >= 0.95", then: { at_most: "a" } }]);
    expect(planRulesFor({ fast: "a" })).toEqual([]);
  });
});
