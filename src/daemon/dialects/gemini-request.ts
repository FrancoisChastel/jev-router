import type { Effort, ToolOutcome } from "../../core/types";
import {
  asString,
  EXCERPT_TAIL_CHARS,
  isObject,
  type JsonObject,
  looksLikeError,
  type NormalizedBody,
  TEXT_TAIL_CHARS,
  tail,
} from "./types";

/**
 * Reading and rewriting a Gemini `GenerateContentRequest` (contents, systemInstruction, tools, generationConfig).
 * Shared by the public Gemini API dialect and the Code Assist dialect, which wraps the same request in `request`.
 */

type Part = JsonObject;

function partsOf(content: unknown): Part[] {
  return isObject(content) && Array.isArray(content.parts) ? content.parts.filter(isObject) : [];
}

/** Visible text of a content, skipping thought parts. */
function textOf(content: unknown): string {
  return partsOf(content)
    .filter((p) => p.thought !== true)
    .map((p) => asString(p.text) ?? "")
    .filter((t) => t !== "")
    .join("\n");
}

const hasImagePart = (content: unknown): boolean => partsOf(content).some((p) => isObject(p.inlineData) || isObject(p.fileData));
const functionResponses = (content: unknown): JsonObject[] =>
  partsOf(content)
    .map((p) => p.functionResponse)
    .filter(isObject);

/** Gemini CLI reports shell failures as text ("Exit Code: 1") and other tool failures as `response.error`. */
const SHELL_EXIT = /\bExit Code: ([1-9]\d*|-\d+)\b/;

function responseText(response: unknown): string {
  if (typeof response === "string") return response;
  if (!isObject(response)) return "";
  for (const key of ["error", "output", "content", "result"]) {
    const v = response[key];
    if (typeof v === "string") return v;
  }
  try {
    return JSON.stringify(response);
  } catch {
    return "";
  }
}

function toOutcome(fr: JsonObject): ToolOutcome {
  const response = fr.response;
  const text = responseText(response);
  const explicitError = isObject(response) && response.error !== undefined && response.error !== null && response.error !== false;
  const isError = explicitError || SHELL_EXIT.test(text) || looksLikeError(text);
  const bounded = tail(text, EXCERPT_TAIL_CHARS);
  return {
    name: asString(fr.name) ?? "unknown",
    isError,
    ...(bounded ? (isError ? { errorText: bounded } : { excerpt: bounded }) : {}),
  };
}

function toolNamesOf(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(isObject)
    .flatMap((t) => (Array.isArray(t.functionDeclarations) ? t.functionDeclarations.filter(isObject) : []))
    .map((d) => asString(d.name))
    .filter((n): n is string => !!n);
}

/** thinkingLevel values Gemini accepts, mapped to the shared effort scale and back. */
const LEVEL_TO_EFFORT: Readonly<Record<string, Effort>> = { MINIMAL: "minimal", LOW: "low", MEDIUM: "medium", HIGH: "high" };
const EFFORT_TO_LEVEL: Readonly<Record<Effort, string>> = {
  minimal: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  xhigh: "HIGH",
  max: "HIGH",
};

function thinkingConfigOf(request: JsonObject): JsonObject | undefined {
  const gc = request.generationConfig;
  return isObject(gc) && isObject(gc.thinkingConfig) ? gc.thinkingConfig : undefined;
}

function requestedEffortOf(request: JsonObject): Effort | undefined {
  const level = asString(thinkingConfigOf(request)?.thinkingLevel);
  return level ? LEVEL_TO_EFFORT[level.toUpperCase()] : undefined;
}

/**
 * Returns the request with `thinkingLevel` set to the decided effort, only when the client already sent a
 * thinkingLevel. A `thinkingBudget` is left alone: budgets are model-specific token counts with no clean mapping.
 */
export function withEffort(request: JsonObject, effort: Effort | undefined): JsonObject {
  const tc = thinkingConfigOf(request);
  if (!effort || !tc || typeof tc.thinkingLevel !== "string") return request;
  const gc = request.generationConfig as JsonObject;
  return { ...request, generationConfig: { ...gc, thinkingConfig: { ...tc, thinkingLevel: EFFORT_TO_LEVEL[effort] } } };
}

export interface GeminiRequestContext {
  readonly requestedModel: string;
  readonly stream: boolean;
  readonly sessionKey?: string;
}

/** Normalize a Gemini GenerateContentRequest. The model and stream flag come from outside the body. */
export function normalizeGeminiRequest(request: JsonObject, ctx: GeminiRequestContext): NormalizedBody {
  const contents = Array.isArray(request.contents) ? request.contents.filter(isObject) : [];
  let lastUserText: string | undefined;
  let assistantIntentTail: string | undefined;
  let hasImages = false;
  for (const c of contents) {
    if (hasImagePart(c)) hasImages = true;
    const t = textOf(c);
    if (!t) continue;
    if (c.role === "model") assistantIntentTail = tail(t, TEXT_TAIL_CHARS);
    else if (functionResponses(c).length === 0) lastUserText = t;
  }
  const last = contents[contents.length - 1];
  const trailing = last && last.role !== "model" ? functionResponses(last) : [];
  const isNewUserTurn = !!last && last.role !== "model" && trailing.length === 0;
  const effort = requestedEffortOf(request);
  const firstUser = contents.find((c) => c.role !== "model");
  return {
    requestedModel: ctx.requestedModel,
    isNewUserTurn,
    ...(lastUserText !== undefined ? { lastUserText } : {}),
    ...(assistantIntentTail !== undefined ? { assistantIntentTail } : {}),
    toolNames: toolNamesOf(request.tools),
    hasImages,
    toolOutcomes: trailing.map(toOutcome),
    ...(effort ? { requestedEffort: effort } : {}),
    stream: ctx.stream,
    prefixDigestInput: `${textOf(request.systemInstruction)}\n${firstUser ? textOf(firstUser) : ""}`,
    ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
  };
}

/** Returns the JSON with `modelVersion` replaced by the requested id, when it carries one. */
export function echoModelVersion(json: JsonObject, requestedModel: string): JsonObject {
  return typeof json.modelVersion === "string" ? { ...json, modelVersion: requestedModel } : json;
}
