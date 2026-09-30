import type { Decision } from "../../core/types";
import { echoModelVersion, normalizeGeminiRequest, withEffort } from "./gemini-request";
import { asString, type DialectAdapter, isObject, type JsonObject, type NormalizedBody } from "./types";

/**
 * Google's Code Assist backend (cloudcode-pa.googleapis.com), which Gemini CLI talks to when logged in with a Google
 * account: `POST /v1internal:streamGenerateContent?alt=sse` with `{ model, project, user_prompt_id, request }`, where
 * `request` is a Gemini GenerateContentRequest carrying `session_id`. Responses wrap the Gemini response as
 * `{ response, traceId }`.
 */
const GENERATE_PATH = /^\/(v1internal):(generateContent|streamGenerateContent)$/;

export function isCodeAssistGeneratePath(path: string): boolean {
  return GENERATE_PATH.test(path);
}

export const geminiCodeAssistDialect: DialectAdapter = {
  dialect: "gemini-code-assist",
  path: "/v1internal:streamGenerateContent",

  normalize(body, path = ""): NormalizedBody {
    const request = isObject(body.request) ? body.request : {};
    const sessionId = asString(request.session_id);
    return normalizeGeminiRequest(request, {
      requestedModel: asString(body.model) ?? "",
      stream: GENERATE_PATH.exec(path)?.[2] === "streamGenerateContent",
      ...(sessionId ? { sessionKey: `gemini:${sessionId}` } : {}),
    });
  },

  rewrite(body, decision: Decision): JsonObject {
    const out: JsonObject = { ...body, model: decision.model };
    if (isObject(body.request)) out.request = withEffort(body.request, decision.effort);
    return out;
  },

  echoModel(json, requestedModel): JsonObject {
    return isObject(json.response) ? { ...json, response: echoModelVersion(json.response, requestedModel) } : json;
  },
};
