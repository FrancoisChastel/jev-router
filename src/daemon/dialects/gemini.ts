import type { Decision } from "../../core/types";
import { echoModelVersion, normalizeGeminiRequest, withEffort } from "./gemini-request";
import type { DialectAdapter, JsonObject, NormalizedBody } from "./types";

/**
 * The public Gemini API (generativelanguage.googleapis.com), as Gemini CLI speaks it with an API key:
 * `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` or `:generateContent`. The model lives in the path,
 * so routing rewrites the path and leaves the body alone apart from an existing `thinkingLevel`.
 */
const MODEL_PATH = /^\/(v1|v1beta|v1alpha)\/models\/(.+):(generateContent|streamGenerateContent)$/;

export function isGeminiGeneratePath(path: string): boolean {
  return MODEL_PATH.test(path);
}

/** The model id in a Gemini generate path, `models/` prefix already stripped by the path shape. */
export function geminiModelFromPath(path: string): string | undefined {
  return MODEL_PATH.exec(path)?.[2];
}

export const geminiDialect: DialectAdapter = {
  dialect: "gemini",
  path: "/v1beta/models/{model}:streamGenerateContent",

  normalize(body, path = ""): NormalizedBody {
    const m = MODEL_PATH.exec(path);
    return normalizeGeminiRequest(body, { requestedModel: m?.[2] ?? "", stream: m?.[3] === "streamGenerateContent" });
  },

  rewrite(body, decision: Decision): JsonObject {
    return withEffort(body, decision.effort);
  },

  rewritePath(path, decision: Decision): string {
    const m = MODEL_PATH.exec(path);
    return m ? `/${m[1]}/models/${decision.model}:${m[3]}` : path;
  },

  echoModel(json, requestedModel): JsonObject {
    return echoModelVersion(json, requestedModel);
  },
};
