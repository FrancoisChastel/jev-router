import { asString, isObject, type JsonObject } from "../dialects/types";

/**
 * What a complete response said, reduced to the facts a cascade trigger looks at. Built by folding each stream event
 * (or the one non-stream body) through a dialect reducer; every reducer returns a new summary.
 */
export interface ReplySummary {
  /** Text streamed as deltas. */
  readonly text: string;
  /** Text from a final response object (Responses `response.completed`), preferred over the deltas when present. */
  readonly finalText: string;
  readonly toolCall: boolean;
  /** Refusal text the provider flagged as such (OpenAI `refusal` fields), or the Anthropic `refusal` stop reason. */
  readonly refusal: string;
  readonly stop?: string;
  readonly error?: string;
}

export type Fold = (acc: ReplySummary, obj: JsonObject) => ReplySummary;

export const EMPTY_REPLY: ReplySummary = { text: "", finalText: "", toolCall: false, refusal: "" };

const list = (v: unknown): JsonObject[] => (Array.isArray(v) ? v.filter(isObject) : []);
const str = (v: unknown): string => asString(v) ?? "";

function errorText(v: unknown): string {
  if (!isObject(v)) return typeof v === "string" ? v : "error";
  return asString(v.type) ?? asString(v.code) ?? asString(v.message) ?? "error";
}

const ANTHROPIC_TOOL_BLOCKS: ReadonlySet<string> = new Set(["tool_use", "server_tool_use"]);

function anthropicBlock(acc: ReplySummary, block: JsonObject): ReplySummary {
  const toolCall = acc.toolCall || ANTHROPIC_TOOL_BLOCKS.has(str(block.type));
  const text = block.type === "text" ? acc.text + str(block.text) : acc.text;
  return { ...acc, toolCall, text };
}

/** One Anthropic Messages stream event, or a whole non-stream message. */
export const foldAnthropic: Fold = (acc, obj) => {
  let next = obj.type === "error" ? { ...acc, error: errorText(obj.error) } : acc;
  if (isObject(obj.content_block)) next = anthropicBlock(next, obj.content_block);
  if (obj.type === "message") next = list(obj.content).reduce(anthropicBlock, next);
  const delta = isObject(obj.delta) ? obj.delta : undefined;
  if (delta?.type === "text_delta") next = { ...next, text: next.text + str(delta.text) };
  const stop = asString(delta?.stop_reason) ?? asString(obj.stop_reason);
  if (stop) next = { ...next, stop, ...(stop === "refusal" ? { refusal: next.refusal || "refusal" } : {}) };
  return next;
};

function chatContent(v: unknown): string {
  if (typeof v === "string") return v;
  return list(v)
    .map((p) => str(p.text))
    .join("");
}

function chatPart(acc: ReplySummary, part: JsonObject): ReplySummary {
  return {
    ...acc,
    text: acc.text + chatContent(part.content),
    refusal: acc.refusal + str(part.refusal),
    toolCall: acc.toolCall || list(part.tool_calls).length > 0 || isObject(part.function_call),
  };
}

function chatChoice(acc: ReplySummary, choice: JsonObject): ReplySummary {
  let next = acc;
  if (isObject(choice.delta)) next = chatPart(next, choice.delta);
  if (isObject(choice.message)) next = chatPart(next, choice.message);
  const stop = asString(choice.finish_reason);
  return stop ? { ...next, stop } : next;
}

/** One OpenAI chat completion chunk, or a whole non-stream completion. */
export const foldChat: Fold = (acc, obj) => {
  const next = obj.error !== undefined && obj.error !== null ? { ...acc, error: errorText(obj.error) } : acc;
  return list(obj.choices).reduce(chatChoice, next);
};

const isToolItem = (item: JsonObject): boolean => str(item.type).endsWith("_call");

function responsesItem(acc: ReplySummary, item: JsonObject, final: boolean): ReplySummary {
  const next = isToolItem(item) ? { ...acc, toolCall: true } : acc;
  if (item.type !== "message" || !final) return next;
  const parts = list(item.content);
  const text = parts
    .filter((p) => p.type === "output_text")
    .map((p) => str(p.text))
    .join("");
  const refusal = parts.find((p) => p.type === "refusal");
  return {
    ...next,
    finalText: next.finalText + text,
    ...(refusal ? { refusal: next.refusal || str(refusal.refusal) || "refusal" } : {}),
  };
}

function responsesStop(acc: ReplySummary, response: JsonObject): ReplySummary {
  const status = asString(response.status);
  if (status === "failed") return { ...acc, error: errorText(response.error), stop: status };
  if (status === "incomplete") {
    const reason = isObject(response.incomplete_details) ? asString(response.incomplete_details.reason) : undefined;
    return { ...acc, stop: reason ?? "incomplete" };
  }
  return status ? { ...acc, stop: status } : acc;
}

function responsesObject(acc: ReplySummary, response: JsonObject): ReplySummary {
  const withItems = list(response.output).reduce<ReplySummary>((a, item) => responsesItem(a, item, true), acc);
  return responsesStop(withItems, response);
}

const RESPONSE_SNAPSHOTS: ReadonlySet<string> = new Set(["response.completed", "response.incomplete", "response.failed"]);

/** One OpenAI Responses stream event, or a whole non-stream response. */
export const foldResponses: Fold = (acc, obj) => {
  const type = str(obj.type);
  let next = type === "error" ? { ...acc, error: errorText(obj.error ?? obj.code ?? obj.message) } : acc;
  if (type === "response.output_text.delta") next = { ...next, text: next.text + str(obj.delta) };
  if (type === "response.refusal.delta") next = { ...next, refusal: next.refusal + str(obj.delta) };
  if (isObject(obj.item)) next = responsesItem(next, obj.item, false);
  if (RESPONSE_SNAPSHOTS.has(type) && isObject(obj.response)) next = responsesObject(next, obj.response);
  if (obj.object === "response") next = responsesObject(next, obj);
  return next;
};
