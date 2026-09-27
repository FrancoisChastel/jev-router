import type { Decision, ToolOutcome } from "../../core/types";
import {
  asEffort,
  asString,
  type DialectAdapter,
  EXCERPT_TAIL_CHARS,
  isObject,
  type JsonObject,
  looksLikeError,
  type NormalizedBody,
  TEXT_TAIL_CHARS,
  tail,
} from "./types";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObject)
    .filter((p) => p.type === "input_text" || p.type === "output_text" || p.type === "text")
    .map((p) => asString(p.text) ?? "")
    .join("\n");
}

function hasImagePart(content: unknown): boolean {
  return Array.isArray(content) && content.some((p) => isObject(p) && (p.type === "input_image" || p.type === "image"));
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  return textOf(output);
}

export const openaiResponsesDialect: DialectAdapter = {
  dialect: "openai-responses",
  path: "/v1/responses",

  normalize(body): NormalizedBody {
    const items: JsonObject[] =
      typeof body.input === "string"
        ? [{ type: "message", role: "user", content: body.input }]
        : Array.isArray(body.input)
          ? body.input.filter(isObject)
          : [];
    const toolNames = Array.isArray(body.tools)
      ? body.tools
          .filter(isObject)
          .map((t) => asString(t.name))
          .filter((n): n is string => !!n)
      : [];
    const callNames = new Map<string, string>();
    let lastUserText: string | undefined;
    let assistantIntentTail: string | undefined;
    let hasImages = false;

    for (const it of items) {
      const type = asString(it.type) ?? (it.role ? "message" : undefined);
      if (type === "function_call" && typeof it.call_id === "string" && typeof it.name === "string") callNames.set(it.call_id, it.name);
      if (type === "message") {
        if (hasImagePart(it.content)) hasImages = true;
        const t = textOf(it.content);
        if (it.role === "user" && t) lastUserText = t;
        if (it.role === "assistant" && t) assistantIntentTail = tail(t, TEXT_TAIL_CHARS);
      }
    }

    const trailing: JsonObject[] = [];
    for (let i = items.length - 1; i >= 0 && items[i]?.type === "function_call_output"; i -= 1) trailing.unshift(items[i] as JsonObject);
    const toolOutcomes: ToolOutcome[] = trailing.map((it) => {
      const name = (typeof it.call_id === "string" && callNames.get(it.call_id)) || "unknown";
      const text = outputText(it.output);
      const isError = looksLikeError(text);
      const bounded = tail(text, EXCERPT_TAIL_CHARS);
      return { name, isError, ...(bounded ? (isError ? { errorText: bounded } : { excerpt: bounded }) : {}) };
    });
    const last = items[items.length - 1];
    const isNewUserTurn = !!last && (last.type === "message" || last.type === undefined) && last.role === "user";
    const effort = isObject(body.reasoning) ? asEffort(body.reasoning.effort) : undefined;
    const firstUser = items.find((it) => it.role === "user");
    return {
      requestedModel: asString(body.model) ?? "",
      isNewUserTurn,
      ...(lastUserText !== undefined ? { lastUserText } : {}),
      ...(assistantIntentTail !== undefined ? { assistantIntentTail } : {}),
      toolNames,
      hasImages,
      toolOutcomes,
      ...(effort ? { requestedEffort: effort } : {}),
      stream: body.stream === true,
      prefixDigestInput: `${asString(body.instructions) ?? ""}\n${firstUser ? textOf(firstUser.content) : ""}`,
    };
  },

  rewrite(body, decision: Decision): JsonObject {
    const out: JsonObject = { ...body, model: decision.model };
    if (decision.effort) out.reasoning = { ...(isObject(body.reasoning) ? body.reasoning : {}), effort: decision.effort };
    return out;
  },

  echoModel(json, requestedModel): JsonObject {
    return typeof json.model === "string" ? { ...json, model: requestedModel } : json;
  },
};
