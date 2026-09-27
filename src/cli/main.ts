import { readFile } from "node:fs/promises";
import type { JudgeTransport } from "../core/policy/types";
import { taskPhaseQuestions } from "../core/questions";
import { startDaemon } from "../daemon/server";
import type { FetchLike } from "../judge/http";
import { replay } from "../measure/replay";
import { parseLog, summarize } from "../measure/stats";
import type { EgressName } from "../runtime/defaults";
import { describeDetection, initPolicy } from "../runtime/init";
import { createJudge } from "../runtime/judge-factory";
import { JsonlLogger } from "../runtime/log";
import { decisionsLogPath, resolvePolicyPath } from "../runtime/paths";
import { readPolicyFile } from "../runtime/policy-file";
import { AGENTS, type Agent, runSetup } from "./setup";

const USAGE = `jev-router <command>

  init [--force] [--judge openrouter|vercel|typesafe] [--egress openrouter|vercel]
                                        write ~/.jev-router/policy.json from the keys in your environment
                                        (OPENROUTER_API_KEY, AI_GATEWAY_API_KEY, TYPESAFE_API_KEY) with live prices
  ping                                  ask the judge one question and report latency and cost
  up [--host 127.0.0.1] [--port 4141] [--shadow <candidate>] [--token <secret>]
                                        start the local relay and decision service; --shadow serves one
                                        candidate for everything and only logs what the router would do;
                                        --token (or JEV_ROUTER_TOKEN) is required for any non-loopback host
  stats [--log <path>]                  cost and routing summary of the decision log, against every baseline
  replay --policy <file> [--log <path>] [--policy-id default]
                                        re-decide the log under another policy using recorded judge answers
  setup [--agent <name>]... [--dry-run] [--port 4141] [--token <secret>]
                                        point installed harnesses at the relay and install their hook packs
                                        agents: claude-code, codex, opencode, pi (default: all)
  hook <claude-code|codex>              forward a native hook payload from stdin to the relay (used by hook packs)
  policy                                validate the policy file and print where it was read from
  version | --version
  help

Environment: JEV_ROUTER_HOME, JEV_ROUTER_POLICY, JEV_ROUTER_LOG, and the judge key named by the policy.
`;

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export interface UpOptions {
  readonly host: string;
  readonly port: number;
  readonly shadow?: string;
  readonly token?: string;
}

/** Parse `up` flags. Exported for tests; the token falls back to $JEV_ROUTER_TOKEN. */
export function parseUpOptions(args: readonly string[], env: Readonly<Record<string, string | undefined>>): UpOptions {
  const port = Number(flag(args, "--port") ?? 4141);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port ${flag(args, "--port")}`);
  const shadow = flag(args, "--shadow");
  const token = flag(args, "--token") ?? env.JEV_ROUTER_TOKEN;
  return { host: flag(args, "--host") ?? "127.0.0.1", port, ...(shadow ? { shadow } : {}), ...(token ? { token } : {}) };
}

/** Create the policy from the environment when none exists yet, so `up` and `setup` work with zero configuration. */
async function ensurePolicy(log: (line: string) => void): Promise<string> {
  const policyPath = await resolvePolicyPath();
  const r = await initPolicy({ path: policyPath, log });
  if (r.written) for (const line of describeDetection(r.detection)) log(`  ${line}`);
  return policyPath;
}

async function init(args: readonly string[]): Promise<void> {
  const judge = flag(args, "--judge") as JudgeTransport | undefined;
  const egress = flag(args, "--egress") as EgressName | undefined;
  const r = await initPolicy({
    path: await resolvePolicyPath(),
    force: args.includes("--force"),
    ...(judge ? { judge } : {}),
    ...(egress ? { egress } : {}),
    log: (l) => console.log(l),
  });
  for (const line of describeDetection(r.detection)) console.log(`  ${line}`);
  console.log(`  prices  ${r.pricesFrom}`);
  console.log(
    `  models  ${Object.entries(r.policy.candidates)
      .map(([id, c]) => `${id}=${c.model}`)
      .join("  ")}`,
  );
  console.log("next: `jev-router ping` to test the judge, `jev-router setup` to point your harnesses at it, `jev-router up` to start");
}

async function ping(): Promise<void> {
  const policy = await readPolicyFile(await resolvePolicyPath());
  const judge = createJudge(policy.judge);
  if (!judge)
    throw new Error(
      "no judge configured: set OPENROUTER_API_KEY, AI_GATEWAY_API_KEY, or TYPESAFE_API_KEY and run `jev-router init --force`",
    );
  const res = await judge.evaluate({
    state: { harness: "cli", task: "rename a variable in one file", tools: ["Read", "Edit"], recent_tools: [], images: false },
    questions: taskPhaseQuestions(),
    sessionId: "ping",
  });
  const d = res.answers.difficulty;
  console.log(
    `judge ok: ${policy.judge.transport} -> ${res.model} in ${Math.round(res.latencyMs)} ms${res.usage.costUsd !== undefined ? `, $${res.usage.costUsd.toFixed(6)}` : ""}`,
  );
  console.log(
    `  sample: difficulty ${d?.type === "score" ? d.score.toFixed(2) : "?"} for "rename a variable in one file" (0 trivial .. 3 deep)`,
  );
}

async function up(args: readonly string[]): Promise<void> {
  const policyPath = await ensurePolicy((l) => console.error(l));
  const policy = await readPolicyFile(policyPath);
  const judge = createJudge(policy.judge);
  const logger = new JsonlLogger(decisionsLogPath());
  const o = parseUpOptions(args, process.env);
  const daemon = await startDaemon({
    policy,
    ...(judge ? { judge } : {}),
    log: (r) => logger.write(r),
    host: o.host,
    port: o.port,
    ...(o.shadow ? { shadow: o.shadow } : {}),
    ...(o.token ? { token: o.token } : {}),
  });
  console.error(`jev-router listening on ${daemon.url}`);
  console.error(`  policy  ${policyPath}`);
  console.error(`  judge   ${policy.judge.transport}${judge ? "" : " (none: deterministic only)"}`);
  console.error(`  routes  ${policy.routes.map((r) => r.id).join(", ") || "(none)"}`);
  console.error(`  log     ${decisionsLogPath()}`);
  if (o.shadow) console.error(`  shadow  serving '${o.shadow}' for every routed request; decisions are logged only`);
  if (o.token) console.error("  auth    bearer token required on every endpoint except /healthz");
  const shutdown = async () => {
    await daemon.close();
    await logger.flush();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function policy(): Promise<void> {
  const path = await resolvePolicyPath();
  const p = await readPolicyFile(path);
  console.log(`ok: ${path}`);
  console.log(`  candidates ${Object.keys(p.candidates).join(", ")}`);
  console.log(`  routes     ${p.routes.map((r) => `${r.id} -> ${r.policy}`).join(", ")}`);
}

async function setup(args: readonly string[]): Promise<void> {
  const requested = args.flatMap((a, i) => (a === "--agent" ? [args[i + 1] ?? ""] : []));
  const unknown = requested.filter((a) => !(AGENTS as readonly string[]).includes(a));
  if (unknown.length > 0) throw new Error(`unknown agent(s): ${unknown.join(", ")}; expected ${AGENTS.join(", ")}`);
  const agents = (requested.length > 0 ? requested : AGENTS) as readonly Agent[];
  const port = Number(flag(args, "--port") ?? 4141);
  const setupToken = flag(args, "--token") ?? process.env.JEV_ROUTER_TOKEN;
  await ensurePolicy((l) => console.log(l));
  await runSetup({
    agents,
    baseUrl: `http://127.0.0.1:${port}`,
    hookCommand: process.argv[1] ? `${process.execPath} ${process.argv[1]}` : "jev-router",
    dryRun: args.includes("--dry-run"),
    ...(setupToken ? { token: setupToken } : {}),
    openCodePluginPath: new URL("../adapters/opencode/plugin.js", import.meta.url).pathname,
    log: (line) => console.log(line),
  });
}

/** Forward a native hook payload to the relay. Returns the hook output; never throws so the harness is never blocked. */
export async function forwardHook(
  harness: string,
  payload: string,
  opts: { readonly port?: string; readonly token?: string; readonly fetch?: FetchLike; readonly warn?: (m: string) => void } = {},
): Promise<string> {
  const port = opts.port ?? process.env.JEV_ROUTER_PORT ?? "4141";
  const fetchImpl = opts.fetch ?? fetch;
  try {
    await fetchImpl(`http://127.0.0.1:${port}/hooks/${harness}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: payload || "{}",
      signal: AbortSignal.timeout(2000),
    });
  } catch (e) {
    (opts.warn ?? console.error)(`jev-router hook: relay unreachable (${e instanceof Error ? e.message : String(e)})`);
  }
  return "{}";
}

async function hook(args: readonly string[]): Promise<void> {
  const harness = args[0];
  if (harness !== "claude-code" && harness !== "codex") throw new Error("hook needs a harness: claude-code or codex");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const token = process.env.JEV_ROUTER_TOKEN;
  console.log(await forwardHook(harness, Buffer.concat(chunks).toString("utf8"), token ? { token } : {}));
}

const usd = (n: number): string => `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 6 : 4)}`;
const pct = (n: number | null): string => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);

async function loadLog(args: readonly string[]): Promise<ReturnType<typeof parseLog>> {
  const path = flag(args, "--log") ?? decisionsLogPath();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read decision log at ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseLog(text);
}

async function stats(args: readonly string[]): Promise<void> {
  const policy = await readPolicyFile(flag(args, "--policy") ?? (await resolvePolicyPath()));
  const { records, skipped } = await loadLog(args);
  const s = summarize(records, policy);
  console.log(
    `decisions ${s.decisions} across ${s.sessions} sessions (${s.withUsage} with usage${skipped ? `, ${skipped} malformed lines skipped` : ""})`,
  );
  console.log(
    `actual cost ${usd(s.actualCostUsd)}   judge ${s.judge.calls} calls ${usd(s.judge.costUsd)} p50 ${s.judge.latencyP50Ms === null ? "-" : Math.round(s.judge.latencyP50Ms)}ms p95 ${s.judge.latencyP95Ms === null ? "-" : Math.round(s.judge.latencyP95Ms)}ms, ${s.judge.failures} failed   apply failures ${s.applyFailures}`,
  );
  console.log("baseline            cost      savings    pct");
  for (const [id, b] of Object.entries(s.baselines))
    console.log(`always ${id.padEnd(12)} ${usd(b.costUsd).padStart(9)} ${usd(b.savingsUsd).padStart(10)} ${pct(b.savingsPct).padStart(7)}`);
  console.log(`by candidate ${JSON.stringify(s.byCandidate)}`);
  console.log(`by source    ${JSON.stringify(s.bySource)}`);
}

async function replayCmd(args: readonly string[]): Promise<void> {
  const policyPath = flag(args, "--policy");
  if (!policyPath) throw new Error("replay needs --policy <file>");
  const policy = await readPolicyFile(policyPath);
  const policyId = flag(args, "--policy-id") ?? policy.routes[0]?.policy ?? Object.keys(policy.policies)[0] ?? "default";
  const { records } = await loadLog(args);
  const r = replay(records, policy, policyId);
  console.log(
    `replayed ${r.results.length} decisions under ${policyPath} (${policyId}): ${r.changed} changed, ${r.unjudged} without recorded judge answers`,
  );
  console.log(
    `recorded cost ${usd(r.recordedCostUsd)}  replayed cost ${usd(r.replayedCostUsd)}  delta ${usd(r.replayedCostUsd - r.recordedCostUsd)} (same tokens assumed)`,
  );
  const moves: Record<string, number> = {};
  for (const x of r.results)
    if (x.recorded.candidate !== x.replayed.candidate)
      moves[`${x.recorded.candidate} -> ${x.replayed.candidate}`] = (moves[`${x.recorded.candidate} -> ${x.replayed.candidate}`] ?? 0) + 1;
  for (const [k, v] of Object.entries(moves)) console.log(`  ${k}: ${v}`);
}

async function version(): Promise<void> {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; version: string };
  console.log(`${pkg.name} ${pkg.version}`);
}

export async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v" || command === "version") return version();
  if (command === "init") return init(rest);
  if (command === "ping") return ping();
  if (command === "up") return up(rest);
  if (command === "setup") return setup(rest);
  if (command === "hook") return hook(rest);
  if (command === "stats") return stats(rest);
  if (command === "replay") return replayCmd(rest);
  if (command === "policy") return policy();
  console.log(USAGE);
  if (command && command !== "help") process.exitCode = 1;
}
