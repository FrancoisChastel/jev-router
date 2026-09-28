import { knownIdentifiers } from "../context-keys";
import { SINGLE_AXIS_CONFIDENCE } from "../signals/stage";
import { EFFORT_ORDER, type Effort, type Harness } from "../types";
import { type CompiledExpr, compileExpr, ExprError } from "./expr";
import type {
  Candidate,
  CandidateInput,
  EgressInput,
  JudgeMode,
  Policy,
  PolicyDef,
  PolicyDefInput,
  PolicyInput,
  Rule,
  RuleAction,
} from "./types";

export type { CompiledExpr, ExprContext, ExprValue } from "./expr";
export { compileExpr, ExprError, evaluateExpr } from "./expr";
export type * from "./types";

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

const DEFAULTS = {
  min_confidence: 0.6,
  hold_turns: 2,
  confidence_threshold: 0.5,
  recent_turn_window: 3,
  est_output_tokens: 600,
  timeout_ms: 1500,
} as const;
const ACTION_KEYS: ReadonlySet<string> = new Set(["pin", "at_least", "up", "allow_down", "effort", "hold_turns"]);
const TOOL_CLASSES: ReadonlySet<string> = new Set(["observe", "mutate", "plan", "new", "shell", "other"]);
const TRANSPORTS: ReadonlySet<string> = new Set(["typesafe", "vercel", "openrouter", "mock"]);
const HARNESSES: ReadonlySet<string> = new Set<Harness | "any">(["pi", "claude-code", "codex", "opencode", "hermes", "unknown", "any"]);

function fail(message: string): never {
  throw new PolicyError(message);
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function unit(v: unknown, name: string): number {
  if (typeof v !== "number" || Number.isNaN(v) || v < 0 || v > 1) fail(`${name} must be a number between 0 and 1`);
  return v;
}
function nonNegInt(v: unknown, name: string): number {
  if (!Number.isInteger(v) || (v as number) < 0) fail(`${name} must be a non-negative integer`);
  return v as number;
}
function isEffort(v: unknown): v is Effort {
  return typeof v === "string" && (EFFORT_ORDER as readonly string[]).includes(v);
}

function validateCandidate(id: string, c: unknown): Candidate {
  if (!isRecord(c)) fail(`candidate '${id}' must be an object`);
  if (typeof c.model !== "string" || c.model === "") fail(`candidate '${id}' needs a model`);
  if (!isRecord(c.price) || typeof c.price.in !== "number" || typeof c.price.out !== "number" || c.price.in < 0 || c.price.out < 0)
    fail(`candidate '${id}' needs price.in and price.out`);
  if (c.effort !== undefined && (!Array.isArray(c.effort) || !c.effort.every(isEffort)))
    fail(`candidate '${id}' has invalid effort levels`);
  if (c.default_effort !== undefined && !isEffort(c.default_effort)) fail(`candidate '${id}' has an invalid default_effort`);
  if (
    c.pi !== undefined &&
    (!isRecord(c.pi) ||
      (c.pi.provider !== undefined && typeof c.pi.provider !== "string") ||
      (c.pi.model !== undefined && typeof c.pi.model !== "string"))
  ) {
    fail(`candidate '${id}' has an invalid pi override`);
  }
  if (c.description !== undefined && typeof c.description !== "string") fail(`candidate '${id}' description must be a string`);
  if (c.via !== undefined && typeof c.via !== "string") fail(`candidate '${id}' via must be a string`);
  if (c.capabilities !== undefined) {
    const caps = c.capabilities;
    const ok =
      isRecord(caps) &&
      (caps.vision === undefined || typeof caps.vision === "boolean") &&
      (caps.tools === undefined || typeof caps.tools === "boolean") &&
      (caps.context === undefined || (Number.isInteger(caps.context) && (caps.context as number) > 0));
    if (!ok) fail(`candidate '${id}' capabilities must be { vision?: boolean, tools?: boolean, context?: positive integer }`);
  }
  return c as unknown as CandidateInput;
}

function validateAction(action: unknown, where: string, candidates: ReadonlySet<string>): RuleAction {
  if (!isRecord(action)) fail(`${where}: action must be an object`);
  for (const key of Object.keys(action)) if (!ACTION_KEYS.has(key)) fail(`${where}: unknown action '${key}'`);
  if (action.pin !== undefined && !candidates.has(String(action.pin)))
    fail(`${where}: pin references unknown candidate '${String(action.pin)}'`);
  if (action.at_least !== undefined && !candidates.has(String(action.at_least)))
    fail(`${where}: at_least references unknown candidate '${String(action.at_least)}'`);
  if (action.up !== undefined && (!Number.isInteger(action.up) || (action.up as number) < 1))
    fail(`${where}: up must be a positive integer`);
  if (action.allow_down !== undefined && typeof action.allow_down !== "boolean") fail(`${where}: allow_down must be boolean`);
  if (action.effort !== undefined && !isEffort(action.effort)) fail(`${where}: invalid effort`);
  if (action.hold_turns !== undefined) nonNegInt(action.hold_turns, `${where}: hold_turns`);
  if (Object.keys(action).length === 0) fail(`${where}: action is empty`);
  return action as RuleAction;
}

function validatePolicyDef(
  id: string,
  def: unknown,
  candidateIds: readonly string[],
  candidates: Readonly<Record<string, Candidate>>,
  mode: JudgeMode,
): PolicyDef {
  const where = `policy '${id}'`;
  if (!isRecord(def)) fail(`${where} must be an object`);
  const ids = new Set(candidateIds);
  if (typeof def.default !== "string" || !ids.has(def.default))
    fail(`${where}: default references unknown candidate '${String(def.default)}'`);

  let order: readonly string[];
  if (def.order !== undefined) {
    if (!Array.isArray(def.order) || !def.order.every((c) => typeof c === "string" && ids.has(c)))
      fail(`${where}: order must list known candidates`);
    if (new Set(def.order).size !== def.order.length) fail(`${where}: order must not repeat a candidate`);
    if (!def.order.includes(def.default)) fail(`${where}: default '${def.default}' must be listed in order`);
    order = [...(def.order as string[])];
  } else {
    order = [...candidateIds].sort(
      (a, b) => (candidates[a] as Candidate).price.in - (candidates[b] as Candidate).price.in || a.localeCompare(b),
    );
  }

  const min_confidence = def.min_confidence === undefined ? DEFAULTS.min_confidence : unit(def.min_confidence, `${where}: min_confidence`);
  const confidence_threshold =
    def.confidence_threshold === undefined
      ? DEFAULTS.confidence_threshold
      : unit(def.confidence_threshold, `${where}: confidence_threshold`);
  if (confidence_threshold < SINGLE_AXIS_CONFIDENCE) {
    fail(
      `${where}: confidence_threshold must be at least ${SINGLE_AXIS_CONFIDENCE.toFixed(3)}; below that a single tool-signal axis can escalate or de-escalate without corroboration`,
    );
  }
  const hold_turns = def.hold_turns === undefined ? DEFAULTS.hold_turns : nonNegInt(def.hold_turns, `${where}: hold_turns`);
  const recent_turn_window =
    def.recent_turn_window === undefined ? DEFAULTS.recent_turn_window : nonNegInt(def.recent_turn_window, `${where}: recent_turn_window`);
  if (recent_turn_window < 1) fail(`${where}: recent_turn_window must be at least 1`);
  const est_output_tokens =
    def.est_output_tokens === undefined ? DEFAULTS.est_output_tokens : nonNegInt(def.est_output_tokens, `${where}: est_output_tokens`);

  if (!Array.isArray(def.rules)) fail(`${where}: rules must be an array`);
  const known = knownIdentifiers(mode);
  const rules: Rule[] = def.rules.map((r: unknown, i: number) => {
    const rw = `${where} rule ${i}`;
    if (!isRecord(r) || typeof r.when !== "string") fail(`${rw}: needs a 'when' string`);
    let expr: CompiledExpr;
    try {
      expr = compileExpr(r.when);
    } catch (e) {
      fail(`${rw}: invalid expression: ${e instanceof ExprError ? e.message : String(e)}`);
    }
    const unknown = [...expr.identifiers].filter((name) => !known.has(name));
    if (unknown.length > 0)
      fail(`${rw}: unknown identifier${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; known: ${[...known].join(", ")}`);
    return { when: r.when, expr, then: validateAction(r.then, rw, new Set(order)) };
  });

  const sw = def.switch === undefined ? {} : def.switch;
  if (!isRecord(sw)) fail(`${where}: switch must be an object`);
  const tool_semantics: Partial<Record<string, readonly string[]>> = {};
  if (def.tool_semantics !== undefined) {
    if (!isRecord(def.tool_semantics)) fail(`${where}: tool_semantics must be an object`);
    for (const [k, v] of Object.entries(def.tool_semantics)) {
      if (!TOOL_CLASSES.has(k) || !Array.isArray(v) || !v.every((x) => typeof x === "string"))
        fail(`${where}: tool_semantics.${k} must be a list of tool names`);
      tool_semantics[k] = [...(v as string[])];
    }
  }

  return {
    default: def.default,
    order,
    min_confidence,
    hold_turns,
    confidence_threshold,
    recent_turn_window,
    est_output_tokens,
    rules,
    switch: { cache_penalty: sw.cache_penalty === true, prefer_effort_over_model: sw.prefer_effort_over_model === true },
    tool_semantics: tool_semantics as PolicyDef["tool_semantics"],
  };
}

/** Validate and normalize a policy document. Never mutates the input. */
export function loadPolicy(input: PolicyInput | unknown): Policy {
  const raw: unknown = structuredClone(input);
  if (!isRecord(raw)) fail("policy must be an object");
  if (raw.version !== 1) fail("policy version must be 1");
  if (!isRecord(raw.judge) || !TRANSPORTS.has(String(raw.judge.transport)))
    fail("judge.transport must be one of typesafe, vercel, openrouter, mock");
  const judge = raw.judge as unknown as PolicyInput["judge"];
  if (judge.timeout_ms !== undefined) nonNegInt(judge.timeout_ms, "judge.timeout_ms");
  if (judge.on_error !== undefined && judge.on_error !== "fail_open" && judge.on_error !== "fail_closed")
    fail("judge.on_error must be fail_open or fail_closed");
  if (judge.mode !== undefined && judge.mode !== "signals" && judge.mode !== "option_pick")
    fail("judge.mode must be signals or option_pick");

  if (!isRecord(raw.candidates) || Object.keys(raw.candidates).length === 0) fail("candidates must be a non-empty object");
  const candidates: Record<string, Candidate> = {};
  for (const [id, c] of Object.entries(raw.candidates)) candidates[id] = validateCandidate(id, c);
  const candidateIds = Object.keys(candidates);

  if (!isRecord(raw.policies) || Object.keys(raw.policies).length === 0) fail("policies must be a non-empty object");
  const mode: JudgeMode = judge.mode ?? "signals";
  const policies: Record<string, PolicyDef> = {};
  for (const [id, def] of Object.entries(raw.policies)) policies[id] = validatePolicyDef(id, def, candidateIds, candidates, mode);

  if (!Array.isArray(raw.routes)) fail("routes must be an array");
  for (const r of raw.routes as unknown[]) {
    if (!isRecord(r) || typeof r.id !== "string" || typeof r.policy !== "string" || !(r.policy in policies))
      fail("each route needs an id and a known policy");
    if (!HARNESSES.has(String(r.harness))) fail(`route '${r.id}': harness must be one of ${[...HARNESSES].join(", ")}`);
  }

  const egress: Record<string, EgressInput> = {};
  if (raw.egress !== undefined) {
    if (!isRecord(raw.egress)) fail("egress must be an object");
    for (const [name, e] of Object.entries(raw.egress)) {
      const ok =
        isRecord(e) &&
        typeof e.base_url === "string" &&
        e.base_url !== "" &&
        (e.api_key_env === undefined || typeof e.api_key_env === "string") &&
        (e.pi_provider === undefined || typeof e.pi_provider === "string") &&
        (e.forward_auth === undefined || typeof e.forward_auth === "boolean") &&
        (e.mount === undefined || (typeof e.mount === "string" && /^\/[^?#\s]*[^/?#\s]$/.test(e.mount))) &&
        (e.billing === undefined || e.billing === "usd" || e.billing === "subscription");
      if (!ok)
        fail(
          `egress '${name}' needs a base_url string; optional api_key_env / pi_provider strings, forward_auth boolean, mount path such as "/backend-api/codex" (no trailing slash), billing "usd" | "subscription"`,
        );
      egress[name] = e as unknown as EgressInput;
    }
    const mounts = Object.values(egress)
      .map((e) => e.mount)
      .filter((m): m is string => typeof m === "string");
    if (new Set(mounts).size !== mounts.length) fail("egress mounts must be distinct");
  }
  return {
    version: 1,
    judge: {
      ...judge,
      timeout_ms: judge.timeout_ms ?? DEFAULTS.timeout_ms,
      on_error: judge.on_error ?? "fail_open",
      mode: judge.mode ?? "signals",
    },
    egress,
    candidates,
    routes: raw.routes as PolicyInput["routes"],
    policies,
  };
}

/** Candidate ids from cheapest to most capable for the named policy. */
export function tierOrder(policy: Policy, policyId: string): readonly string[] {
  const def = policy.policies[policyId];
  if (!def) fail(`unknown policy '${policyId}'`);
  return def.order;
}

export function getPolicyDef(policy: Policy, policyId: string): PolicyDef {
  const def = policy.policies[policyId];
  if (!def) fail(`unknown policy '${policyId}'`);
  return def;
}

export type { PolicyDefInput, PolicyInput };
