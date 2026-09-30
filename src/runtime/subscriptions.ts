import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import type { Effort } from "../core/types";

/**
 * Detect coding subscriptions from what the harnesses leave on disk, so `init` can build candidates from the models
 * each plan already includes. Only plan metadata is read: Claude Code's account record (no token lives there), the
 * plan claim inside Codex's id token, and Gemini CLI's chosen auth type. Nothing is copied, printed, or kept, and the relay forwards each harness's own
 * credentials at request time instead of holding any.
 */

export interface AnthropicSubscription {
  /** Plan family as Claude Code records it: max, pro, team, enterprise, or a billing type when the org type is absent. */
  readonly plan: string;
  /** Rate-limit tier such as default_claude_max_20x, when recorded. */
  readonly tier?: string;
}

export interface CodexModel {
  readonly slug: string;
  readonly effort: readonly Effort[];
  readonly defaultEffort?: Effort;
  readonly context?: number;
  /** Display order in Codex's picker; 1 is the flagship. */
  readonly priority: number;
  /** Shown in Codex's picker, as opposed to hidden internal models. */
  readonly listed: boolean;
}

export interface ChatGptSubscription {
  /** ChatGPT plan type from the id token: plus, pro, team, business, enterprise, free. */
  readonly plan: string;
  readonly models: readonly CodexModel[];
  readonly modelsFrom: "cache" | "built-in";
}

export interface GeminiSubscription {
  /** Gemini CLI's auth type: `oauth-personal` (Login with Google) is the one the relay can forward. */
  readonly authType: "oauth-personal";
}

export interface SubscriptionDetection {
  readonly anthropic?: AnthropicSubscription;
  readonly chatgpt?: ChatGptSubscription;
  readonly gemini?: GeminiSubscription;
}

const EFFORTS: ReadonlySet<string> = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const ALL_EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** Codex models as of late 2026, used when the local catalog cache is missing. */
export const CODEX_BUILT_IN_MODELS: readonly CodexModel[] = [
  { slug: "gpt-6-astra", effort: ALL_EFFORTS, defaultEffort: "low", context: 272_000, priority: 1, listed: true },
  { slug: "gpt-6-sol", effort: ALL_EFFORTS, defaultEffort: "low", context: 272_000, priority: 2, listed: true },
  { slug: "gpt-6-luna", effort: ALL_EFFORTS, defaultEffort: "medium", context: 272_000, priority: 3, listed: true },
];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Claude Code's ~/.claude.json holds an `oauthAccount` record when logged in with a claude.ai account. */
export function parseClaudeConfig(json: unknown): AnthropicSubscription | undefined {
  if (!isRecord(json) || !isRecord(json.oauthAccount)) return undefined;
  const acct = json.oauthAccount;
  const org = typeof acct.organizationType === "string" ? acct.organizationType : undefined;
  const plan = org ? org.replace(/^claude_/, "") : typeof acct.billingType === "string" ? acct.billingType : "login";
  const tier = typeof acct.organizationRateLimitTier === "string" ? acct.organizationRateLimitTier : undefined;
  return { plan, ...(tier ? { tier } : {}) };
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const json: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return isRecord(json) ? json : undefined;
  } catch {
    return undefined;
  }
}

/** Codex's ~/.codex/auth.json: a ChatGPT login carries an id token whose claims name the plan. The token is not kept. */
export function parseCodexAuth(json: unknown): { readonly plan: string } | undefined {
  if (!isRecord(json)) return undefined;
  const tokens = isRecord(json.tokens) ? json.tokens : undefined;
  const idToken = tokens && typeof tokens.id_token === "string" ? tokens.id_token : undefined;
  if (!idToken) return undefined;
  if (json.auth_mode !== undefined && json.auth_mode !== "chatgpt") return undefined;
  const claims = decodeJwtPayload(idToken);
  const auth = claims && isRecord(claims["https://api.openai.com/auth"]) ? claims["https://api.openai.com/auth"] : undefined;
  const plan = auth && typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : "chatgpt";
  return { plan };
}

/** Codex's ~/.codex/models_cache.json: the catalog its backend returned for this account. */
export function parseCodexModelsCache(json: unknown): CodexModel[] {
  if (!isRecord(json) || !Array.isArray(json.models)) return [];
  const out: CodexModel[] = [];
  for (const m of json.models) {
    if (!isRecord(m) || typeof m.slug !== "string" || m.slug === "") continue;
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
    const effort = levels
      .map((l) => (isRecord(l) && typeof l.effort === "string" ? l.effort : undefined))
      .filter((e): e is Effort => e !== undefined && EFFORTS.has(e));
    const def =
      typeof m.default_reasoning_level === "string" && EFFORTS.has(m.default_reasoning_level)
        ? (m.default_reasoning_level as Effort)
        : undefined;
    out.push({
      slug: m.slug,
      effort,
      ...(def ? { defaultEffort: def } : {}),
      ...(typeof m.context_window === "number" ? { context: m.context_window } : {}),
      priority: typeof m.priority === "number" ? m.priority : Number.MAX_SAFE_INTEGER,
      listed: m.visibility === "list" || m.visibility === undefined,
    });
  }
  return out;
}

/**
 * Gemini CLI's ~/.gemini/settings.json records the chosen auth type at `security.auth.selectedType`. The file may
 * carry comments, so the key is matched as text rather than parsed. No credential is read.
 */
export function parseGeminiSettings(text: string | undefined): GeminiSubscription | undefined {
  if (!text) return undefined;
  return /"selectedType"\s*:\s*"oauth-personal"/.test(text) ? { authType: "oauth-personal" } : undefined;
}

export interface DetectSubscriptionsOptions {
  readonly home: string;
  readonly readFile?: (path: string) => Promise<string>;
}

export async function detectSubscriptions(opts: DetectSubscriptionsOptions): Promise<SubscriptionDetection> {
  const read = opts.readFile ?? ((p: string) => fsReadFile(p, "utf8"));
  const json = async (path: string): Promise<unknown> => {
    try {
      return JSON.parse(await read(path));
    } catch {
      return undefined;
    }
  };
  const anthropic = parseClaudeConfig(await json(join(opts.home, ".claude.json")));
  const codexAuth = parseCodexAuth(await json(join(opts.home, ".codex", "auth.json")));
  let chatgpt: ChatGptSubscription | undefined;
  if (codexAuth) {
    const cached = parseCodexModelsCache(await json(join(opts.home, ".codex", "models_cache.json")));
    chatgpt =
      cached.length > 0
        ? { plan: codexAuth.plan, models: cached, modelsFrom: "cache" }
        : { plan: codexAuth.plan, models: CODEX_BUILT_IN_MODELS, modelsFrom: "built-in" };
  }
  let geminiSettings: string | undefined;
  try {
    geminiSettings = await read(join(opts.home, ".gemini", "settings.json"));
  } catch {
    geminiSettings = undefined;
  }
  const gemini = parseGeminiSettings(geminiSettings);
  return { ...(anthropic ? { anthropic } : {}), ...(chatgpt ? { chatgpt } : {}), ...(gemini ? { gemini } : {}) };
}
