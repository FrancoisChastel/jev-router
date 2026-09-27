import type { JudgeConfig } from "../core/policy/types";
import { type FetchLike, HttpJudge } from "../judge/http";
import type { Judge } from "../judge/types";
import type { Env } from "./paths";

const DEFAULT_KEY_ENV = { openrouter: "OPENROUTER_API_KEY", vercel: "AI_GATEWAY_API_KEY", typesafe: "TYPESAFE_API_KEY" } as const;

export interface JudgeFactoryOptions {
  readonly fetch?: FetchLike;
}

/**
 * Build the judge named by the policy. Returns undefined for the mock transport so callers run
 * deterministic-only. Throws a clear error when the API key is missing rather than failing later.
 */
export function createJudge(cfg: JudgeConfig, env: Env = process.env, opts: JudgeFactoryOptions = {}): Judge | undefined {
  if (cfg.transport === "mock") return undefined;
  const keyEnv = cfg.api_key_env ?? DEFAULT_KEY_ENV[cfg.transport];
  const apiKey = env[keyEnv];
  if (!apiKey) throw new Error(`judge transport '${cfg.transport}' needs an API key in $${keyEnv}`);
  return new HttpJudge({
    transport: cfg.transport,
    apiKey,
    timeoutMs: cfg.timeout_ms,
    ...(cfg.model ? { model: cfg.model } : {}),
    ...(cfg.base_url ? { baseUrl: cfg.base_url } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}
