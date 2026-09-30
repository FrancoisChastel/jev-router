/**
 * Gemini CLI 0.62.0 requests as captured against a local fake upstream (`gemini -p` with a fake key), trimmed: long
 * system prompts and tool schemas are shortened, every field and its shape is as sent.
 */

export const GEMINI_UA = "GeminiCLI-tui/0.62.0/jev-router/auto (darwin; arm64; terminal)";

const sessionContext =
  "<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\nToday's date is Tuesday, September 29, 2026.\n</session_context>";

const systemInstruction = {
  parts: [{ text: "You are Gemini CLI, an autonomous CLI agent specializing in software engineering tasks." }],
};

const tools = [
  {
    functionDeclarations: [
      { name: "read_file", description: "Reads a file.", parametersJsonSchema: { type: "object" } },
      { name: "replace", description: "Replaces text.", parametersJsonSchema: { type: "object" } },
      { name: "run_shell_command", description: "Runs a command.", parametersJsonSchema: { type: "object" } },
    ],
  },
];

/** First turn: POST /v1beta/models/jev-router/auto:streamGenerateContent?alt=sse */
export const firstTurn = {
  contents: [{ parts: [{ text: sessionContext }, { text: "list /nonexistent-dir-xyz with ls" }], role: "user" }],
  systemInstruction,
  tools,
  generationConfig: { temperature: 1, topP: 0.95, topK: 64, thinkingConfig: { includeThoughts: true } },
};

/** Second request of the same turn: the model's call and the failed shell result. */
export const toolTurn = {
  ...firstTurn,
  contents: [
    ...firstTurn.contents,
    {
      parts: [
        { text: "I will list it.", thought: false },
        {
          functionCall: {
            id: "run_shell_command_1790735474052_0",
            args: { command: "ls /nonexistent-dir-xyz", description: "list" },
            name: "run_shell_command",
          },
          thoughtSignature: "skip_thought_signature_validator",
        },
      ],
      role: "model",
    },
    {
      parts: [
        {
          functionResponse: {
            name: "run_shell_command",
            response: {
              output:
                "<untrusted_context>\nOutput: ls: /nonexistent-dir-xyz: No such file or directory\nExit Code: 1\nProcess Group PGID: 98116\n</untrusted_context>",
            },
            id: "run_shell_command_1790735474052_0",
          },
        },
      ],
      role: "user",
    },
  ],
};

/** A tool that failed outright: Gemini CLI puts the message in `response.error`. */
export const readErrorTurn = {
  ...firstTurn,
  contents: [
    ...firstTurn.contents,
    { parts: [{ functionCall: { id: "read_file_1", args: { file_path: "a.ts" }, name: "read_file" } }], role: "model" },
    {
      parts: [
        { functionResponse: { name: "read_file", response: { error: "File not found: a.ts" }, id: "read_file_1" } },
        { functionResponse: { name: "read_file", response: { output: "export const b = 1;" }, id: "read_file_2" } },
      ],
      role: "user",
    },
  ],
};

/** Code Assist (Google login): POST /v1internal:streamGenerateContent?alt=sse */
export const codeAssistTurn = {
  model: "jev-router/auto",
  project: "fake-project",
  user_prompt_id: "b768a5d1-d830-4b69-aee1-e4e91b469cad",
  request: {
    contents: [{ role: "user", parts: [{ text: sessionContext }, { text: "reply with exactly: ok" }] }],
    systemInstruction: { role: "user", parts: systemInstruction.parts },
    tools,
    generationConfig: { temperature: 1, topP: 0.95, topK: 64, thinkingConfig: { includeThoughts: true } },
    session_id: "b768a5d1-d830-4b69-aee1-e4e91b469cad",
  },
};

const usageMetadata = {
  promptTokenCount: 120,
  candidatesTokenCount: 3,
  totalTokenCount: 140,
  cachedContentTokenCount: 100,
  thoughtsTokenCount: 17,
};

/** Two SSE chunks in the shape the Gemini API streams, CRLF-delimited as Google sends them. */
export function geminiSse(modelVersion: string): string {
  const first = {
    candidates: [{ content: { parts: [{ text: "thinking", thought: true }], role: "model" }, index: 0 }],
    usageMetadata: { promptTokenCount: 120, totalTokenCount: 120 },
    modelVersion,
    responseId: "r1",
  };
  const last = {
    candidates: [{ content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP", index: 0 }],
    usageMetadata,
    modelVersion,
    responseId: "r1",
  };
  return `data: ${JSON.stringify(first)}\r\n\r\ndata: ${JSON.stringify(last)}\r\n\r\n`;
}

/** The Code Assist stream wraps each Gemini chunk as `{ response, traceId }`. */
export function codeAssistSse(modelVersion: string): string {
  const chunk = {
    response: {
      candidates: [{ content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP", index: 0 }],
      usageMetadata,
      modelVersion,
    },
    traceId: "t1",
  };
  return `data: ${JSON.stringify(chunk)}\r\n\r\n`;
}
