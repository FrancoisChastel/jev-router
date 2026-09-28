/**
 * Byte-preserving SSE pass-through that rewrites the model id inside `data:` JSON lines and reports
 * usage objects as they stream by. Every other byte, including pings, comments, and event ordering,
 * is forwarded exactly as received. Non-JSON data lines are never touched.
 */

export interface SseTransformOptions {
  readonly requestedModel: string;
  readonly onUsage?: (usage: Record<string, unknown>) => void;
  /** Called once the stream's terminal event has passed: `[DONE]`, `message_stop`, or a Responses `response.completed` / `failed` / `incomplete`. */
  readonly onTerminal?: () => void;
}

const DATA_PREFIX = "data:";
const TERMINAL_TYPES: ReadonlySet<string> = new Set([
  "message_stop",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
]);

function rewriteDataLine(rawLine: string, opts: SseTransformOptions): string {
  const cr = rawLine.endsWith("\r") ? "\r" : "";
  const line = cr ? rawLine.slice(0, -1) : rawLine;
  const payload = line.slice(DATA_PREFIX.length).trimStart();
  if (payload === "[DONE]") opts.onTerminal?.();
  if (!payload.startsWith("{")) return line;
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return line;
  }
  if (typeof json !== "object" || json === null) return line;
  const obj = json as Record<string, unknown>;
  if (typeof obj.type === "string" && TERMINAL_TYPES.has(obj.type)) opts.onTerminal?.();
  if (globalThis.process?.env.JEV_ROUTER_DEBUG_SSE) {
    const response = obj.response as Record<string, unknown> | undefined;
    console.error(`jev-router sse: type=${String(obj.type)} usage=${obj.usage ? "top" : response?.usage ? "response" : "none"}`);
  }
  let changed = false;
  let out: Record<string, unknown> = obj;
  if (typeof obj.model === "string" && obj.model !== opts.requestedModel) {
    out = { ...out, model: opts.requestedModel };
    changed = true;
  }
  const message = obj.message;
  if (typeof message === "object" && message !== null && typeof (message as { model?: unknown }).model === "string") {
    out = { ...out, message: { ...(message as Record<string, unknown>), model: opts.requestedModel } };
    changed = true;
  }
  // Responses API events carry the model and usage inside `response` (response.created, response.completed).
  const response = obj.response;
  if (typeof response === "object" && response !== null && typeof (response as { model?: unknown }).model === "string") {
    if ((response as { model: string }).model !== opts.requestedModel) {
      out = { ...out, response: { ...(response as Record<string, unknown>), model: opts.requestedModel } };
      changed = true;
    }
  }
  const usage =
    obj.usage ??
    (typeof message === "object" && message !== null ? (message as { usage?: unknown }).usage : undefined) ??
    (typeof response === "object" && response !== null ? (response as { usage?: unknown }).usage : undefined);
  if (opts.onUsage && typeof usage === "object" && usage !== null) opts.onUsage(usage as Record<string, unknown>);
  if (!changed) return rawLine;
  return `${line.slice(0, DATA_PREFIX.length)} ${JSON.stringify(out)}${cr}`;
}

export function createSseTransform(opts: SseTransformOptions): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const process = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    buffer += text;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      controller.enqueue(encoder.encode(`${line.startsWith(DATA_PREFIX) ? rewriteDataLine(line, opts) : line}\n`));
      idx = buffer.indexOf("\n");
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      process(decoder.decode(chunk, { stream: true }), controller);
    },
    flush(controller) {
      process(decoder.decode(), controller);
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(buffer.startsWith(DATA_PREFIX) ? rewriteDataLine(buffer, opts) : buffer));
        buffer = "";
      }
    },
  });
}
