import type { Effort, Harness, ToolClass, WireDialect } from "../types";
import type { CompiledExpr } from "./expr";

export type JudgeTransport = "typesafe" | "vercel" | "openrouter" | "mock";
export type JudgeMode = "signals" | "option_pick";

export interface JudgeConfigInput {
  readonly transport: JudgeTransport;
  readonly model?: string;
  readonly base_url?: string;
  readonly api_key_env?: string;
  readonly timeout_ms?: number;
  readonly on_error?: "fail_open" | "fail_closed";
  readonly mode?: JudgeMode;
}

export interface EgressInput {
  readonly base_url: string;
  readonly api_key_env?: string;
  /** Pi provider name that serves this egress, when it differs from the egress key. */
  readonly pi_provider?: string;
  /** Forward the caller's own credentials instead of the configured key. */
  readonly forward_auth?: boolean;
  /**
   * Relay path prefix this egress serves, for example "/backend-api/codex". Requests under it keep their sub-path:
   * an inference sub-path (`/responses`, `/chat/completions`, `/messages`) is routed, anything else is proxied unchanged.
   */
  readonly mount?: string;
  /** `subscription` marks an upstream billed by a plan; candidate prices are then API-equivalent weights, not dollars. */
  readonly billing?: "usd" | "subscription";
  /** Send no credentials at all, for a local server such as Ollama. */
  readonly no_auth?: boolean;
  /** Wire formats the upstream accepts. Candidates behind this egress are skipped for other formats. Default: all. */
  readonly dialects?: readonly WireDialect[];
}

export interface CandidateCapabilities {
  readonly vision?: boolean;
  readonly tools?: boolean;
  /** Context window in tokens. */
  readonly context?: number;
}

export interface CandidateInput {
  readonly model: string;
  readonly via?: string;
  /** USD per million tokens. */
  readonly price: { readonly in: number; readonly out: number };
  readonly effort?: readonly Effort[];
  readonly default_effort?: Effort;
  readonly capabilities?: CandidateCapabilities;
  /** Free-text description used only in option_pick mode. */
  readonly description?: string;
  /** Per-adapter overrides for how this candidate is addressed inside Pi. */
  readonly pi?: { readonly provider?: string; readonly model?: string };
}

export interface RuleAction {
  readonly pin?: string;
  readonly at_least?: string;
  /** A cap: never serve above this tier this turn, whatever else decided. Applied after every other action. */
  readonly at_most?: string;
  readonly up?: number;
  readonly allow_down?: boolean;
  readonly effort?: Effort;
  readonly hold_turns?: number;
}

export interface RuleInput {
  readonly when: string;
  readonly then: RuleAction;
}

export interface SwitchInput {
  readonly cache_penalty?: boolean;
  readonly prefer_effort_over_model?: boolean;
}

/** What makes a routed response count as a failed attempt worth retrying one tier up. */
export type CascadeTrigger = "upstream_error" | "empty" | "refusal" | "truncated";

export interface CascadeInput {
  readonly enabled?: boolean;
  readonly on?: readonly CascadeTrigger[];
  /** How many further tiers to try after the first attempt. */
  readonly max_retries?: number;
  /** Hold the first attempt's response back until it has been assessed. Without it only `upstream_error` can trigger. */
  readonly buffer?: boolean;
  readonly buffer_max_bytes?: number;
  readonly buffer_max_ms?: number;
  /** A retry is not started when its estimated cost would push the request's total above this. */
  readonly budget_usd?: number;
}

export interface PolicyDefInput {
  readonly default: string;
  /** Candidates this policy may use, cheapest first. Defaults to every candidate ordered by input price. */
  readonly order?: readonly string[];
  readonly min_confidence?: number;
  readonly hold_turns?: number;
  readonly confidence_threshold?: number;
  readonly recent_turn_window?: number;
  readonly est_output_tokens?: number;
  readonly rules: readonly RuleInput[];
  readonly switch?: SwitchInput;
  readonly tool_semantics?: Partial<Record<ToolClass, readonly string[]>>;
  readonly cascade?: CascadeInput;
}

export interface RouteInput {
  readonly id: string;
  readonly harness: Harness | "any";
  readonly policy: string;
}

export interface PolicyInput {
  readonly version: 1;
  readonly judge: JudgeConfigInput;
  readonly egress?: Readonly<Record<string, EgressInput>>;
  readonly candidates: Readonly<Record<string, CandidateInput>>;
  readonly routes: readonly RouteInput[];
  readonly policies: Readonly<Record<string, PolicyDefInput>>;
}

/* Loaded, validated, defaulted forms. */

export type Candidate = CandidateInput;

export interface Rule {
  readonly when: string;
  readonly expr: CompiledExpr;
  readonly then: RuleAction;
}

export interface PolicyDef {
  readonly default: string;
  readonly order: readonly string[];
  readonly min_confidence: number;
  readonly hold_turns: number;
  readonly confidence_threshold: number;
  readonly recent_turn_window: number;
  readonly est_output_tokens: number;
  readonly rules: readonly Rule[];
  readonly switch: Required<SwitchInput>;
  readonly tool_semantics: Partial<Record<ToolClass, readonly string[]>>;
  readonly cascade: Cascade;
}

export interface Cascade {
  readonly enabled: boolean;
  readonly on: readonly CascadeTrigger[];
  readonly max_retries: number;
  readonly buffer: boolean;
  readonly buffer_max_bytes: number;
  readonly buffer_max_ms: number;
  readonly budget_usd?: number;
}

export interface JudgeConfig extends JudgeConfigInput {
  readonly timeout_ms: number;
  readonly on_error: "fail_open" | "fail_closed";
  readonly mode: JudgeMode;
}

export interface Policy {
  readonly version: 1;
  readonly judge: JudgeConfig;
  readonly egress: Readonly<Record<string, EgressInput>>;
  readonly candidates: Readonly<Record<string, Candidate>>;
  readonly routes: readonly RouteInput[];
  readonly policies: Readonly<Record<string, PolicyDef>>;
}
