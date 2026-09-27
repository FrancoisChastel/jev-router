#!/usr/bin/env node
// Join Harbor job results with jev-router decision logs into one comparison table.
//   node scripts/bench-report.mjs --jobs /tmp/jev-bench/jobs --logs /tmp/jev-bench --policy ~/.jev-router/policy.json routed fast mid
// Each positional argument is a configuration name: job dir tb-<agent>-<name>, decision log <name>.jsonl.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const jobsDir = flag("--jobs", "/tmp/jev-bench/jobs");
const logsDir = flag("--logs", "/tmp/jev-bench");
const agent = flag("--agent", "pi");
const policyPath = flag("--policy", join(process.env.JEV_ROUTER_HOME ?? `${process.env.HOME}/.jev-router`, "policy.json"));
const configs = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (configs.length === 0) { console.error("usage: bench-report.mjs [--jobs dir] [--logs dir] [--agent pi] <config>..."); process.exit(2); }

const policy = existsSync(policyPath) ? JSON.parse(readFileSync(policyPath, "utf8")) : { candidates: {} };
const price = (cand, usage) => {
  const c = policy.candidates?.[cand]; if (!c || !usage) return 0;
  return (usage.inputTokens / 1e6) * c.price.in + (usage.outputTokens / 1e6) * c.price.out;
};

function trials(jobName) {
  const dir = join(jobsDir, jobName);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory() && existsSync(join(dir, d, "result.json")))
    .map((d) => JSON.parse(readFileSync(join(dir, d, "result.json"), "utf8")));
}
function reward(t) {
  const v = t.verifier_result;
  if (!v) return null;
  if (typeof v.reward === "number") return v.reward;
  if (v.rewards && typeof v.rewards === "object") { const vals = Object.values(v.rewards).filter((x) => typeof x === "number"); if (vals.length) return vals.reduce((a, b) => a + b, 0) / vals.length; }
  return null;
}
function tokens(t) { const a = t.agent_result ?? {}; return { in: a.n_input_tokens ?? 0, out: a.n_output_tokens ?? 0, cache: a.n_cache_tokens ?? 0, cost: a.cost_usd ?? null }; }
function seconds(t) { const s = t.agent_execution ?? t; return s?.started_at && s?.finished_at ? (new Date(s.finished_at) - new Date(s.started_at)) / 1000 : null; }

function logRecords(name) {
  const p = join(logsDir, `${name}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const usd = (n) => (n === null || n === undefined ? "n/a" : `$${n.toFixed(n < 0.01 && n > 0 ? 4 : 2)}`);
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : "n/a");

const rows = [];
const perTask = new Map();
for (const name of configs) {
  const ts = trials(`tb-${agent}-${name}`);
  const recs = logRecords(name);
  const solved = ts.filter((t) => (reward(t) ?? 0) >= 1).length;
  const errored = ts.filter((t) => t.exception_info).length;
  const relayCost = recs.reduce((s, r) => s + (r.usage?.costUsd ?? price(r.shadow?.served ?? r.decision.candidate, r.usage)), 0);
  const judgeCost = recs.reduce((s, r) => s + (r.judge?.costUsd ?? 0), 0);
  const judgeCalls = recs.filter((r) => r.judge && !r.judge.error).length;
  const mix = {}; for (const r of recs) { const c = r.shadow?.served ?? r.decision.candidate; mix[c] = (mix[c] ?? 0) + 1; }
  const decided = {}; for (const r of recs) decided[r.decision.candidate] = (decided[r.decision.candidate] ?? 0) + 1;
  const agentTokens = ts.reduce((s, t) => { const k = tokens(t); return { in: s.in + k.in, out: s.out + k.out }; }, { in: 0, out: 0 });
  rows.push({ name, tasks: ts.length, solved, errored, relayCost, judgeCost, judgeCalls, mix, decided, requests: recs.length, agentTokens });
  for (const t of ts) {
    const m = perTask.get(t.task_name) ?? {}; m[name] = { reward: reward(t), secs: seconds(t), err: t.exception_info?.exception_type }; perTask.set(t.task_name, m);
  }
}

console.log(`# Terminal-Bench 2.0 via Harbor, agent: ${agent}\n`);
console.log("| config | tasks | solved | success | errored | upstream cost | cost / solved | judge calls | judge cost | served mix |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  const mix = Object.entries(r.mix).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`| ${r.name} | ${r.tasks} | ${r.solved} | ${pct(r.solved, r.tasks)} | ${r.errored} | ${usd(r.relayCost)} | ${r.solved ? usd(r.relayCost / r.solved) : "n/a"} | ${r.judgeCalls} | ${usd(r.judgeCost)} | ${mix || "-"} |`);
}
const routed = rows.find((r) => r.name === "routed");
if (routed && Object.keys(routed.decided).length) console.log(`\nRouted decisions by candidate: ${Object.entries(routed.decided).map(([k, v]) => `${k}:${v}`).join(", ")} over ${routed.requests} requests.`);
console.log(`\n| task | ${configs.join(" | ")} |`);
console.log(`|---|${configs.map(() => "---").join("|")}|`);
for (const [task, m] of [...perTask.entries()].sort()) {
  console.log(`| ${task} | ${configs.map((c) => { const x = m[c]; if (!x) return "-"; if (x.err) return `error (${x.err})`; return `${x.reward === null ? "?" : x.reward >= 1 ? "pass" : "fail"}${x.secs ? ` ${Math.round(x.secs)}s` : ""}`; }).join(" | ")} |`);
}
console.log("\nUpstream cost is what OpenRouter reported per request in the relay log (or list price when absent). Cost per solved task is the honest figure; a config that is cheaper but solves fewer tasks has not won.");
