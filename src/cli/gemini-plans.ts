import { GEMINI_API_MOUNT, GEMINI_CODE_ASSIST_MOUNT, GEMINI_ROUTE_MODEL } from "../runtime/gemini-defaults";
import { type JsonObject, mergeHooks, type SetupTarget } from "./plans";

/**
 * Gemini CLI reads its base URL only from the environment: GOOGLE_GEMINI_BASE_URL with an API key, CODE_ASSIST_ENDPOINT
 * when logged in with Google. It loads ~/.gemini/.env for trusted folders when no project .env is found on the way up,
 * so `setup` writes that file and also prints the export for a shell profile. The model and hooks go in settings.json.
 */

export const GEMINI_HOOK_EVENTS = ["AfterTool", "BeforeAgent"] as const;
/** Gemini CLI hook timeouts are in milliseconds. */
const GEMINI_HOOK_TIMEOUT_MS = 5000;

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const subscription = (target: SetupTarget): boolean => target.auth?.gemini === "subscription";

/** The environment variable and value that point Gemini CLI at the relay. */
export function geminiEndpoint(target: SetupTarget): { readonly name: string; readonly value: string } {
  return subscription(target)
    ? { name: "CODE_ASSIST_ENDPOINT", value: `${target.baseUrl}${GEMINI_CODE_ASSIST_MOUNT}` }
    : { name: "GOOGLE_GEMINI_BASE_URL", value: `${target.baseUrl}${GEMINI_API_MOUNT}` };
}

/**
 * ~/.gemini/settings.json: `model.name` set to the relay route, and with an API key an explicit `gemini-api-key` auth
 * type when none is chosen (with only GOOGLE_GEMINI_BASE_URL set, Gemini CLI 0.62 infers a "gateway" auth type that its
 * non-interactive mode rejects). With a Google login, hooks report tool results and prompts: they join
 * the relay session through the `session_id` the Code Assist requests carry. Everything else is kept.
 */
export function planGeminiSettings(existing: unknown, target: SetupTarget): JsonObject {
  const settings: JsonObject = isObject(existing) ? { ...existing } : {};
  const model: JsonObject = isObject(settings.model) ? { ...settings.model } : {};
  settings.model = { ...model, name: GEMINI_ROUTE_MODEL };
  if (!subscription(target)) {
    const security: JsonObject = isObject(settings.security) ? { ...settings.security } : {};
    const auth: JsonObject = isObject(security.auth) ? { ...security.auth } : {};
    if (typeof auth.selectedType !== "string") settings.security = { ...security, auth: { ...auth, selectedType: "gemini-api-key" } };
    return settings;
  }
  settings.hooks = mergeHooks(settings.hooks, GEMINI_HOOK_EVENTS, () => ({
    hooks: [{ type: "command", command: `${target.hookCommand} hook gemini`, timeout: GEMINI_HOOK_TIMEOUT_MS }],
  }));
  return settings;
}

const ENV_BLOCK_START = "# >>> jev-router >>>";
const ENV_BLOCK_END = "# <<< jev-router <<<";

/** ~/.gemini/.env: a marked block with the relay endpoint, appended or refreshed; every other line is left as is. */
export function planGeminiEnv(existing: string, target: SetupTarget): string {
  const { name, value } = geminiEndpoint(target);
  const kept = existing.replace(new RegExp(`${ENV_BLOCK_START}[\\s\\S]*?${ENV_BLOCK_END}\\n?`, "g"), "").replace(/\s*$/, "");
  const block = `${ENV_BLOCK_START}\n${name}=${value}\n${ENV_BLOCK_END}\n`;
  return kept ? `${kept}\n\n${block}` : block;
}
