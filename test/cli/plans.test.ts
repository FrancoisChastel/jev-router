import { describe, expect, test } from "bun:test";
import {
  anthropicModelId,
  claudeCodeBehavesAs,
  harnessAuth,
  planClaudeCodeModelPicker,
  planClaudeCodeSettings,
  planCodexConfig,
  planCodexHooks,
  planOpenCodeConfig,
} from "../../src/cli/plans";
import { loadPolicy } from "../../src/core/policy";
import { minimalPolicy } from "../fixtures/policies";

const target = { baseUrl: "http://127.0.0.1:4141", hookCommand: "/usr/local/bin/jev-router" };

describe("claude code settings plan", () => {
  test("adds env and http hooks while preserving unrelated settings and existing hooks", () => {
    const existing = {
      model: "opus",
      env: { FOO: "bar", ANTHROPIC_AUTH_TOKEN: "my-gateway-token" },
      hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "prettier" }] }] },
    };
    const out = planClaudeCodeSettings(existing, target) as {
      model: string;
      env: Record<string, string>;
      hooks: Record<string, { hooks: { type: string; url?: string; timeout?: number }[] }[]>;
    };
    expect(out.model).toBe("opus");
    expect(out.env.FOO).toBe("bar");
    expect(out.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4141");
    expect(out.env.ANTHROPIC_AUTH_TOKEN).toBe("my-gateway-token");
    expect(out.env.ANTHROPIC_API_KEY).toBe("");
    expect(out.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS).toBe("1");
    expect(out.hooks.PostToolUse).toHaveLength(2);
    expect(out.hooks.PostToolUse![0]!.hooks[0]!.type).toBe("command");
    expect(out.hooks.PostToolUse![1]!.hooks[0]).toEqual({ type: "http", url: "http://127.0.0.1:4141/hooks/claude-code", timeout: 2 });
    expect(out.hooks.StopFailure).toHaveLength(1);
  });

  test("only removes its own hooks, never unrelated ones with /hooks/ in the URL", () => {
    const existing = {
      hooks: {
        PostToolUse: [
          { hooks: [{ type: "http", url: "https://ci.example.internal/hooks/notify-build" }] },
          { hooks: [{ type: "http", url: "http://127.0.0.1:5000/hooks/claude-code", timeout: 2 }] },
        ],
      },
    };
    const out = planClaudeCodeSettings(existing, target) as { hooks: { PostToolUse: { hooks: { url: string }[] }[] } };
    const urls = out.hooks.PostToolUse!.map((e) => e.hooks[0]!.url);
    expect(urls).toEqual(["https://ci.example.internal/hooks/notify-build", "http://127.0.0.1:4141/hooks/claude-code"]);
  });

  test("writes the relay token as the harness credential when given", () => {
    const out = planClaudeCodeSettings({ env: { ANTHROPIC_AUTH_TOKEN: "old" } }, { ...target, token: "t0k" }) as {
      env: Record<string, string>;
    };
    expect(out.env.ANTHROPIC_AUTH_TOKEN).toBe("t0k");
    const oc = planOpenCodeConfig(undefined, { ...target, token: "t0k" }) as {
      provider: { "jev-router": { options: { apiKey: string } } };
    };
    expect(oc.provider["jev-router"].options.apiKey).toBe("t0k");
  });

  test("is idempotent", () => {
    const once = planClaudeCodeSettings(undefined, target);
    const twice = planClaudeCodeSettings(once, target);
    expect(twice).toEqual(once);
  });

  test("adds the jev-router statusLine only when settings have none", () => {
    const fresh = planClaudeCodeSettings({}, target) as { statusLine: unknown };
    expect(fresh.statusLine).toEqual({
      type: "command",
      command: "/usr/local/bin/jev-router statusline --url http://127.0.0.1:4141",
    });
    const subscription = planClaudeCodeSettings({}, { ...target, auth: { claudeCode: "subscription" } }) as { statusLine: unknown };
    expect(subscription.statusLine).toEqual(fresh.statusLine);
    const own = { type: "command", command: "~/.claude/my-statusline.sh", padding: 1 };
    const kept = planClaudeCodeSettings({ statusLine: own }, target) as { statusLine: unknown };
    expect(kept.statusLine).toEqual(own);
  });
});

describe("codex plans", () => {
  test("config.toml keeps unrelated content, replaces model keys, and refreshes the marked block", () => {
    const existing = 'model = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n\n[model_providers.other]\nname = "other"\n';
    const once = planCodexConfig(existing, target);
    expect(once).toContain('model = "auto"');
    expect(once).toContain('model_provider = "jev-router"');
    expect(once).toContain('model_reasoning_effort = "high"');
    expect(once).toContain("[model_providers.other]");
    expect(once).toContain('base_url = "http://127.0.0.1:4141/v1"');
    expect(once).toContain('wire_api = "responses"');
    const twice = planCodexConfig(once, { ...target, baseUrl: "http://127.0.0.1:5000" });
    expect(twice.match(/\[model_providers\.jev-router\]/g)).toHaveLength(1);
    expect(twice).toContain('base_url = "http://127.0.0.1:5000/v1"');
    expect(twice.match(/^model_provider = /gm)).toHaveLength(1);
  });

  test("config.toml never touches profile-scoped model keys", () => {
    const existing = '[model_providers.openai]\nname = "OpenAI"\n\n[profiles.default]\nmodel = "o3"\nmodel_provider = "openai"\n';
    const out = planCodexConfig(existing, target);
    expect(out).toContain('[profiles.default]\nmodel = "o3"\nmodel_provider = "openai"');
    expect(out.startsWith('model_provider = "jev-router"\nmodel = "auto"\n')).toBe(true);
    expect(out.match(/^model = /gm)).toHaveLength(2);
  });

  test("hooks.json uses async command hooks and does not duplicate", () => {
    const once = planCodexHooks(undefined, target) as { hooks: Record<string, { hooks: { command: string; async: boolean }[] }[]> };
    expect(once.hooks.PostToolUse![0]!.hooks[0]!.command).toBe("/usr/local/bin/jev-router hook codex");
    expect(once.hooks.PostToolUse![0]!.hooks[0]!.async).toBe(true);
    const twice = planCodexHooks(once, target) as typeof once;
    expect(twice.hooks.PostToolUse).toHaveLength(1);
  });
});

describe("opencode plan", () => {
  test("adds the provider and default model without clobbering others", () => {
    const existing = { provider: { openrouter: { options: { apiKey: "x" } } }, model: "openrouter/foo" };
    const out = planOpenCodeConfig(existing, target) as { provider: Record<string, unknown>; model: string };
    expect(Object.keys(out.provider).sort()).toEqual(["jev-router", "openrouter"]);
    expect(out.model).toBe("openrouter/foo");
    const fresh = planOpenCodeConfig(undefined, target) as { model: string };
    expect(fresh.model).toBe("jev-router/auto");
  });
});

describe("subscription auth plans", () => {
  test("claude code keeps its own login: no relay credential written, ours removed, a foreign one kept", () => {
    const sub = { ...target, auth: { claudeCode: "subscription" as const } };
    const out = planClaudeCodeSettings({ env: { ANTHROPIC_AUTH_TOKEN: "jev-router", ANTHROPIC_API_KEY: "", KEEP: "1" } }, sub) as {
      env: Record<string, string>;
      hooks: Record<string, unknown[]>;
    };
    expect(out.env).toEqual({
      KEEP: "1",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4141",
      ANTHROPIC_MODEL: "claude-code/auto",
      CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1",
    });
    expect(out.hooks.PostToolUse).toHaveLength(1);
    const foreign = planClaudeCodeSettings({ env: { ANTHROPIC_AUTH_TOKEN: "corp-gateway", ANTHROPIC_API_KEY: "sk-real" } }, sub) as {
      env: Record<string, string>;
    };
    expect(foreign.env.ANTHROPIC_AUTH_TOKEN).toBe("corp-gateway");
    expect(foreign.env.ANTHROPIC_API_KEY).toBe("sk-real");
    const withToken = planClaudeCodeSettings({ env: { ANTHROPIC_AUTH_TOKEN: "tok" } }, { ...sub, token: "tok" }) as {
      env: Record<string, string>;
    };
    expect(withToken.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("codex gets a provider that carries its ChatGPT login to the mounted path", () => {
    const out = planCodexConfig("", { ...target, auth: { codex: "subscription" } });
    expect(out).toContain('base_url = "http://127.0.0.1:4141/backend-api/codex"');
    expect(out).toContain("requires_openai_auth = true");
    expect(out).not.toContain("env_key");
    expect(out).toContain('model = "auto"');
    expect(out).toContain('model_provider = "jev-router"');
    const tokenMode = planCodexConfig("", target);
    expect(tokenMode).toContain('base_url = "http://127.0.0.1:4141/v1"');
    expect(tokenMode).toContain('env_key = "JEV_ROUTER_TOKEN"');
  });

  test("harnessAuth follows each harness's route to its default candidate's egress", () => {
    const raw = minimalPolicy();
    expect(harnessAuth(loadPolicy(raw), "codex")).toBe("token");
    expect(harnessAuth(loadPolicy(raw), "claude-code")).toBe("token");
    raw.egress = { sub: { base_url: "https://api.anthropic.com", forward_auth: true } };
    raw.candidates.fast.via = "sub";
    raw.routes = [
      { id: "auto", harness: "any", policy: "default" },
      { id: "claude-code/auto", harness: "claude-code", policy: "default" },
    ];
    const p = loadPolicy(raw);
    expect(harnessAuth(p, "claude-code")).toBe("subscription");
    expect(harnessAuth(p, "codex")).toBe("subscription");
  });
});

describe("claude code model picker", () => {
  test("adds the auto row once, keeps other rows and picker settings, and borrows a known model's handling", () => {
    const existing = {
      replaceBuiltInOptions: false,
      options: [
        { model: "claude-code/auto", label: "old" },
        { model: "claude-opus-5-5", label: "mine" },
      ],
    };
    const out = planClaudeCodeModelPicker(existing, "claude-sonnet-5") as {
      replaceBuiltInOptions: boolean;
      options: { model: string; behavesAs?: string }[];
    };
    expect(out.replaceBuiltInOptions).toBe(false);
    expect(out.options.map((o) => o.model)).toEqual(["claude-code/auto", "claude-opus-5-5"]);
    expect(out.options[0]).toMatchObject({ model: "claude-code/auto", label: "auto (jev-router)", behavesAs: "claude-sonnet-5" });
    expect(
      (planClaudeCodeModelPicker(undefined, undefined) as { options: { behavesAs?: string }[] }).options[0]?.behavesAs,
    ).toBeUndefined();
    const settings = planClaudeCodeSettings({}, { ...target, behavesAs: "claude-sonnet-5" }) as { modelPicker: { options: unknown[] } };
    expect(settings.modelPicker.options).toHaveLength(1);
  });
  test("anthropicModelId strips the gateway prefix and dotted versions; behavesAs follows the claude-code route", () => {
    expect(anthropicModelId("anthropic/claude-opus-5.5")).toBe("claude-opus-5-5");
    expect(anthropicModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(anthropicModelId("openai/gpt-6-luna")).toBeUndefined();
    const raw = minimalPolicy();
    raw.candidates.fast.model = "anthropic/claude-haiku-4.5";
    expect(claudeCodeBehavesAs(loadPolicy(raw))).toBe("claude-haiku-4-5");
    raw.candidates.fast.model = "openai/gpt-6-luna";
    expect(claudeCodeBehavesAs(loadPolicy(raw))).toBeUndefined();
  });
});
