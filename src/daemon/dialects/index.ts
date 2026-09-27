import { anthropicDialect } from "./anthropic";
import { openaiChatDialect } from "./openai-chat";
import { openaiResponsesDialect } from "./openai-responses";
import type { Dialect, DialectAdapter } from "./types";

export const DIALECTS: Readonly<Record<Dialect, DialectAdapter>> = {
  anthropic: anthropicDialect,
  "openai-chat": openaiChatDialect,
  "openai-responses": openaiResponsesDialect,
};

export type * from "./types";
export { anthropicDialect, openaiChatDialect, openaiResponsesDialect };
