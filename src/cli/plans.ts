/**
 * Pure planners for the installer: each takes the current config contents and returns the new contents.
 * File I/O lives in setup.ts so these stay testable.
 */

export interface SetupTarget {
  readonly baseUrl: string;
  /** Relay token when the daemon runs with --token; written as the harness credential. */
  readonly token?: string;
  /** Absolute command used by command hooks, for example "/usr/local/bin/jev-router". */
  readonly hookCommand: string;
}

export type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export const CLAUDE_CODE_HOOK_EVENTS = [
  "PostToolUse",
  "PostToolUseFailure",
  "PostCompact",
  "StopFailure",
  "SubagentStart",
  "UserPromptSubmit",
] as const;
export const CODEX_HOOK_EVENTS = ["PostToolUse", "PostCompact", "UserPromptSubmit", "SubagentStart"] as const;

const HTTP_HOOK_TIMEOUT_S = 2;
const COMMAND_HOOK_TIMEOUT_S = 5;

function claudeCodeHttpHook(baseUrl: string): JsonObject {
  return { type: "http", url: `${baseUrl}/hooks/claude-code`, timeout: HTTP_HOOK_TIMEOUT_S };
}

const LOCAL_HOOK_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/hooks\/(claude-code|codex)$/;

/** Only entries jev-router itself generated: a local relay hook URL, or a command that runs our hook subcommand. */
function isOurs(entry: unknown): boolean {
  if (!isObject(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h) =>
      isObject(h) &&
      ((typeof h.url === "string" && LOCAL_HOOK_URL.test(h.url)) ||
        (typeof h.command === "string" && /\bjev-router(\S*)?\s+hook\s+(claude-code|codex)\b/.test(h.command))),
  );
}

/** Merge one hook entry per event, replacing any earlier jev-router entry and keeping everything else. */
function mergeHooks(existing: unknown, events: readonly string[], makeEntry: () => JsonObject): JsonObject {
  const hooks: JsonObject = isObject(existing) ? { ...existing } : {};
  for (const event of events) {
    const current = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...current.filter((e) => !isOurs(e)), makeEntry()];
  }
  return hooks;
}

/** Claude Code: ~/.claude/settings.json gets the gateway env block and http hooks. Existing keys are preserved. */
export function planClaudeCodeSettings(existing: unknown, target: SetupTarget): JsonObject {
  const settings: JsonObject = isObject(existing) ? { ...existing } : {};
  const env: JsonObject = isObject(settings.env) ? { ...settings.env } : {};
  settings.env = {
    ...env,
    ANTHROPIC_BASE_URL: target.baseUrl,
    ANTHROPIC_AUTH_TOKEN: target.token ?? env.ANTHROPIC_AUTH_TOKEN ?? "jev-router",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: "claude-code/auto",
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1",
  };
  settings.hooks = mergeHooks(settings.hooks, CLAUDE_CODE_HOOK_EVENTS, () => ({ hooks: [claudeCodeHttpHook(target.baseUrl)] }));
  return settings;
}

/** Codex: ~/.codex/hooks.json gets command hooks that forward stdin to the daemon. */
export function planCodexHooks(existing: unknown, target: SetupTarget): JsonObject {
  const file: JsonObject = isObject(existing) ? { ...existing } : {};
  file.hooks = mergeHooks(file.hooks, CODEX_HOOK_EVENTS, () => ({
    hooks: [{ type: "command", command: `${target.hookCommand} hook codex`, timeout: COMMAND_HOOK_TIMEOUT_S, async: true }],
  }));
  return file;
}

const CODEX_BLOCK_START = "# >>> jev-router >>>";
const CODEX_BLOCK_END = "# <<< jev-router <<<";

/**
 * Codex: ~/.codex/config.toml. Top-level `model` and `model_provider` are set or replaced only in the
 * top-level section (before the first `[table]` header), so profile-scoped keys are never touched.
 * A marked provider block is appended or refreshed. Everything else is left byte-for-byte.
 */
export function planCodexConfig(existing: string, target: SetupTarget): string {
  const block = [
    CODEX_BLOCK_START,
    "[model_providers.jev-router]",
    'name = "jev-router"',
    `base_url = "${target.baseUrl}/v1"`,
    'wire_api = "responses"',
    'env_key = "JEV_ROUTER_TOKEN"',
    CODEX_BLOCK_END,
    "",
  ].join("\n");
  const withoutBlock = existing.replace(new RegExp(`${CODEX_BLOCK_START}[\\s\\S]*?${CODEX_BLOCK_END}\\n?`, "g"), "");
  const firstTable = withoutBlock.search(/^\s*\[/m);
  let top = firstTable < 0 ? withoutBlock : withoutBlock.slice(0, firstTable);
  const rest = firstTable < 0 ? "" : withoutBlock.slice(firstTable);
  const setTop = (text: string, key: string, value: string): string => {
    const re = new RegExp(`^${key}\\s*=.*$`, "m");
    const line = `${key} = "${value}"`;
    return re.test(text) ? text.replace(re, line) : `${line}\n${text}`;
  };
  top = setTop(top, "model", "auto");
  top = setTop(top, "model_provider", "jev-router");
  const body = `${top.replace(/\s*$/, "")}\n${rest ? `\n${rest.replace(/\s*$/, "")}\n` : ""}`;
  return `${body}\n${block}`;
}

/** OpenCode: opencode.json gets a jev-router provider with an `auto` model. */
export function planOpenCodeConfig(existing: unknown, target: SetupTarget): JsonObject {
  const config: JsonObject = isObject(existing) ? { ...existing } : { $schema: "https://opencode.ai/config.json" };
  const provider: JsonObject = isObject(config.provider) ? { ...config.provider } : {};
  provider["jev-router"] = {
    npm: "@ai-sdk/openai-compatible",
    name: "jev-router",
    options: { baseURL: `${target.baseUrl}/v1`, apiKey: target.token ?? "jev-router" },
    models: { auto: { name: "jev-router auto", limit: { context: 200000, output: 65536 } } },
  };
  config.provider = provider;
  if (typeof config.model !== "string") config.model = "jev-router/auto";
  return config;
}
