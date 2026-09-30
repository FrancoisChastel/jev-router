import type { Cascade, CascadeTrigger } from "./types";

export const CASCADE_TRIGGERS: readonly CascadeTrigger[] = ["upstream_error", "empty", "refusal", "truncated"];
const KEYS: ReadonlySet<string> = new Set(["enabled", "on", "max_retries", "buffer", "buffer_max_bytes", "buffer_max_ms", "budget_usd"]);

export const CASCADE_DEFAULTS = {
  enabled: false,
  on: ["upstream_error", "empty"] as readonly CascadeTrigger[],
  unbufferedOn: ["upstream_error"] as readonly CascadeTrigger[],
  max_retries: 1,
  buffer: true,
  buffer_max_bytes: 262_144,
  buffer_max_ms: 20_000,
} as const;

const CASCADE_DEFAULTS_RESOLVED: Cascade = {
  enabled: CASCADE_DEFAULTS.enabled,
  on: CASCADE_DEFAULTS.on,
  max_retries: CASCADE_DEFAULTS.max_retries,
  buffer: CASCADE_DEFAULTS.buffer,
  buffer_max_bytes: CASCADE_DEFAULTS.buffer_max_bytes,
  buffer_max_ms: CASCADE_DEFAULTS.buffer_max_ms,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isTrigger = (v: unknown): v is CascadeTrigger => typeof v === "string" && (CASCADE_TRIGGERS as readonly string[]).includes(v);

function bool(v: unknown, name: string, fallback: boolean, fail: (m: string) => never): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") fail(`${name} must be a boolean`);
  return v;
}

function positiveInt(v: unknown, name: string, fallback: number, fail: (m: string) => never): number {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || (v as number) < 1) fail(`${name} must be a positive integer`);
  return v as number;
}

function triggers(v: unknown, name: string, buffer: boolean, fail: (m: string) => never): readonly CascadeTrigger[] {
  if (v === undefined) return buffer ? CASCADE_DEFAULTS.on : CASCADE_DEFAULTS.unbufferedOn;
  if (!Array.isArray(v)) fail(`${name} must be a list of triggers: ${CASCADE_TRIGGERS.join(", ")}`);
  const bad = v.filter((t) => !isTrigger(t));
  if (bad.length > 0) fail(`${name} has unknown trigger ${bad.map(String).join(", ")}; known: ${CASCADE_TRIGGERS.join(", ")}`);
  if (v.length === 0) fail(`${name} must list at least one trigger`);
  if (new Set(v).size !== v.length) fail(`${name} must not repeat a trigger`);
  const needsBuffer = (v as CascadeTrigger[]).find((t) => t !== "upstream_error");
  if (!buffer && needsBuffer)
    fail(`${name}: '${needsBuffer}' needs buffer: true; without buffering only upstream_error can trigger a retry`);
  return [...(v as CascadeTrigger[])];
}

/** Validate `policies.<id>.cascade`, filling defaults. `where` prefixes every message. */
export function validateCascade(raw: unknown, where: string, fail: (m: string) => never): Cascade {
  if (raw === undefined) return { ...CASCADE_DEFAULTS_RESOLVED };
  const name = `${where}: cascade`;
  if (!isRecord(raw)) fail(`${name} must be an object`);
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) fail(`${name}: unknown key '${key}'; known: ${[...KEYS].join(", ")}`);
  const buffer = bool(raw.buffer, `${name}.buffer`, CASCADE_DEFAULTS.buffer, fail);
  const budget = raw.budget_usd;
  if (budget !== undefined && (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0))
    fail(`${name}.budget_usd must be a positive number of US dollars`);
  return {
    enabled: bool(raw.enabled, `${name}.enabled`, CASCADE_DEFAULTS.enabled, fail),
    on: triggers(raw.on, `${name}.on`, buffer, fail),
    max_retries: positiveInt(raw.max_retries, `${name}.max_retries`, CASCADE_DEFAULTS.max_retries, fail),
    buffer,
    buffer_max_bytes: positiveInt(raw.buffer_max_bytes, `${name}.buffer_max_bytes`, CASCADE_DEFAULTS.buffer_max_bytes, fail),
    buffer_max_ms: positiveInt(raw.buffer_max_ms, `${name}.buffer_max_ms`, CASCADE_DEFAULTS.buffer_max_ms, fail),
    ...(typeof budget === "number" ? { budget_usd: budget } : {}),
  };
}
