#!/usr/bin/env node
// Join Harbor job results with jev-router decision logs into one comparison table.
//   node scripts/bench-report.mjs --jobs /tmp/jev-bench/jobs --logs /tmp/jev-bench --policy ~/.jev-router/policy.json routed fast mid
// Each positional argument is a configuration name: job dir tb-<agent>-<name>, decision log <name>.jsonl.
// Relay sessions are matched to tasks by time window and call count (Pi transcripts), so every task gets its own
// upstream cost and served-tier mix. Repeated attempts of one task share a relay session (identical prompt prefix), so
// matching is per task and per-task cost is the average over its attempts. Unmatched sessions are reported, never dropped.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const jobsDir = flag("--jobs", "/tmp/jev-bench/jobs");
const logsDir = flag("--logs", "/tmp/jev-bench");
const agent = flag("--agent", "pi");
const policyPath = flag("--policy", join(process.env.JEV_ROUTER_HOME ?? `${process.env.HOME}/.jev-router`, "policy.json"));
const configs = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (configs.length === 0) { console.error("usage: bench-report.mjs [--jobs dir] [--logs dir] [--agent pi] [--policy file] <config>..."); process.exit(2); }

const policy = existsSync(policyPath) ? JSON.parse(readFileSync(policyPath, "utf8")) : { candidates: {} };
const listPrice = (cand, usage) => {
  const c = policy.candidates?.[cand]; if (!c || !usage) return 0;
  return (usage.inputTokens / 1e6) * c.price.in + (usage.outputTokens / 1e6) * c.price.out;
};
const served = (r) => r.shadow?.served ?? r.decision.candidate;
const recordCost = (r) => r.usage?.costUsd ?? listPrice(served(r), r.usage);
const WINDOW_MS = 5000;

function trials(jobName) {
  const dir = join(jobsDir, jobName);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => statSync(join(dir, d)).isDirectory() && existsSync(join(dir, d, "result.json")))
    .map((d) => ({ dir: join(dir, d), result: JSON.parse(readFileSync(join(dir, d, "result.json"), "utf8")) }));
}
function reward(t) {
  const v = t.verifier_result;
  if (!v) return null;
  if (typeof v.reward === "number") return v.reward;
  if (v.rewards && typeof v.rewards === "object") { const vals = Object.values(v.rewards).filter((x) => typeof x === "number"); if (vals.length) return vals.reduce((a, b) => a + b, 0) / vals.length; }
  return null;
}
function window(t) {
  const s = t.agent_execution ?? t;
  return s?.started_at && s?.finished_at ? [Date.parse(s.started_at), Date.parse(s.finished_at)] : null;
}
// Number of model responses in a Pi transcript, deduplicated by response id.
function piResponses(dir) {
  const p = join(dir, "agent", "pi.txt");
  if (!existsSync(p)) return null;
  const ids = new Set();
  const walk = (x) => {
    if (Array.isArray(x)) { for (const v of x) walk(v); return; }
    if (!x || typeof x !== "object") return;
    if (x.role === "assistant" && x.responseId) ids.add(x.responseId);
    for (const v of Object.values(x)) walk(v);
  };
  for (const line of readFileSync(p, "utf8").split("\n")) { if (!line.trim()) continue; try { walk(JSON.parse(line)); } catch { /* partial line */ } }
  return ids.size;
}
function logRecords(name) {
  const p = join(logsDir, `${name}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function sessionsOf(recs) {
  const m = new Map();
  for (const r of recs) { const k = r.session ?? "?"; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m.entries()].map(([id, rs]) => ({ id, records: rs, first: Math.min(...rs.map((r) => r.ts)), last: Math.max(...rs.map((r) => r.ts)) }));
}
// Group trials by task: window spanning all attempts, total model calls across them.
function taskGroups(ts) {
  const groups = new Map();
  for (const t of ts) {
    const g = groups.get(t.result.task_name) ?? { name: t.result.task_name, trials: [], window: null, calls: 0, callsKnown: true };
    g.trials.push(t);
    if (t.window) g.window = g.window ? [Math.min(g.window[0], t.window[0]), Math.max(g.window[1], t.window[1])] : [...t.window];
    if (t.calls === null) g.callsKnown = false; else g.calls += t.calls;
    groups.set(t.result.task_name, g);
  }
  return [...groups.values()];
}
// Assign each relay session to at most one task: the session must fall inside the task's window; prefer an exact
// call-count match, then the nearest start. Returns taskName -> records, plus the sessions nothing claimed.
function matchSessions(groups, recs) {
  const sessions = sessionsOf(recs);
  const claimed = new Map();
  const unmatched = [];
  const candidates = sessions.map((s) => groups.filter((g) => g.window && s.first >= g.window[0] - WINDOW_MS && s.last <= g.window[1] + WINDOW_MS).map((g) => ({ name: g.name, exact: g.callsKnown && g.calls === s.records.length, dist: s.first - g.window[0] })));
  const order = sessions.map((_, k) => k).sort((a, b) => candidates[a].length - candidates[b].length);
  for (const k of order) {
    const free = candidates[k].filter((c) => !claimed.has(c.name)).sort((a, b) => Number(b.exact) - Number(a.exact) || a.dist - b.dist);
    if (free.length === 0) { unmatched.push(sessions[k]); continue; }
    claimed.set(free[0].name, sessions[k].records);
  }
  return { byTask: claimed, unmatched };
}

const usd = (n) => (n === null || n === undefined ? "n/a" : `$${n.toFixed(n < 0.01 && n > 0 ? 4 : n < 0.1 ? 3 : 2)}`);
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : "n/a");
const mixOf = (recs) => { const m = {}; for (const r of recs) m[served(r)] = (m[served(r)] ?? 0) + 1; return Object.entries(m).map(([k, v]) => `${k} ${v}`).join(", "); };

const rows = [];
const perTask = new Map();
const notes = [];
for (const name of configs) {
  const ts = trials(`tb-${agent}-${name}`).map(({ dir, result }) => ({ result, window: window(result), calls: piResponses(dir) }));
  const recs = logRecords(name);
  const groups = taskGroups(ts);
  const { byTask, unmatched } = matchSessions(groups, recs);
  if (unmatched.length) notes.push(`${name}: ${unmatched.length} relay session(s) with ${unmatched.reduce((s, u) => s + u.records.length, 0)} records matched no trial (their cost is in the config total only).`);
  const solved = ts.filter((t) => (reward(t.result) ?? 0) >= 1).length;
  const errored = ts.filter((t) => t.result.exception_info).length;
  const relayCost = recs.reduce((s, r) => s + recordCost(r), 0);
  const judgeCost = recs.reduce((s, r) => s + (r.judge?.costUsd ?? 0), 0);
  const judged = recs.filter((r) => r.judge && !r.judge.error);
  const judgeMs = judged.map((r) => r.judge.latencyMs).filter((x) => typeof x === "number").sort((a, b) => a - b);
  const decided = {}; for (const r of recs) decided[r.decision.candidate] = (decided[r.decision.candidate] ?? 0) + 1;
  rows.push({ name, tasks: ts.length, solved, errored, relayCost, judgeCost, judgeCalls: judged.length, judgeP50: judgeMs.length ? judgeMs[Math.floor(judgeMs.length / 2)] : null, mix: mixOf(recs), decided, requests: recs.length });
  for (const g of groups) {
    const rs = byTask.get(g.name) ?? [];
    const costPerAttempt = rs.length ? rs.reduce((s, r) => s + recordCost(r), 0) / g.trials.length : null;
    const m = perTask.get(g.name) ?? {};
    m[name] = g.trials.map((t) => ({ reward: reward(t.result), secs: t.window ? (t.window[1] - t.window[0]) / 1000 : null, err: t.result.exception_info?.exception_type, cost: costPerAttempt, mix: mixOf(rs) }));
    perTask.set(g.name, m);
  }
}

console.log(`# Terminal-Bench 2.0 via Harbor, agent: ${agent}\n`);
console.log("| config | trials | solved | success | errored | upstream cost | cost / solved | judge calls | judge p50 | judge cost | served |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.name} | ${r.tasks} | ${r.solved} | ${pct(r.solved, r.tasks)} | ${r.errored} | ${usd(r.relayCost)} | ${r.solved ? usd(r.relayCost / r.solved) : "n/a"} | ${r.judgeCalls} | ${r.judgeP50 === null ? "n/a" : `${Math.round(r.judgeP50)} ms`} | ${usd(r.judgeCost)} | ${r.mix || "-"} |`);
const routed = rows.find((r) => r.name === "routed");
if (routed && Object.keys(routed.decided).length) console.log(`\nRouted decisions by candidate: ${Object.entries(routed.decided).map(([k, v]) => `${k} ${v}`).join(", ")} over ${routed.requests} requests.`);

console.log(`\n| task | ${configs.join(" | ")} |`);
console.log(`|---|${configs.map(() => "---").join("|")}|`);
const cell = (list) => {
  if (!list) return "-";
  const passed = list.filter((x) => (x.reward ?? 0) >= 1).length;
  const errs = list.filter((x) => x.err).length;
  const costs = list.filter((x) => x.cost !== null).map((x) => x.cost);
  const avgCost = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null;
  const secs = list.filter((x) => x.secs).map((x) => x.secs);
  const avgSecs = secs.length ? secs.reduce((a, b) => a + b, 0) / secs.length : null;
  const head = list.length === 1 ? (errs ? `error (${list[0].err})` : (list[0].reward ?? 0) >= 1 ? "pass" : "fail") : `${passed}/${list.length}${errs ? ` (${errs} err)` : ""}`;
  const mixes = [...new Set(list.map((x) => x.mix).filter(Boolean))].join(" / ");
  return [head, avgSecs !== null ? `${Math.round(avgSecs)}s` : null, avgCost !== null ? usd(avgCost) : null, mixes || null].filter(Boolean).join(" · ");
};
for (const [task, m] of [...perTask.entries()].sort()) console.log(`| ${task} | ${configs.map((c) => cell(m[c])).join(" | ")} |`);

for (const n of notes) console.log(`\nNote: ${n}`);
console.log("\nUpstream cost is what the gateway reported per request in the relay log (list price when absent); per-task cells show the average per attempt for that task and which tier served its requests. Cost per solved task is the honest figure; a config that is cheaper but solves fewer tasks has not won.");
