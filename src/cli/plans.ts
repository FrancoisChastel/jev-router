import type { Policy } from "../core/policy/types";

/**
 * Pure planners for the installer: each takes the current config contents and returns the new contents.
 * File I/O lives in setup.ts so these stay testable.
 */

export type HarnessAuth = "token" | "subscription";

export interface SetupTarget {
  readonly baseUrl: string;
  /** Relay token when the daemon runs with --token; written as the harness credential. */
  readonly token?: string;
  /** Absolute command used by command hooks, for example "/usr/local/bin/jev-router". */
  readonly hookCommand: string;
  /**
   * How each harness authenticates to the relay. `subscription`: the harness keeps its own login and the relay forwards
   * it, so no relay credential is written. `token` (default): the relay credential is written and the relay injects a
   * gateway key.
   */
  readonly auth?: { readonly claudeCode?: HarnessAuth; readonly codex?: HarnessAuth };
  /** A model this Claude Code version knows, lending its client-side handling to the `claude-code/auto` picker row. */
  readonly behavesAs?: string;
}

const AUTO_ROW_MODEL = "claude-code/auto";

/** Anthropic's own id for a candidate model: strips a gateway prefix and turns `opus-5.5` into `opus-5-5`. */
export function anthropicModelId(model: string): string | undefined {
  const bare = model.replace(/^anthropic\//, "");
  if (!bare.startsWith("claude-")) return undefined;
  return bare.replace(/\.(\d)/g, "-$1");
}

/** The model `claude-code/auto` should behave as in Claude Code: the claude-code route's starting candidate. */
export function claudeCodeBehavesAs(policy: Policy): string | undefined {
  const route =
    policy.routes.find((r) => r.id === AUTO_ROW_MODEL && r.harness === "claude-code") ??
    policy.routes.find((r) => r.id === "auto" && r.harness === "claude-code") ??
    policy.routes.find((r) => r.id === AUTO_ROW_MODEL) ??
    policy.routes.find((r) => r.id === "auto" && r.harness === "any");
  const def = route ? policy.policies[route.policy] : undefined;
  const model = def ? policy.candidates[def.default]?.model : undefined;
  return model ? anthropicModelId(model) : undefined;
}

/**
 * Claude Code learns `claude-code/auto` from a modelPicker row: it shows up in /model with a label, and `behavesAs`
 * gives it a known model's prompt profile and effort defaults, which also silences the unknown-model warning.
 * An existing row for the same model is replaced; other rows and picker settings are kept.
 */
export function planClaudeCodeModelPicker(existing: unknown, behavesAs: string | undefined): JsonObject {
  const picker: JsonObject = isObject(existing) ? { ...existing } : {};
  const options = Array.isArray(picker.options) ? picker.options.filter(isObject) : [];
  const row: JsonObject = {
    model: AUTO_ROW_MODEL,
    label: "auto (jev-router)",
    description: "jev-router picks the tier for each turn",
    ...(behavesAs ? { behavesAs } : {}),
  };
  return { ...picker, options: [row, ...options.filter((o) => o.model !== AUTO_ROW_MODEL)] };
}

/** Whether a harness's route ends at an egress that forwards the caller's own credentials. */
export function harnessAuth(policy: Policy, harness: "claude-code" | "codex"): HarnessAuth {
  const id = harness === "claude-code" ? "claude-code/auto" : "auto";
  const route =
    policy.routes.find((r) => r.id === id && r.harness === harness) ??
    policy.routes.find((r) => r.id === "auto" && r.harness === harness) ??
    policy.routes.find((r) => r.id === id && r.harness === "any") ??
    policy.routes.find((r) => r.id === "auto" && r.harness === "any");
  const def = route ? policy.policies[route.policy] : undefined;
  const candidate = def ? policy.candidates[def.default] : undefined;
  const egress = candidate?.via ? policy.egress[candidate.via] : undefined;
  return egress?.forward_auth === true ? "subscription" : "token";
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

/** The statusLine command setup installs: the same CLI the hooks run, pointed at the same relay. */
export function claudeCodeStatusLine(target: SetupTarget): JsonObject {
  return { type: "command", command: `${target.hookCommand} statusline --url ${target.baseUrl}` };
}

/**
 * Claude Code: ~/.claude/settings.json gets the gateway env block, http hooks, and a statusLine when it has none.
 * Existing keys are preserved; a user's own statusLine is never replaced.
 */
export function planClaudeCodeSettings(existing: unknown, target: SetupTarget): JsonObject {
  const settings: JsonObject = isObject(existing) ? { ...existing } : {};
  if (settings.statusLine === undefined) settings.statusLine = claudeCodeStatusLine(target);
  const env: JsonObject = isObject(settings.env) ? { ...settings.env } : {};
  if (target.auth?.claudeCode === "subscription") {
    // Claude Code must keep using its own login: a relay credential in ANTHROPIC_AUTH_TOKEN would replace it.
    const { ANTHROPIC_AUTH_TOKEN: authToken, ANTHROPIC_API_KEY: apiKey, ...rest } = env;
    const ours = authToken === "jev-router" || (target.token !== undefined && authToken === target.token);
    settings.env = {
      ...rest,
      ...(authToken !== undefined && !ours ? { ANTHROPIC_AUTH_TOKEN: authToken } : {}),
      ...(apiKey !== undefined && apiKey !== "" ? { ANTHROPIC_API_KEY: apiKey } : {}),
      ANTHROPIC_BASE_URL: target.baseUrl,
      ANTHROPIC_MODEL: AUTO_ROW_MODEL,
      CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1",
    };
    settings.modelPicker = planClaudeCodeModelPicker(settings.modelPicker, target.behavesAs);
    settings.hooks = mergeHooks(settings.hooks, CLAUDE_CODE_HOOK_EVENTS, () => ({ hooks: [claudeCodeHttpHook(target.baseUrl)] }));
    return settings;
  }
  settings.env = {
    ...env,
    ANTHROPIC_BASE_URL: target.baseUrl,
    ANTHROPIC_AUTH_TOKEN: target.token ?? env.ANTHROPIC_AUTH_TOKEN ?? "jev-router",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: AUTO_ROW_MODEL,
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1",
  };
  settings.modelPicker = planClaudeCodeModelPicker(settings.modelPicker, target.behavesAs);
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
  const subscription = target.auth?.codex === "subscription";
  const block = [
    CODEX_BLOCK_START,
    "[model_providers.jev-router]",
    'name = "jev-router"',
    // With a ChatGPT login Codex attaches that login to a provider marked requires_openai_auth and talks to it the way
    // it talks to chatgpt.com/backend-api/codex, so the relay mounts that path.
    `base_url = "${target.baseUrl}${subscription ? "/backend-api/codex" : "/v1"}"`,
    'wire_api = "responses"',
    subscription ? "requires_openai_auth = true" : 'env_key = "JEV_ROUTER_TOKEN"',
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
