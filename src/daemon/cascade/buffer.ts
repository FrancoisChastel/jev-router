/**
 * Reads an upstream body into memory up to a byte and time cap, so a response can be assessed before the client sees
 * any of it. Whatever happens, `replay` yields the exact bytes the upstream sent, in order: the buffered prefix, then
 * the rest of the live stream when a cap cut buffering short, then the upstream's own error if it failed.
 */

export interface BufferCaps {
  readonly maxBytes: number;
  readonly maxMs: number;
}

export type BufferOutcome =
  /** The whole body arrived within the caps. */
  | { readonly kind: "complete"; readonly bytes: Uint8Array; readonly replay: ReadableStream<Uint8Array> }
  /** A cap was hit; `replay` continues with the live remainder. */
  | {
      readonly kind: "overflow";
      readonly reason: "buffer_max_bytes" | "buffer_max_ms";
      readonly replay: ReadableStream<Uint8Array>;
    }
  /** The upstream stream failed before it ended; `replay` yields what arrived and then fails the same way. */
  | { readonly kind: "failed"; readonly error: string; readonly replay: ReadableStream<Uint8Array> };

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
const TIMEOUT = Symbol("timeout");

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  chunks.reduce((offset, c) => {
    out.set(c, offset);
    return offset + c.byteLength;
  }, 0);
  return out;
}

/** A stream of `chunks`, then (when given) the reads still owed by `reader`, starting with an in-flight `pending` read. */
function replayStream(
  chunks: readonly Uint8Array[],
  rest?: { readonly reader: ReadableStreamDefaultReader<Uint8Array>; readonly pending?: Promise<ReadResult> },
  error?: unknown,
): ReadableStream<Uint8Array> {
  let index = 0;
  let pending = rest?.pending;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index] as Uint8Array);
        index += 1;
        return;
      }
      if (error !== undefined) return controller.error(error);
      if (!rest) return controller.close();
      const read = pending ?? rest.reader.read();
      pending = undefined;
      const { done, value } = await read;
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return rest?.reader.cancel(reason);
    },
  });
}

function timer(ms: number): { readonly fired: Promise<typeof TIMEOUT>; clear(): void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const fired = new Promise<typeof TIMEOUT>((resolve) => {
    handle = setTimeout(() => resolve(TIMEOUT), Math.max(0, ms));
  });
  return { fired, clear: () => clearTimeout(handle) };
}

/** Buffer `body` under `caps`. Never throws: an upstream failure is reported as `failed`. */
export async function bufferBody(body: ReadableStream<Uint8Array>, caps: BufferCaps): Promise<BufferOutcome> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = timer(caps.maxMs);
  try {
    for (;;) {
      const pending = reader.read();
      // A read that loses the race is handed to `replay`; until then, keep its failure from surfacing as unhandled.
      pending.catch(() => undefined);
      const winner = await Promise.race([pending, deadline.fired]);
      if (winner === TIMEOUT) return { kind: "overflow", reason: "buffer_max_ms", replay: replayStream(chunks, { reader, pending }) };
      if (winner.done) return { kind: "complete", bytes: concat(chunks), replay: replayStream(chunks) };
      chunks.push(winner.value);
      size += winner.value.byteLength;
      if (size > caps.maxBytes) return { kind: "overflow", reason: "buffer_max_bytes", replay: replayStream(chunks, { reader }) };
    }
  } catch (e) {
    return { kind: "failed", error: e instanceof Error ? e.message : String(e), replay: replayStream(chunks, undefined, e) };
  } finally {
    deadline.clear();
  }
}
