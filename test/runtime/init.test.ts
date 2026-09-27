import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "../../src/core/policy";
import { buildDefaultPolicy, DEFAULT_CANDIDATES, detectKeys, parseOpenRouterCatalog } from "../../src/runtime/defaults";
import { initPolicy } from "../../src/runtime/init";

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
    const first = await initPolicy({ path, env: { AI_GATEWAY_API_KEY: "k" }, fetch: null });
    expect(first.written).toBe(true);
    expect(first.pricesFrom).toBe("built-in table");
    expect(first.policy.judge.transport).toBe("vercel");
    expect((await stat(path)).size).toBeGreaterThan(100);
    const second = await initPolicy({ path, env: { OPENROUTER_API_KEY: "k" }, fetch: null });
    expect(second.written).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8")).judge.transport).toBe("vercel");
    const third = await initPolicy({ path, env: { OPENROUTER_API_KEY: "k" }, fetch: null, force: true });
    expect(third.written).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).judge.transport).toBe("openrouter");
  });

  test("uses the live catalog when the fetch succeeds and survives a failing fetch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-init-"));
    const good = async () =>
      Response.json({ data: [{ id: DEFAULT_CANDIDATES.mid.model, pricing: { prompt: "0.000003", completion: "0.000004" } }] });
    const r = await initPolicy({ path: join(dir, "p.json"), env: { OPENROUTER_API_KEY: "k" }, fetch: good });
    expect(r.pricesFrom).toBe("live catalog");
    expect(r.policy.candidates.mid?.price).toEqual({ in: 3, out: 4 });
    const bad = async () => {
      throw new Error("offline");
    };
    const r2 = await initPolicy({ path: join(dir, "q.json"), env: { OPENROUTER_API_KEY: "k" }, fetch: bad });
    expect(r2.pricesFrom).toBe("built-in table");
  });
});
