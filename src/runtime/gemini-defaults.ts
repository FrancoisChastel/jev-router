import type { CandidateInput, EgressInput } from "../core/policy/types";
import type { Effort } from "../core/types";

/**
 * Gemini CLI defaults. With an API key Gemini CLI talks to the public Gemini API; logged in with Google it talks to
 * Google's Code Assist backend. Both are served under their own relay mount so model-less calls (token counting,
 * quota, onboarding) and model ids the policy does not route reach the right upstream.
 */

export const GEMINI_API_EGRESS = "google";
/** Relay path Gemini CLI's GOOGLE_GEMINI_BASE_URL points at; the sub-paths mirror generativelanguage.googleapis.com. */
export const GEMINI_API_MOUNT = "/gemini";
export const GEMINI_CODE_ASSIST_EGRESS = "gemini-code-assist";
/** Relay path Gemini CLI's CODE_ASSIST_ENDPOINT points at; the sub-paths mirror cloudcode-pa.googleapis.com. */
export const GEMINI_CODE_ASSIST_MOUNT = "/code-assist";
export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";

/**
 * The model id Gemini CLI is set to. Plain `auto` is Gemini CLI's own alias: the CLI resolves it locally (after a
 * classifier call of its own) and never sends it, so the relay route is reached through `<prefix>/auto` instead.
 */
export const GEMINI_ROUTE_MODEL = "jev-router/auto";

interface GeminiDefault {
  readonly model: string;
  /** OpenRouter catalog id used to refresh the price. */
  readonly catalog: string;
  readonly price: { readonly in: number; readonly out: number };
  readonly effort: readonly Effort[];
}

type Tier = "fast" | "mid" | "frontier";

const CONTEXT = 1_048_576;
const FLASH_EFFORT: readonly Effort[] = ["minimal", "low", "medium", "high"];
const PRO_EFFORT: readonly Effort[] = ["low", "high"];

/**
 * API-key ladder: the flash-lite, flash, and pro models Gemini CLI 0.62 itself offers. Prices are OpenRouter's catalog
 * for `google/<id>` as of September 2026 (USD per million tokens); `init` refreshes them when the catalog is reachable.
 */
export const GEMINI_API_CANDIDATES: Readonly<Record<Tier, GeminiDefault>> = {
  fast: { model: "gemini-3.1-flash-lite", catalog: "google/gemini-3.1-flash-lite", price: { in: 0.25, out: 1.5 }, effort: FLASH_EFFORT },
  mid: { model: "gemini-3.8-flash", catalog: "google/gemini-3.8-flash", price: { in: 0.75, out: 3.75 }, effort: FLASH_EFFORT },
  frontier: {
    model: "gemini-3.1-pro-preview",
    catalog: "google/gemini-3.1-pro-preview",
    price: { in: 2, out: 12 },
    effort: PRO_EFFORT,
  },
};

/**
 * Login-with-Google ladder: the ids Gemini CLI sends to the Code Assist backend for its flash-lite, flash, and pro
 * aliases (it maps flash to `gemini-3-flash` there). Prices are API list-price equivalents, the scale the plan's
 * allowance is weighed on; `gemini-3-flash` is priced from `google/gemini-3-flash-preview`.
 */
export const GEMINI_CODE_ASSIST_CANDIDATES: Readonly<Record<Tier, GeminiDefault>> = {
  fast: { model: "gemini-3.1-flash-lite", catalog: "google/gemini-3.1-flash-lite", price: { in: 0.25, out: 1.5 }, effort: FLASH_EFFORT },
  mid: { model: "gemini-3-flash", catalog: "google/gemini-3-flash-preview", price: { in: 0.5, out: 3 }, effort: FLASH_EFFORT },
  frontier: {
    model: "gemini-3.1-pro-preview",
    catalog: "google/gemini-3.1-pro-preview",
    price: { in: 2, out: 12 },
    effort: PRO_EFFORT,
  },
};

export interface GeminiPolicyParts {
  readonly egressName: string;
  readonly egress: EgressInput;
  readonly candidates: Readonly<Record<string, CandidateInput>>;
  /** Candidate ids per tier, cheapest first. */
  readonly tiers: { readonly fast: string; readonly mid: string; readonly frontier: string };
}

export type GeminiAuth = "api-key" | "google-login";

/** Egress and candidates for Gemini CLI, over its Google login or an API key. */
export function geminiPolicyParts(
  auth: GeminiAuth,
  catalog?: ReadonlyMap<string, { readonly price: { in: number; out: number } }>,
): GeminiPolicyParts {
  const login = auth === "google-login";
  const egressName = login ? GEMINI_CODE_ASSIST_EGRESS : GEMINI_API_EGRESS;
  // `dialects` keeps every other harness's traffic off these egresses: each upstream speaks only its own format.
  const egress: EgressInput = login
    ? {
        base_url: "https://cloudcode-pa.googleapis.com",
        mount: GEMINI_CODE_ASSIST_MOUNT,
        forward_auth: true,
        billing: "subscription",
        dialects: ["gemini-code-assist"],
      }
    : {
        base_url: "https://generativelanguage.googleapis.com",
        api_key_env: GEMINI_API_KEY_ENV,
        mount: GEMINI_API_MOUNT,
        dialects: ["gemini"],
      };
  const table = login ? GEMINI_CODE_ASSIST_CANDIDATES : GEMINI_API_CANDIDATES;
  const prefix = login ? "gemini-login" : "gemini";
  const ids = { fast: `${prefix}-lite`, mid: `${prefix}-flash`, frontier: `${prefix}-pro` } as const;
  const candidates: Record<string, CandidateInput> = {};
  for (const tier of ["fast", "mid", "frontier"] as const) {
    const c = table[tier];
    candidates[ids[tier]] = {
      model: c.model,
      via: egressName,
      price: catalog?.get(c.catalog)?.price ?? c.price,
      effort: [...c.effort],
      capabilities: { vision: true, tools: true, context: CONTEXT },
    };
  }
  return { egressName, egress, candidates, tiers: ids };
}
