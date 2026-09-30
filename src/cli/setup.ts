import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GEMINI_ROUTE_MODEL } from "../runtime/gemini-defaults";
import { resolvePolicyPath } from "../runtime/paths";
import { cursorSetupSteps } from "./expose";
import { geminiEndpoint, planGeminiEnv, planGeminiSettings } from "./gemini-plans";
import { parseJsonc, stripJsonComments } from "./jsonc";
import {
  type HarnessAuth,
  type JsonObject,
  planClaudeCodeSettings,
  planCodexConfig,
  planCodexHooks,
  planOpenCodeConfig,
  type SetupTarget,
} from "./plans";

export type Agent = "claude-code" | "codex" | "opencode" | "gemini" | "pi" | "cursor";
export const AGENTS: readonly Agent[] = ["claude-code", "codex", "opencode", "gemini", "pi", "cursor"];

const DEFAULT_PORT = 4141;

export interface SetupOptions {
  readonly agents: readonly Agent[];
  readonly baseUrl: string;
  readonly hookCommand: string;
  readonly token?: string;
  /** Per-harness auth mode, derived from the policy with `harnessAuth`; defaults to the relay token. */
  readonly auth?: { readonly claudeCode?: HarnessAuth; readonly codex?: HarnessAuth; readonly gemini?: HarnessAuth };
  /** Known Claude Code model whose handling the `claude-code/auto` picker row borrows; see `claudeCodeBehavesAs`. */
  readonly behavesAs?: string;
  readonly dryRun: boolean;
  readonly home?: string;
  /** Standalone OpenCode plugin bundle to copy into OpenCode's plugin directory. */
  readonly openCodePluginPath?: string;
  readonly log: (line: string) => void;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function readJson(path: string): Promise<unknown> {
  const text = await readText(path);
  if (text === undefined || text.trim() === "") return undefined;
  return JSON.parse(text);
}

async function writeWithBackup(path: string, content: string, opts: SetupOptions): Promise<void> {
  const existing = await readText(path);
  if (existing === content) {
    opts.log(`  unchanged ${path}`);
    return;
  }
  if (opts.dryRun) {
    opts.log(`  would write ${path}${existing === undefined ? " (new)" : ` (backup at ${path}.bak)`}`);
    opts.log(indent(content));
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  if (existing !== undefined) await copyFile(path, `${path}.bak`);
  await writeFile(path, content);
  opts.log(`  wrote ${path}${existing === undefined ? "" : ` (backup at ${path}.bak)`}`);
}

const indent = (s: string): string =>
  s
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n");
const json = (v: JsonObject): string => `${JSON.stringify(v, null, 2)}\n`;

export async function runSetup(opts: SetupOptions): Promise<void> {
  const home = opts.home ?? homedir();
  const target: SetupTarget = {
    baseUrl: opts.baseUrl,
    hookCommand: opts.hookCommand,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.auth ? { auth: opts.auth } : {}),
    ...(opts.behavesAs ? { behavesAs: opts.behavesAs } : {}),
  };

  opts.log(`policy: ${await resolvePolicyPath()}`);

  for (const agent of opts.agents) {
    opts.log(`${agent}:`);
    if (agent === "claude-code") {
      const path = join(home, ".claude", "settings.json");
      await writeWithBackup(path, json(planClaudeCodeSettings(await readJson(path), target)), opts);
      if (opts.auth?.claudeCode === "subscription")
        opts.log("  Claude Code keeps its own login; the relay forwards it to api.anthropic.com");
      opts.log("  restart Claude Code; pick claude-code/auto in /model if it is not already selected");
    } else if (agent === "codex") {
      const config = join(home, ".codex", "config.toml");
      await writeWithBackup(config, planCodexConfig((await readText(config)) ?? "", target), opts);
      const hooks = join(home, ".codex", "hooks.json");
      await writeWithBackup(hooks, json(planCodexHooks(await readJson(hooks), target)), opts);
      if (opts.auth?.codex === "subscription")
        opts.log("  Codex keeps its ChatGPT login; the relay forwards it to chatgpt.com. No JEV_ROUTER_TOKEN needed");
      else
        opts.log(
          opts.token
            ? "  export JEV_ROUTER_TOKEN=<the relay token> before starting Codex"
            : "  export JEV_ROUTER_TOKEN=anything before starting Codex; the relay ignores its value",
        );
    } else if (agent === "opencode") {
      const path = join(home, ".config", "opencode", "opencode.json");
      await writeWithBackup(path, json(planOpenCodeConfig(await readJson(path), target)), opts);
      const bundle = opts.openCodePluginPath ? await readText(opts.openCodePluginPath) : undefined;
      if (bundle) await writeWithBackup(join(home, ".config", "opencode", "plugins", "jev-router.js"), bundle, opts);
      else opts.log("  plugin bundle not found next to the CLI; sensors skipped (model routing still works through the provider)");
    } else if (agent === "gemini") {
      await setupGemini(home, target, opts);
    } else if (agent === "cursor") {
      for (const line of cursorSetupSteps(Number(new URL(opts.baseUrl).port) || DEFAULT_PORT)) opts.log(line);
    } else {
      opts.log("  run: pi install npm:jev-router   (in-process extension; no relay needed)");
    }
  }
}

async function setupGemini(home: string, target: SetupTarget, opts: SetupOptions): Promise<void> {
  const settings = join(home, ".gemini", "settings.json");
  const text = await readText(settings);
  const existing = text === undefined || text.trim() === "" ? undefined : parseJsonc(text);
  if (text !== undefined && stripJsonComments(text) !== text)
    opts.log("  settings.json has comments; the rewritten file drops them (the original stays in settings.json.bak)");
  await writeWithBackup(settings, json(planGeminiSettings(existing, target)), opts);
  const envFile = join(home, ".gemini", ".env");
  await writeWithBackup(envFile, planGeminiEnv((await readText(envFile)) ?? "", target), opts);
  const { name, value } = geminiEndpoint(target);
  if (target.auth?.gemini === "subscription")
    opts.log("  Gemini CLI keeps its Google login; the relay forwards it to cloudcode-pa.googleapis.com");
  else opts.log("  Gemini CLI keeps sending GEMINI_API_KEY; the relay replaces it with its own copy of the key");
  opts.log(`  Gemini CLI reads ~/.gemini/.env only in trusted folders without a project .env; to be sure, add to your shell profile:`);
  opts.log(`    export ${name}=${value}`);
  opts.log(`  model set to ${GEMINI_ROUTE_MODEL} (plain 'auto' is Gemini CLI's own router and never reaches the relay)`);
}
