import type { FetchLike } from "../judge/http";

/** A local Ollama server `init` found, and the model it picked for the free `local` tier. */
export interface OllamaDetection {
  readonly baseUrl: string;
  readonly model: string;
  readonly tags: readonly string[];
}

export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const PROBE_TIMEOUT_MS = 2000;

/** Coding models first, most capable family first; the first installed match wins, else the first tag. */
export const OLLAMA_PREFERENCE = ["qwen3-coder", "qwen2.5-coder", "deepseek-coder", "devstral", "codestral", "codellama"] as const;

/** Tag names from Ollama's `GET /api/tags` body (`{ models: [{ name }] }`); anything else yields none. */
export function parseOllamaTags(json: unknown): string[] {
  const models = (json as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((m) => (typeof m === "object" && m !== null ? (m as { name?: unknown; model?: unknown }) : {}))
    .map((m) => (typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : ""))
    .filter((n) => n !== "");
}

/** The tag to serve the `local` tier with: the first preferred coding family installed, else the first tag. */
export function chooseOllamaModel(tags: readonly string[]): string | undefined {
  for (const family of OLLAMA_PREFERENCE) {
    const hit = tags.find((t) => t === family || t.startsWith(`${family}:`) || t.startsWith(`${family}-`));
    if (hit) return hit;
  }
  return tags[0];
}

/** Probe a local Ollama server. Silent on every failure: unreachable, slow, non-JSON, or no models pulled. */
export async function detectOllama(fetchImpl: FetchLike, baseUrl: string = OLLAMA_BASE_URL): Promise<OllamaDetection | undefined> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const tags = parseOllamaTags(await res.json());
    const model = chooseOllamaModel(tags);
    return model ? { baseUrl, model, tags } : undefined;
  } catch {
    return undefined;
  }
}
