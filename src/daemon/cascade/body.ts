import type { TokenUsage } from "../../core/record";
import { isObject, type JsonObject } from "../dialects/types";
import { mergeUsage } from "../http-util";
import { usageOf } from "../sse";

/** The JSON objects carried by the `data:` lines of a complete SSE body, in order. Other lines are ignored. */
export function sseDataObjects(text: string): JsonObject[] {
  const out: JsonObject[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trimStart();
    if (!payload.startsWith("{")) continue;
    try {
      const v: unknown = JSON.parse(payload);
      if (isObject(v)) out.push(v);
    } catch {
      /* a malformed line says nothing about the response */
    }
  }
  return out;
}

/** The JSON object of a complete non-stream body, or undefined when it is not one. */
export function jsonObject(text: string): JsonObject | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Token usage reported anywhere in a complete response body, folded the same way the streaming path folds it. */
export function usageFromBody(isStream: boolean, text: string): TokenUsage | undefined {
  const objects = isStream ? sseDataObjects(text) : [jsonObject(text)].filter(isObject);
  let usage: TokenUsage | undefined;
  for (const obj of objects) {
    const u = usageOf(obj);
    if (u) usage = mergeUsage(usage, u);
  }
  return usage;
}
