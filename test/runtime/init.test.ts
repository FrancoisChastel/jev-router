import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy as load, loadPolicy, tierOrder } from "../../src/core/policy";
import { buildDefaultPolicy, codexTiers, DEFAULT_CANDIDATES, detectKeys, parseOpenRouterCatalog } from "../../src/runtime/defaults";
import { describeDetection, initPolicy } from "../../src/runtime/init";
import { CODEX_BUILT_IN_MODELS } from "../../src/runtime/subscriptions";

describe("key detection", () => {
  test("one OpenRouter key serves both judge and egress", () => {
    const d = detectKeys({ OPENROUTER_API_KEY: "k" });
    expect(d).toMatchObject({ judge: "openrouter", judgeKeyEnv: "OPENROUTER_API_KEY", egress: "openrouter" });
  });
  test("a Vercel key does the same through the gateway", () => {
    expect(detectKeys({ AI_GATEWAY_API_KEY: "k" })).toMatchObject({ judge: "vercel", egress: "vercel" });
  });
  test("a TypeSafe key alone gives a judge but no egress; with an inference key it can be preferred", () => {
    expect(detectKeys({ TYPESAFE_API_KEY: "k" })).toMatchObject({ judge: "typesafe", judgeKeyEnv: "TYPESAFE_API_KEY" });
    expect(detectKeys({ TYPESAFE_API_KEY: "k" }).egress).toBeUndefined();
    expect(detectKeys({ TYPESAFE_API_KEY: "k", OPENROUTER_API_KEY: "o" })).toMatchObject({ judge: "openrouter", egress: "openrouter" });
    expect(detectKeys({ TYPESAFE_API_KEY: "k", OPENROUTER_API_KEY: "o" }, { judge: "typesafe" })).toMatchObject({
      judge: "typesafe",
      egress: "openrouter",
    });
  });
  test("no keys means a mock judge and no egress", () => {
    expect(detectKeys({})).toMatchObject({ judge: "mock", found: [] });
  });
});

describe("default policy", () => {
  test("is valid for every detection and refreshes prices from a catalog", () => {
    for (const env of [{ OPENROUTER_API_KEY: "k" }, { AI_GATEWAY_API_KEY: "k" }, { TYPESAFE_API_KEY: "k" }, {}]) {
      const p = loadPolicy(buildDefaultPolicy({ detection: detectKeys(env) }));
      expect(Object.keys(p.candidates)).toEqual(["fast", "mid", "frontier"]);
      expect(p.routes.map((r) => r.id)).toEqual(["auto", "claude-code/auto"]);
    }
    const catalog = parseOpenRouterCatalog({
      data: [
        {
          id: DEFAULT_CANDIDATES.fast.model,
          pricing: { prompt: "0.000001", completion: "0.000002" },
          context_length: 123,
          architecture: { input_modalities: ["text"] },
          supported_parameters: ["tools"],
        },
      ],
    });
    const p = loadPolicy(buildDefaultPolicy({ detection: detectKeys({ OPENROUTER_API_KEY: "k" }), catalog }));
    expect(p.candidates.fast?.price).toEqual({ in: 1, out: 2 });
    expect(p.candidates.fast?.capabilities).toEqual({ vision: false, tools: true, context: 123 });
    expect(p.candidates.mid?.price).toEqual(DEFAULT_CANDIDATES.mid.price);
    expect(p.egress.openrouter?.api_key_env).toBe("OPENROUTER_API_KEY");
    expect(p.judge).toMatchObject({ transport: "openrouter", model: "typesafe/jev-1.13", api_key_env: "OPENROUTER_API_KEY" });
  });

  test("the shipped example policy is exactly the built-in default for an OpenRouter key", async () => {
    const example = JSON.parse(await readFile("examples/policy.json", "utf8"));
    expect(example).toEqual(buildDefaultPolicy({ detection: detectKeys({ OPENROUTER_API_KEY: "k" }) }));
  });
});

describe("initPolicy", () => {
  test("writes once, keeps an existing file, regenerates with force, and works offline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-init-"));
    const path = join(dir, "nested", "policy.json");
    const first = await initPolicy({ subscriptions: false, path, env: { AI_GATEWAY_API_KEY: "k" }, fetch: null });
    expect(first.written).toBe(true);
    expect(first.pricesFrom).toBe("built-in table");
    expect(first.policy.judge.transport).toBe("vercel");
    expect((await stat(path)).size).toBeGreaterThan(100);
    const second = await initPolicy({ subscriptions: false, path, env: { OPENROUTER_API_KEY: "k" }, fetch: null });
    expect(second.written).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8")).judge.transport).toBe("vercel");
    const third = await initPolicy({ subscriptions: false, path, env: { OPENROUTER_API_KEY: "k" }, fetch: null, force: true });
    expect(third.written).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).judge.transport).toBe("openrouter");
  });

  test("uses the live catalog when the fetch succeeds and survives a failing fetch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-init-"));
    const good = async () =>
      Response.json({ data: [{ id: DEFAULT_CANDIDATES.mid.model, pricing: { prompt: "0.000003", completion: "0.000004" } }] });
    const r = await initPolicy({ subscriptions: false, path: join(dir, "p.json"), env: { OPENROUTER_API_KEY: "k" }, fetch: good });
    expect(r.pricesFrom).toBe("live catalog");
    expect(r.policy.candidates.mid?.price).toEqual({ in: 3, out: 4 });
    const bad = async () => {
      throw new Error("offline");
    };
    const r2 = await initPolicy({ subscriptions: false, path: join(dir, "q.json"), env: { OPENROUTER_API_KEY: "k" }, fetch: bad });
    expect(r2.pricesFrom).toBe("built-in table");
  });
});

describe("subscription-backed policies", () => {
  test("a Claude Code login adds Haiku, Sonnet, Opus behind a forwarding egress with its own route and policy", () => {
    const p = load(
      buildDefaultPolicy({
        detection: detectKeys({ OPENROUTER_API_KEY: "k" }),
        subscriptions: { anthropic: { plan: "max", tier: "default_claude_max_20x" } },
      }),
    );
    expect(p.egress["anthropic-subscription"]).toEqual({
      base_url: "https://api.anthropic.com",
      forward_auth: true,
      billing: "subscription",
    });
    expect(p.routes).toEqual([
      { id: "auto", harness: "any", policy: "default" },
      { id: "claude-code/auto", harness: "claude-code", policy: "claude-code" },
    ]);
    expect(tierOrder(p, "claude-code")).toEqual(["claude-haiku", "claude-sonnet", "claude-opus"]);
    expect(p.policies["claude-code"]?.default).toBe("claude-sonnet");
    expect(p.candidates["claude-opus"]?.model).toBe("claude-opus-5-5");
    expect(p.candidates["claude-opus"]?.via).toBe("anthropic-subscription");
    expect(tierOrder(p, "default")).toEqual(["fast", "mid", "frontier"]);
    expect(p.policies["claude-code"]?.rules.map((r) => r.then)).toContainEqual({ pin: "claude-haiku" });
  });

  test("a Codex login adds price-ordered tiers under the chatgpt mount, with or without a gateway key", () => {
    const p = load(
      buildDefaultPolicy({
        detection: detectKeys({}),
        subscriptions: { chatgpt: { plan: "plus", models: CODEX_BUILT_IN_MODELS, modelsFrom: "built-in" } },
      }),
    );
    expect(p.egress["chatgpt-subscription"]).toMatchObject({ mount: "/backend-api/codex", forward_auth: true, billing: "subscription" });
    expect(p.routes.find((r) => r.harness === "codex")).toEqual({ id: "auto", harness: "codex", policy: "codex" });
    expect(tierOrder(p, "codex")).toEqual(["codex-fast", "codex-mid", "codex-frontier"]);
    expect([p.candidates["codex-fast"]?.model, p.candidates["codex-mid"]?.model, p.candidates["codex-frontier"]?.model]).toEqual([
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-6-astra",
    ]);
    expect(p.candidates["codex-fast"]?.effort).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(p.candidates["codex-fast"]?.default_effort).toBe("medium");
  });

  test("codexTiers prefers catalog prices, skips hidden and unpriced models, and drops tiers it cannot fill", () => {
    const models = [
      { slug: "a", effort: [], priority: 1, listed: true },
      { slug: "b", effort: [], priority: 2, listed: true },
      { slug: "hidden", effort: [], priority: 0, listed: false },
      { slug: "unpriced", effort: [], priority: 3, listed: true },
    ];
    const catalog = new Map([
      ["openai/a", { id: "openai/a", price: { in: 1, out: 2 }, vision: true, tools: true }],
      ["openai/b", { id: "openai/b", price: { in: 20, out: 40 }, vision: true, tools: true }],
      ["openai/hidden", { id: "openai/hidden", price: { in: 0.01, out: 0.02 }, vision: true, tools: true }],
    ]);
    expect(codexTiers(models, catalog).map((t) => t.model.slug)).toEqual(["a", "b"]);
    const p = load(
      buildDefaultPolicy({ detection: detectKeys({}), catalog, subscriptions: { chatgpt: { plan: "plus", models, modelsFrom: "cache" } } }),
    );
    expect(tierOrder(p, "codex")).toEqual(["codex-fast", "codex-frontier"]);
    expect(p.policies.codex?.rules.map((r) => r.then)).not.toContainEqual({ at_least: "codex-mid" });
    expect(codexTiers([], catalog)).toEqual([]);
    expect(
      load(
        buildDefaultPolicy({ detection: detectKeys({}), subscriptions: { chatgpt: { plan: "plus", models: [], modelsFrom: "cache" } } }),
      ).routes.some((r) => r.harness === "codex"),
    ).toBe(false);
  });

  test("initPolicy detects logins from the home it is given, and subscriptions: false ignores them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-sub-"));
    const readFile = async (p: string) => {
      if (p.endsWith(".claude.json")) return JSON.stringify({ oauthAccount: { organizationType: "claude_max" } });
      throw new Error("ENOENT");
    };
    const r = await initPolicy({ path: join(dir, "policy.json"), env: {}, fetch: null, home: "/h", readFile });
    expect(r.subscriptions?.anthropic?.plan).toBe("max");
    expect(r.policy.routes.map((x) => x.policy)).toContain("claude-code");
    expect(describeDetection(r.detection, r.subscriptions).some((l) => l.includes("Claude Code login (max)"))).toBe(true);
    const off = await initPolicy({ path: join(dir, "off.json"), env: {}, fetch: null, subscriptions: false });
    expect(off.subscriptions).toBeUndefined();
    expect(Object.keys(off.policy.candidates)).toEqual(["fast", "mid", "frontier"]);
  });
});

describe("gemini defaults", () => {
  test("GEMINI_API_KEY is an inference key for Gemini CLI only, never the judge", () => {
    const d = detectKeys({ GEMINI_API_KEY: "g" });
    expect(d).toMatchObject({ judge: "mock", judgeKeyEnv: "", gemini: true, found: ["GEMINI_API_KEY"] });
    expect(d.egress).toBeUndefined();
    expect(detectKeys({ OPENROUTER_API_KEY: "o", GEMINI_API_KEY: "g" })).toMatchObject({ judge: "openrouter", egress: "openrouter" });
    expect(detectKeys({ OPENROUTER_API_KEY: "o" }).gemini).toBeUndefined();
  });

  test("with GEMINI_API_KEY the policy gains the google egress, the lite < flash < pro ladder, and a gemini route", () => {
    const p = loadPolicy(buildDefaultPolicy({ detection: detectKeys({ OPENROUTER_API_KEY: "o", GEMINI_API_KEY: "g" }) }));
    expect(Object.keys(p.egress)).toEqual(["openrouter", "google"]);
    expect(p.egress.google).toEqual({
      base_url: "https://generativelanguage.googleapis.com",
      api_key_env: "GEMINI_API_KEY",
      mount: "/gemini",
    });
    expect(tierOrder(p, "gemini").map((id) => p.candidates[id]?.model)).toEqual([
      "gemini-3.1-flash-lite",
      "gemini-3.8-flash",
      "gemini-3.1-pro-preview",
    ]);
    expect(p.candidates["gemini-lite"]).toMatchObject({ via: "google", price: { in: 0.25, out: 1.5 } });
    expect(p.policies.gemini?.default).toBe("gemini-lite");
    expect(p.policies.gemini?.rules.map((r) => r.then)).toContainEqual({ at_least: "gemini-flash" });
    expect(p.routes).toContainEqual({ id: "auto", harness: "gemini", policy: "gemini" });
    // The generic route and its candidates are unchanged.
    expect(p.policies.default?.default).toBe("fast");
  });

  test("a Gemini CLI Google login routes through Code Assist with the login forwarded, and wins over a key", () => {
    const p = loadPolicy(
      buildDefaultPolicy({ detection: detectKeys({ GEMINI_API_KEY: "g" }), subscriptions: { gemini: { authType: "oauth-personal" } } }),
    );
    expect(p.egress.google).toBeUndefined();
    expect(p.egress["gemini-code-assist"]).toEqual({
      base_url: "https://cloudcode-pa.googleapis.com",
      mount: "/code-assist",
      forward_auth: true,
      billing: "subscription",
    });
    expect(tierOrder(p, "gemini").map((id) => p.candidates[id]?.model)).toEqual([
      "gemini-3.1-flash-lite",
      "gemini-3-flash",
      "gemini-3.1-pro-preview",
    ]);
    expect(
      describeDetection(detectKeys({}), { gemini: { authType: "oauth-personal" } }).some((l) =>
        l.startsWith("gemini  Gemini CLI Google login"),
      ),
    ).toBe(true);
  });

  test("gemini prices refresh from the google/ ids in the catalog; no key and no login means no gemini route", () => {
    const catalog = parseOpenRouterCatalog({
      data: [{ id: "google/gemini-3.8-flash", pricing: { prompt: "0.000001", completion: "0.000004" } }],
    });
    const p = loadPolicy(buildDefaultPolicy({ detection: detectKeys({ GEMINI_API_KEY: "g" }), catalog }));
    expect(p.candidates["gemini-flash"]?.price).toEqual({ in: 1, out: 4 });
    expect(p.candidates["gemini-lite"]?.price).toEqual({ in: 0.25, out: 1.5 });
    expect(
      loadPolicy(buildDefaultPolicy({ detection: detectKeys({ OPENROUTER_API_KEY: "o" }) })).routes.some((r) => r.harness === "gemini"),
    ).toBe(false);
    expect(describeDetection(detectKeys({ GEMINI_API_KEY: "g" })).some((l) => l.includes("gemini-3.1-flash-lite < gemini-3.8-flash"))).toBe(
      true,
    );
  });
});
