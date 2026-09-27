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
    .filter((p) => p.type === "text")
    .map((p) => asString(p.text) ?? "")
    .join("\n");
}

function hasImagePart(content: unknown): boolean {
  return (
    Array.isArray(content) && content.some((p) => isObject(p) && (p.type === "image_url" || p.type === "input_image" || p.type === "image"))
  );
}

export const openaiChatDialect: DialectAdapter = {
  dialect: "openai-chat",
  path: "/v1/chat/completions",

  normalize(body): NormalizedBody {
    const messages = Array.isArray(body.messages) ? body.messages.filter(isObject) : [];
    const toolNames = Array.isArray(body.tools)
      ? body.tools
          .filter(isObject)
          .map((t) => (isObject(t.function) ? asString(t.function.name) : asString(t.name)))
          .filter((n): n is string => !!n)
      : [];
    const callNames = new Map<string, string>();
    let lastUserText: string | undefined;
    let assistantIntentTail: string | undefined;
    let hasImages = false;
    let systemText = "";

    for (const m of messages) {
      if (hasImagePart(m.content)) hasImages = true;
      if (m.role === "system" || m.role === "developer") systemText += `${textOf(m.content)}\n`;
      if (m.role === "user") {
        const t = textOf(m.content);
        if (t) lastUserText = t;
      } else if (m.role === "assistant") {
        const t = textOf(m.content);
        if (t) assistantIntentTail = tail(t, TEXT_TAIL_CHARS);
        if (Array.isArray(m.tool_calls)) {
          for (const c of m.tool_calls.filter(isObject)) {
            const name = isObject(c.function) ? asString(c.function.name) : undefined;
            if (typeof c.id === "string" && name) callNames.set(c.id, name);
          }
        }
      }
    }

    // Trailing tool messages are the outcomes this request carries.
    const trailing: JsonObject[] = [];
    for (let i = messages.length - 1; i >= 0 && messages[i]?.role === "tool"; i -= 1) trailing.unshift(messages[i] as JsonObject);
    const toolOutcomes: ToolOutcome[] = trailing.map((m) => {
      const name = (typeof m.tool_call_id === "string" && callNames.get(m.tool_call_id)) || "unknown";
      const text = textOf(m.content);
      const isError = looksLikeError(text);
      const bounded = tail(text, EXCERPT_TAIL_CHARS);
      return { name, isError, ...(bounded ? (isError ? { errorText: bounded } : { excerpt: bounded }) : {}) };
    });
    const last = messages[messages.length - 1];
    const isNewUserTurn = !!last && last.role === "user";
    const effort = asEffort(body.reasoning_effort) ?? (isObject(body.reasoning) ? asEffort(body.reasoning.effort) : undefined);
    const firstUser = messages.find((m) => m.role === "user");
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
      prefixDigestInput: `${systemText}\n${firstUser ? textOf(firstUser.content) : ""}`,
    };
  },

  rewrite(body, decision: Decision): JsonObject {
    const out: JsonObject = { ...body, model: decision.model };
    if (decision.effort) out.reasoning_effort = decision.effort;
    return out;
  },

  echoModel(json, requestedModel): JsonObject {
    return typeof json.model === "string" ? { ...json, model: requestedModel } : json;
  },
};
