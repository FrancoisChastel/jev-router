import { describe, expect, test } from "bun:test";
import { bufferBody } from "../../src/daemon/cascade/buffer";

const enc = new TextEncoder();
const dec = new TextDecoder();

function source(parts: readonly string[], opts: { delayMs?: number; failAfter?: number } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.failAfter !== undefined && i === opts.failAfter) return controller.error(new Error("socket hang up"));
      if (i >= parts.length) return controller.close();
      controller.enqueue(enc.encode(parts[i] as string));
      i += 1;
    },
  });
}

const drain = async (s: ReadableStream<Uint8Array>): Promise<string> => dec.decode(new Uint8Array(await new Response(s).arrayBuffer()));

describe("bufferBody", () => {
  test("a body within the caps is complete and replays exactly", async () => {
    const out = await bufferBody(source(["ab", "cd"]), { maxBytes: 100, maxMs: 1000 });
    expect(out.kind).toBe("complete");
    if (out.kind !== "complete") return;
    expect(dec.decode(out.bytes)).toBe("abcd");
    expect(await drain(out.replay)).toBe("abcd");
  });

  test("the byte cap hands back the prefix followed by the live rest", async () => {
    const out = await bufferBody(source(["aaaa", "bbbb", "cccc"]), { maxBytes: 5, maxMs: 1000 });
    expect(out).toMatchObject({ kind: "overflow", reason: "buffer_max_bytes" });
    expect(await drain(out.replay)).toBe("aaaabbbbcccc");
  });

  test("the time cap keeps the read in flight so no chunk is lost", async () => {
    const out = await bufferBody(source(["x", "y", "z"], { delayMs: 15 }), { maxBytes: 100, maxMs: 20 });
    expect(out).toMatchObject({ kind: "overflow", reason: "buffer_max_ms" });
    expect(await drain(out.replay)).toBe("xyz");
  });

  test("an upstream failure is reported, and the replay fails after the bytes that did arrive", async () => {
    const out = await bufferBody(source(["ok"], { failAfter: 1 }), { maxBytes: 100, maxMs: 1000 });
    expect(out).toMatchObject({ kind: "failed", error: "socket hang up" });
    const reader = out.replay.getReader();
    expect(dec.decode((await reader.read()).value)).toBe("ok");
    await expect(reader.read()).rejects.toThrow("socket hang up");
  });
});
