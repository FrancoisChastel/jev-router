import type { CandidateInput, JudgeTransport, PolicyInput } from "../core/policy/types";

/**
 * Curated default candidates. Model ids are the `creator/model` slugs shared by OpenRouter and Vercel AI Gateway.
 * Prices are USD per million tokens as last checked and are refreshed from the live catalog by `init` when reachable.
 */
export interface DefaultCandidate extends CandidateInput {
  readonly effort: readonly ("minimal" | "low" | "medium" | "high" | "xhigh" | "max")[];
}

export const DEFAULT_CANDIDATES: Readonly<Record<"fast" | "mid" | "frontier", DefaultCandidate>> = {
  fast: {
    model: "openai/gpt-6-luna",
    price: { in: 0.1, out: 0.5 },
    effort: ["low", "medium", "high"],
    capabilities: { vision: true, tools: true, context: 1_050_000 },
  },
  mid: {
    model: "anthropic/claude-sonnet-5",
    price: { in: 2, out: 10 },
    effort: ["low", "medium", "high", "xhigh"],
    capabilities: { vision: true, tools: true, context: 1_000_000 },
  },
  frontier: {
    model: "anthropic/claude-opus-5.5",
    price: { in: 4, out: 20 },
    effort: ["low", "medium", "high", "xhigh", "max"],
    capabilities: { vision: true, tools: true, context: 1_000_000 },
  },
};

export const DEFAULT_RULES = [
  { when: "request_class in [auxiliary, compaction]", then: { pin: "fast" } },
  { when: "difficulty >= 2 or needs_reasoning > 0.8", then: { at_least: "mid" } },
  { when: "stakes >= 2.5", then: { at_least: "mid" } },
  { when: "stakes >= 2 and difficulty >= 3", then: { at_least: "frontier", effort: "high" } },
  { when: "tools_failed > 0.7 or spinning > 0.7", then: { up: 1 } },
  { when: "producing > 0.8 and tools_failed < 0.2", then: { allow_down: true } },
] as const;

export type EgressName = "openrouter" | "vercel";

export const EGRESS_DEFAULTS: Readonly<
  Record<
    EgressName,
    { readonly base_url: string; readonly api_key_env: string; readonly judge: JudgeTransport; readonly judge_model: string }
  >
> = {
  openrouter: {
    base_url: "https://openrouter.ai/api",
    api_key_env: "OPENROUTER_API_KEY",
    judge: "openrouter",
    judge_model: "typesafe/jev-1.13",
  },
  vercel: { base_url: "https://ai-gateway.vercel.sh", api_key_env: "AI_GATEWAY_API_KEY", judge: "vercel", judge_model: "typesafe-ai/jev" },
};

export interface KeyDetection {
  readonly judge: JudgeTransport;
  readonly judgeKeyEnv: string;
  /** Undefined when no inference key was found; the relay then has nowhere to send traffic, but the Pi extension still works. */
  readonly egress?: EgressName;
  readonly found: readonly string[];
}

/**
 * Pick the judge and egress from the keys present. Preference: an inference gateway key also serves the judge
 * (one key, one bill); a TypeSafe key is used for the judge when it is the only judge-capable key or when
 * explicitly preferred.
 */
export function detectKeys(
  env: Readonly<Record<string, string | undefined>>,
  prefer?: { readonly judge?: JudgeTransport; readonly egress?: EgressName },
): KeyDetection {
  const has = (k: string) => typeof env[k] === "string" && env[k] !== "";
  const found = ["OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY"].filter(has);
  const egress: EgressName | undefined =
    prefer?.egress ?? (has("OPENROUTER_API_KEY") ? "openrouter" : has("AI_GATEWAY_API_KEY") ? "vercel" : undefined);
  let judge: JudgeTransport;
  if (prefer?.judge) judge = prefer.judge;
  else if (egress) judge = EGRESS_DEFAULTS[egress].judge;
  else if (has("TYPESAFE_API_KEY")) judge = "typesafe";
  else judge = "mock";
  const judgeKeyEnv =
    judge === "typesafe"
      ? "TYPESAFE_API_KEY"
      : judge === "vercel"
        ? "AI_GATEWAY_API_KEY"
        : judge === "openrouter"
          ? "OPENROUTER_API_KEY"
          : "";
  return { judge, judgeKeyEnv, ...(egress ? { egress } : {}), found };
}

export interface CatalogEntry {
  readonly id: string;
  readonly price: { readonly in: number; readonly out: number };
  readonly context?: number;
  readonly vision?: boolean;
  readonly tools?: boolean;
}

/** Parse OpenRouter's public /api/v1/models listing into the fields the policy needs. */
export function parseOpenRouterCatalog(json: unknown): ReadonlyMap<string, CatalogEntry> {
  const out = new Map<string, CatalogEntry>();
  const data = (json as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return out;
  for (const m of data) {
    if (typeof m !== "object" || m === null) continue;
    const o = m as Record<string, unknown>;
    const pricing = (o.pricing ?? {}) as Record<string, unknown>;
    const inP = Number(pricing.prompt);
    const outP = Number(pricing.completion);
    if (typeof o.id !== "string" || !Number.isFinite(inP) || !Number.isFinite(outP) || inP < 0) continue;
    const arch = (o.architecture ?? {}) as { input_modalities?: unknown };
    const params = Array.isArray(o.supported_parameters) ? (o.supported_parameters as unknown[]) : [];
    out.set(o.id, {
      id: o.id,
      price: { in: inP * 1_000_000, out: outP * 1_000_000 },
      ...(typeof o.context_length === "number" ? { context: o.context_length } : {}),
      vision: Array.isArray(arch.input_modalities) && arch.input_modalities.includes("image"),
      tools: params.includes("tools"),
    });
  }
  return out;
}

export interface BuildPolicyOptions {
  readonly detection: KeyDetection;
  /** Live catalog entries to refresh prices and capabilities from; absent entries keep the curated values. */
  readonly catalog?: ReadonlyMap<string, CatalogEntry>;
}

/** Build a complete, valid policy document from the detected keys and the curated candidates. */
export function buildDefaultPolicy(opts: BuildPolicyOptions): PolicyInput {
  const { detection, catalog } = opts;
  const egress = detection.egress ? EGRESS_DEFAULTS[detection.egress] : undefined;
  const candidates: Record<string, CandidateInput> = {};
  for (const [id, c] of Object.entries(DEFAULT_CANDIDATES)) {
    const live = catalog?.get(c.model);
    candidates[id] = {
      model: c.model,
      ...(detection.egress ? { via: detection.egress } : {}),
      price: live?.price ?? c.price,
      effort: [...c.effort],
      capabilities: {
        vision: live?.vision ?? c.capabilities?.vision ?? true,
        tools: live?.tools ?? c.capabilities?.tools ?? true,
        ...((live?.context ?? c.capabilities?.context) ? { context: live?.context ?? (c.capabilities?.context as number) } : {}),
      },
    };
  }
  const judgeModel =
    detection.judge === "openrouter"
      ? EGRESS_DEFAULTS.openrouter.judge_model
      : detection.judge === "vercel"
        ? EGRESS_DEFAULTS.vercel.judge_model
        : detection.judge === "typesafe"
          ? "jev-latest"
          : undefined;
  return {
    version: 1,
    judge: {
      transport: detection.judge,
      ...(judgeModel ? { model: judgeModel } : {}),
      ...(detection.judgeKeyEnv ? { api_key_env: detection.judgeKeyEnv } : {}),
      timeout_ms: 1500,
      on_error: "fail_open",
      mode: "signals",
    },
    ...(egress && detection.egress
      ? { egress: { [detection.egress]: { base_url: egress.base_url, api_key_env: egress.api_key_env } } }
      : {}),
    candidates,
    routes: [
      { id: "auto", harness: "any", policy: "default" },
      { id: "claude-code/auto", harness: "claude-code", policy: "default" },
    ],
    policies: {
      default: {
        default: "fast",
        min_confidence: 0.6,
        hold_turns: 2,
        confidence_threshold: 0.5,
        rules: DEFAULT_RULES.map((r) => ({ when: r.when, then: { ...r.then } })),
        switch: { cache_penalty: true, prefer_effort_over_model: false },
      },
    },
  };
}
