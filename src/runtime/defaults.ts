import type {
  CandidateInput,
  EgressInput,
  JudgeTransport,
  PolicyDefInput,
  PolicyInput,
  RouteInput,
  RuleAction,
  RuleInput,
} from "../core/policy/types";
import type { CodexModel, SubscriptionDetection } from "./subscriptions";

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

// Escalate on evidence, not on an upfront guess: on a 12-task Terminal-Bench subset the earlier thresholds
// (difficulty >= 2 or needs_reasoning > 0.8; any tools_failed > 0.7) escalated a quarter of the tasks for no gain in
// success and a 180x higher cost per solved task. See docs/evaluation.md.
export const DEFAULT_RULES = [
  { when: "request_class in [auxiliary, compaction]", then: { pin: "fast" } },
  { when: "difficulty >= 2.5 and needs_reasoning > 0.8", then: { at_least: "mid" } },
  { when: "stakes >= 2.5", then: { at_least: "mid" } },
  { when: "stakes >= 2 and difficulty >= 3", then: { at_least: "frontier", effort: "high" } },
  { when: "spinning > 0.7 or (tools_failed > 0.7 and spinning > 0.5)", then: { up: 1 } },
  { when: "producing > 0.8 and tools_failed < 0.2", then: { allow_down: true } },
] as const;

export interface TierIds {
  readonly fast: string;
  readonly mid?: string;
  readonly frontier?: string;
}

/** The default rules with tier names replaced by candidate ids; rules aimed at a tier the policy lacks are dropped. */
export function rulesFor(tiers: TierIds): RuleInput[] {
  const out: RuleInput[] = [];
  for (const r of DEFAULT_RULES) {
    const then: Record<string, unknown> = { ...r.then };
    let applicable = true;
    for (const key of ["pin", "at_least"] as const) {
      const v = then[key];
      if (typeof v !== "string") continue;
      const mapped = tiers[v as keyof TierIds];
      if (!mapped) {
        applicable = false;
        break;
      }
      then[key] = mapped;
    }
    if (applicable) out.push({ when: r.when, then: then as RuleAction });
  }
  return out;
}

/**
 * Models a Claude Code login can use through api.anthropic.com. Prices are Anthropic's API list prices, which is also
 * how a plan's usage allowance is consumed, so they double as quota weights. `catalog` is the gateway id `init` uses
 * to refresh them. Effort lists match what Claude Code itself offers per model, so a user's effort choice is never
 * clamped on the way through.
 */
export const ANTHROPIC_SUBSCRIPTION_CANDIDATES: Readonly<
  Record<"claude-haiku" | "claude-sonnet" | "claude-opus", DefaultCandidate & { readonly catalog: string }>
> = {
  "claude-haiku": {
    model: "claude-haiku-4-5",
    catalog: "anthropic/claude-haiku-4.5",
    price: { in: 1, out: 5 },
    effort: ["low", "medium", "high"],
    capabilities: { vision: true, tools: true, context: 200_000 },
  },
  "claude-sonnet": {
    model: "claude-sonnet-5",
    catalog: "anthropic/claude-sonnet-5",
    price: { in: 2, out: 10 },
    effort: ["low", "medium", "high", "xhigh"],
    capabilities: { vision: true, tools: true, context: 1_000_000 },
  },
  "claude-opus": {
    model: "claude-opus-5-5",
    catalog: "anthropic/claude-opus-5.5",
    price: { in: 4, out: 20 },
    effort: ["low", "medium", "high", "xhigh", "max"],
    capabilities: { vision: true, tools: true, context: 1_000_000 },
  },
};

/** API list prices for Codex models, used as quota weights when the live catalog is unreachable. */
export const CODEX_KNOWN_PRICES: Readonly<Record<string, { readonly in: number; readonly out: number }>> = {
  "gpt-6-luna": { in: 0.1, out: 0.5 },
  "gpt-6-sol": { in: 2, out: 10 },
  "gpt-6-astra": { in: 10, out: 50 },
  "gpt-5.6-luna": { in: 0.2, out: 1.2 },
  "gpt-5.6-sol": { in: 2, out: 10 },
  "gpt-5.6-terra": { in: 2, out: 12 },
  "gpt-5.5": { in: 5, out: 30 },
};

export const ANTHROPIC_SUBSCRIPTION_EGRESS = "anthropic-subscription";
export const CHATGPT_SUBSCRIPTION_EGRESS = "chatgpt-subscription";
/** Relay path Codex's ChatGPT-authenticated provider is pointed at; the sub-paths mirror chatgpt.com/backend-api/codex. */
export const CHATGPT_MOUNT = "/backend-api/codex";

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
  /** Coding subscriptions found on this machine; each adds its own candidates, egress, route, and policy. */
  readonly subscriptions?: SubscriptionDetection;
}

interface PricedCodexModel {
  readonly model: CodexModel;
  readonly price: { readonly in: number; readonly out: number };
}

/**
 * Pick fast, mid, and frontier among the models a ChatGPT plan lists, by API list price: the cheapest, the priciest,
 * and the first model that costs at least five times the cheapest (a real step up rather than a sibling).
 */
export function codexTiers(models: readonly CodexModel[], catalog?: ReadonlyMap<string, CatalogEntry>): readonly PricedCodexModel[] {
  const priced: PricedCodexModel[] = [];
  for (const model of models) {
    if (!model.listed) continue;
    const price = catalog?.get(`openai/${model.slug}`)?.price ?? CODEX_KNOWN_PRICES[model.slug];
    if (price) priced.push({ model, price });
  }
  priced.sort((a, b) => a.price.in - b.price.in || a.model.priority - b.model.priority);
  const fast = priced[0];
  if (!fast) return [];
  const frontier = priced.length > 1 ? priced[priced.length - 1] : undefined;
  const mid = priced.slice(1, -1).find((p) => p.price.in >= fast.price.in * 5);
  return [fast, ...(mid ? [mid] : []), ...(frontier ? [frontier] : [])];
}

const codexCandidate = (p: PricedCodexModel): CandidateInput => ({
  model: p.model.slug,
  via: CHATGPT_SUBSCRIPTION_EGRESS,
  price: p.price,
  ...(p.model.effort.length > 0 ? { effort: [...p.model.effort] } : {}),
  ...(p.model.defaultEffort ? { default_effort: p.model.defaultEffort } : {}),
  capabilities: { vision: true, tools: true, ...(p.model.context ? { context: p.model.context } : {}) },
});

const policyDef = (defaultId: string, order: readonly string[], rules: readonly RuleInput[]): PolicyDefInput => ({
  default: defaultId,
  order: [...order],
  min_confidence: 0.6,
  hold_turns: 2,
  confidence_threshold: 0.5,
  rules: [...rules],
  switch: { cache_penalty: true, prefer_effort_over_model: true },
});

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
  const egressMap: Record<string, EgressInput> = {};
  if (egress && detection.egress) egressMap[detection.egress] = { base_url: egress.base_url, api_key_env: egress.api_key_env };
  const routes: RouteInput[] = [{ id: "auto", harness: "any", policy: "default" }];
  const policies: Record<string, PolicyDefInput> = {
    default: policyDef("fast", ["fast", "mid", "frontier"], rulesFor({ fast: "fast", mid: "mid", frontier: "frontier" })),
  };

  const subs = opts.subscriptions;
  if (subs?.anthropic) {
    egressMap[ANTHROPIC_SUBSCRIPTION_EGRESS] = { base_url: "https://api.anthropic.com", forward_auth: true, billing: "subscription" };
    for (const [id, c] of Object.entries(ANTHROPIC_SUBSCRIPTION_CANDIDATES)) {
      const live = catalog?.get(c.catalog);
      candidates[id] = {
        model: c.model,
        via: ANTHROPIC_SUBSCRIPTION_EGRESS,
        price: live?.price ?? c.price,
        effort: [...c.effort],
        capabilities: { vision: true, tools: true, ...(c.capabilities?.context ? { context: c.capabilities.context } : {}) },
      };
    }
    routes.push({ id: "claude-code/auto", harness: "claude-code", policy: "claude-code" });
    // Sonnet is where Claude Code users already live; Haiku takes auxiliary calls, Opus the turns that earn it.
    policies["claude-code"] = policyDef(
      "claude-sonnet",
      ["claude-haiku", "claude-sonnet", "claude-opus"],
      rulesFor({ fast: "claude-haiku", mid: "claude-sonnet", frontier: "claude-opus" }),
    );
  } else {
    routes.push({ id: "claude-code/auto", harness: "claude-code", policy: "default" });
  }
  if (subs?.chatgpt) {
    const tiers = codexTiers(subs.chatgpt.models, catalog);
    const [fast, second, third] = tiers;
    if (fast) {
      egressMap[CHATGPT_SUBSCRIPTION_EGRESS] = {
        base_url: "https://chatgpt.com/backend-api/codex",
        mount: CHATGPT_MOUNT,
        forward_auth: true,
        billing: "subscription",
      };
      const ids: TierIds = {
        fast: "codex-fast",
        ...(tiers.length === 3
          ? { mid: "codex-mid", frontier: "codex-frontier" }
          : tiers.length === 2
            ? { frontier: "codex-frontier" }
            : {}),
      };
      candidates["codex-fast"] = codexCandidate(fast);
      if (tiers.length === 3 && second && third) {
        candidates["codex-mid"] = codexCandidate(second);
        candidates["codex-frontier"] = codexCandidate(third);
      } else if (tiers.length === 2 && second) {
        candidates["codex-frontier"] = codexCandidate(second);
      }
      const order = ["codex-fast", ...(ids.mid ? [ids.mid] : []), ...(ids.frontier ? [ids.frontier] : [])];
      routes.push({ id: "auto", harness: "codex", policy: "codex" });
      policies.codex = policyDef("codex-fast", order, rulesFor(ids));
    }
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
    ...(Object.keys(egressMap).length > 0 ? { egress: egressMap } : {}),
    candidates,
    routes,
    policies,
  };
}

/** Human-readable summary of what each subscription contributes, for `init` and `setup` output. */
export function describeSubscriptions(subs: SubscriptionDetection | undefined, catalog?: ReadonlyMap<string, CatalogEntry>): string[] {
  const lines: string[] = [];
  if (subs?.anthropic) {
    const a = subs.anthropic;
    lines.push(
      `claude  Claude Code login (${a.plan}${a.tier ? `, ${a.tier}` : ""}): claude-code/auto routes ${Object.values(
        ANTHROPIC_SUBSCRIPTION_CANDIDATES,
      )
        .map((c) => c.model)
        .join(", ")} on your plan`,
    );
  }
  if (subs?.chatgpt) {
    const tiers = codexTiers(subs.chatgpt.models, catalog);
    lines.push(
      tiers.length > 0
        ? `codex   Codex login (${subs.chatgpt.plan}, models from ${subs.chatgpt.modelsFrom}): auto routes ${tiers.map((t) => t.model.slug).join(" < ")} on your plan`
        : `codex   Codex login (${subs.chatgpt.plan}) but no priced model in its catalog; Codex keeps the gateway route`,
    );
  }
  return lines;
}
