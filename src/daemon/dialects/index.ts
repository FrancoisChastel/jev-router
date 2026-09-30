import { anthropicDialect } from "./anthropic";
import { geminiDialect } from "./gemini";
import { geminiCodeAssistDialect } from "./gemini-code-assist";
import { openaiChatDialect } from "./openai-chat";
import { openaiResponsesDialect } from "./openai-responses";
import type { Dialect, DialectAdapter } from "./types";

export const DIALECTS: Readonly<Record<Dialect, DialectAdapter>> = {
  anthropic: anthropicDialect,
  "openai-chat": openaiChatDialect,
  "openai-responses": openaiResponsesDialect,
  gemini: geminiDialect,
  "gemini-code-assist": geminiCodeAssistDialect,
};

export type * from "./types";
export { anthropicDialect, geminiCodeAssistDialect, geminiDialect, openaiChatDialect, openaiResponsesDialect };
