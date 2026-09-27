#!/usr/bin/env node
// Client-cancellation smoke test, run under Node against the built daemon.
// Bun's node:http emits no event when a client aborts mid-stream, so bun test cannot cover this path.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { loadPolicy } from "../dist/core/index.js";
import { startDaemon } from "../dist/daemon/index.js";

let upstreamClosedEarly = false;
const upstream = createServer((req, res) => {
  let finished = false;
  const closedEarly = () => { if (!finished) upstreamClosedEarly = true; };
  req.on("close", closedEarly);
  res.on("close", closedEarly);
  req.on("data", () => undefined);
  req.on("end", async () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"up","usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
    for (let i = 0; i < 40 && !res.destroyed; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      if (!res.destroyed) res.write('event: ping\ndata: {"type":"ping"}\n\n');
    }
    finished = true;
    if (!res.destroyed) res.end();
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

const raw = JSON.parse(await readFile(new URL("../examples/policy.json", import.meta.url), "utf8"));
raw.judge = { transport: "mock" };
raw.egress = { openrouter: { base_url: upstreamUrl, api_key_env: "SMOKE_KEY" } };
const records = [];
const daemon = await startDaemon({ policy: loadPolicy(raw), env: { SMOKE_KEY: "k" }, port: 0, log: (r) => records.push(r) });

const ctrl = new AbortController();
const res = await fetch(`${daemon.url}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-claude-code-session-id": "cancel-smoke" },
  body: JSON.stringify({ model: "auto", max_tokens: 8, stream: true, messages: [{ role: "user", content: "hi" }] }),
  signal: ctrl.signal,
});
const reader = res.body.getReader();
await reader.read();
ctrl.abort();
for (let i = 0; i < 80 && records.length === 0; i += 1) await new Promise((r) => setTimeout(r, 25));

await daemon.close();
upstream.closeAllConnections?.();
upstream.close();

const record = records[0];
const ok = upstreamClosedEarly && record && record.apply && record.apply.ok === false && record.apply.error === "client disconnected";
console.log(`cancel-smoke: upstreamClosedEarly=${upstreamClosedEarly} records=${records.length} apply=${JSON.stringify(record?.apply)}`);
if (!ok) {
  console.error("cancel-smoke: FAILED, client cancellation did not propagate to the upstream");
  process.exit(1);
}
console.log("cancel-smoke: ok");
