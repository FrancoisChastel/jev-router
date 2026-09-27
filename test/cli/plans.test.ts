import { describe, expect, test } from "bun:test";
import { planClaudeCodeSettings, planCodexConfig, planCodexHooks, planOpenCodeConfig } from "../../src/cli/plans";

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
