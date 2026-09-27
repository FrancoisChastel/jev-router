import type { Decision, Effort, ToolOutcome } from "../../core/types";
import {
  asEffort,
  asString,
  type DialectAdapter,
  EXCERPT_TAIL_CHARS,
  isObject,
  type JsonObject,
  type NormalizedBody,
  TEXT_TAIL_CHARS,
  tail,
} from "./types";

/** Anthropic accepts low, medium, high, xhigh, and max; minimal maps to low. */
const ANTHROPIC_EFFORT: Readonly<Record<Effort, string>> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

type Block = JsonObject & { type?: string };

function blocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter(isObject) : [];
}

function textOf(content: unknown): string {
  return blocks(content)
    .filter((b) => b.type === "text")
    .map((b) => asString(b.text) ?? "")
    .join("\n");
}

function resultText(content: unknown): string {
  return typeof content === "string" ? content : textOf(content);
}

function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  return Array.isArray(system)
    ? system
        .filter(isObject)
        .map((b) => asString(b.text) ?? "")
        .join("\n")
    : "";
}

export const anthropicDialect: DialectAdapter = {
  dialect: "anthropic",
  path: "/v1/messages",

  normalize(body): NormalizedBody {
    const messages = Array.isArray(body.messages) ? body.messages.filter(isObject) : [];
    const toolNames = Array.isArray(body.tools)
      ? body.tools
          .filter(isObject)
          .map((t) => asString(t.name))
          .filter((n): n is string => !!n)
      : [];
    const toolUseNames = new Map<string, string>();
    let lastUserText: string | undefined;
    let assistantIntentTail: string | undefined;
    let hasImages = false;

    for (const m of messages) {
      for (const b of blocks(m.content)) {
        if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") toolUseNames.set(b.id, b.name);
        if (b.type === "image") hasImages = true;
        if (b.type === "tool_result") for (const inner of blocks(b.content)) if (inner.type === "image") hasImages = true;
      }
      if (m.role === "user") {
        const t = textOf(m.content);
        if (t) lastUserText = t;
      } else if (m.role === "assistant") {
        const t = textOf(m.content);
        if (t) assistantIntentTail = tail(t, TEXT_TAIL_CHARS);
      }
    }

    const last = messages[messages.length - 1];
    const lastBlocks = last && last.role === "user" ? blocks(last.content) : [];
    const results = lastBlocks.filter((b) => b.type === "tool_result");
    const toolOutcomes: ToolOutcome[] = results.map((r) => {
      const name = (typeof r.tool_use_id === "string" && toolUseNames.get(r.tool_use_id)) || "unknown";
      const isError = r.is_error === true;
      const text = tail(resultText(r.content), EXCERPT_TAIL_CHARS);
      return { name, isError, ...(text ? (isError ? { errorText: text } : { excerpt: text }) : {}) };
    });
    const isNewUserTurn = !!last && last.role === "user" && results.length === 0;

    const effort = isObject(body.output_config) ? asEffort(body.output_config.effort) : undefined;
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
      prefixDigestInput: `${systemText(body.system)}\n${firstUser ? textOf(firstUser.content) : ""}`,
    };
  },

  rewrite(body, decision: Decision): JsonObject {
    const out: JsonObject = { ...body, model: decision.model };
    if (decision.effort && isObject(body.output_config) && "effort" in body.output_config) {
      out.output_config = { ...body.output_config, effort: ANTHROPIC_EFFORT[decision.effort] };
    }
    return out;
  },

  echoModel(json, requestedModel): JsonObject {
    return typeof json.model === "string" ? { ...json, model: requestedModel } : json;
  },
};
