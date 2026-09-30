import { describe, expect, test } from "bun:test";
import {
  CODEX_BUILT_IN_MODELS,
  detectSubscriptions,
  parseClaudeConfig,
  parseCodexAuth,
  parseCodexModelsCache,
  parseGeminiSettings,
} from "../../src/runtime/subscriptions";

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("subscription detection", () => {
  test("a Claude Code login reveals the plan and tier; an API-key setup reveals nothing", () => {
    expect(
      parseClaudeConfig({
        oauthAccount: {
          organizationType: "claude_max",
          organizationRateLimitTier: "default_claude_max_20x",
          billingType: "stripe_subscription",
        },
      }),
    ).toEqual({ plan: "max", tier: "default_claude_max_20x" });
    expect(parseClaudeConfig({ oauthAccount: { billingType: "stripe_subscription" } })).toEqual({ plan: "stripe_subscription" });
    expect(parseClaudeConfig({ numStartups: 3 })).toBeUndefined();
    expect(parseClaudeConfig("nope")).toBeUndefined();
  });

  test("a Codex ChatGPT login reveals the plan from the id token; an API-key login is not a subscription", () => {
    const auth = {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } }),
        access_token: "secret",
        refresh_token: "secret",
      },
    };
    expect(parseCodexAuth(auth)).toEqual({ plan: "plus" });
    expect(parseCodexAuth({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" })).toBeUndefined();
    expect(parseCodexAuth({ tokens: { id_token: "not-a-jwt" } })).toEqual({ plan: "chatgpt" });
  });

  test("the models cache keeps every model with its reasoning levels, dropping levels jev-router cannot express", () => {
    const models = parseCodexModelsCache({
      models: [
        {
          slug: "gpt-6-astra",
          visibility: "list",
          priority: 1,
          default_reasoning_level: "low",
          context_window: 272000,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }],
        },
        { slug: "gpt-reserve", visibility: "hide", priority: 3, supported_reasoning_levels: [] },
        { nope: true },
      ],
    });
    expect(models).toEqual([
      { slug: "gpt-6-astra", effort: ["low", "high"], defaultEffort: "low", context: 272000, priority: 1, listed: true },
      { slug: "gpt-reserve", effort: [], priority: 3, listed: false },
    ]);
    expect(parseCodexModelsCache({})).toEqual([]);
  });

  test("detectSubscriptions reads only the four files and falls back to built-in Codex models", async () => {
    const files: Record<string, string> = {
      "/h/.claude.json": JSON.stringify({ oauthAccount: { organizationType: "claude_pro" } }),
      "/h/.codex/auth.json": JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { id_token: jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }) },
      }),
    };
    const asked: string[] = [];
    const readFile = async (p: string) => {
      asked.push(p);
      const f = files[p];
      if (f === undefined) throw new Error("ENOENT");
      return f;
    };
    const d = await detectSubscriptions({ home: "/h", readFile });
    expect(d.anthropic).toEqual({ plan: "pro" });
    expect(d.chatgpt).toEqual({ plan: "pro", models: CODEX_BUILT_IN_MODELS, modelsFrom: "built-in" });
    expect(asked).toEqual(["/h/.claude.json", "/h/.codex/auth.json", "/h/.codex/models_cache.json", "/h/.gemini/settings.json"]);
    expect(d.gemini).toBeUndefined();
    expect(
      await detectSubscriptions({
        home: "/none",
        readFile: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).toEqual({});
  });

  test("a Gemini CLI Google login is read from the auth type in settings.json, comments and all", async () => {
    const settings = `{
      // chosen in the auth dialog
      "security": { "auth": { "selectedType": "oauth-personal" } }
    }`;
    expect(parseGeminiSettings(settings)).toEqual({ authType: "oauth-personal" });
    expect(parseGeminiSettings('{"security":{"auth":{"selectedType":"gemini-api-key"}}}')).toBeUndefined();
    expect(parseGeminiSettings(undefined)).toBeUndefined();
    const d = await detectSubscriptions({
      home: "/h",
      readFile: async (p) => {
        if (p === "/h/.gemini/settings.json") return settings;
        throw new Error("ENOENT");
      },
    });
    expect(d).toEqual({ gemini: { authType: "oauth-personal" } });
  });
});
