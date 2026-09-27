import { describe, expect, test } from "bun:test";
import { createSseTransform } from "../../src/daemon/sse";

async function run(input: string[], requested: string): Promise<{ out: string; usage: unknown[] }> {
  const usage: unknown[] = [];
  const t = createSseTransform({ requestedModel: requested, onUsage: (u) => usage.push(u) });
  const writer = t.writable.getWriter();
  const chunks: Uint8Array[] = [];
  const reading = (async () => {
    for await (const c of t.readable as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
  })();
  for (const s of input) await writer.write(new TextEncoder().encode(s));
  await writer.close();
  await reading;
  return { out: new TextDecoder().decode(Buffer.concat(chunks)), usage };
}

describe("sse transform", () => {
  test("rewrites the model in anthropic message_start and captures usage, leaving everything else byte-identical", async () => {
    const lines = [
      "event: message_start\n",
      'data: {"type":"message_start","message":{"id":"m1","model":"claude-sonnet-5-20260101","usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi model"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const { out, usage } = await run(lines, "claude-code/auto");
    expect(out).toContain('"model":"claude-code/auto"');
    expect(out).not.toContain("claude-sonnet-5-20260101");
    expect(out).toContain('"text":"hi model"');
    expect(out).toContain('event: ping\ndata: {"type":"ping"}\n\n');
    expect(usage).toEqual([{ input_tokens: 10, output_tokens: 1 }, { output_tokens: 5 }]);
  });

  test("handles chunk boundaries inside a line and OpenAI chunks with [DONE]", async () => {
    const full =
      'data: {"id":"c","model":"openai/gpt-6-astra","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
    const parts = [full.slice(0, 17), full.slice(17, 40), full.slice(40)];
    const { out, usage } = await run(parts, "auto");
    expect(out).toBe('data: {"id":"c","model":"auto","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
    expect(usage).toEqual([{ prompt_tokens: 3, completion_tokens: 2 }]);
  });

  test("passes non-JSON and model-free data through unchanged", async () => {
    const input = ': comment\n\ndata: not json\n\ndata: {"type":"x"}\n\n';
    const { out } = await run([input], "auto");
    expect(out).toBe(input);
  });

  test("keeps CRLF framing on rewritten lines", async () => {
    const { out } = await run(['data: {"model":"up","x":1}\r\n\r\n'], "req");
    expect(out).toBe('data: {"model":"req","x":1}\r\n\r\n');
  });

  test("flushes a trailing partial line at close", async () => {
    const { out } = await run(['data: {"model":"up","x":1}'], "req");
    expect(out).toBe('data: {"model":"req","x":1}');
  });
});
