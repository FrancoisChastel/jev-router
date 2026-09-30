import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import type { JudgeTransport } from "../core/policy/types";
import { taskPhaseQuestions } from "../core/questions";
import { startDaemon } from "../daemon/server";
import type { FetchLike } from "../judge/http";
import { replay } from "../measure/replay";
import { parseLog, summarize } from "../measure/stats";
import type { EgressName } from "../runtime/defaults";
import { applyEnv, envFilePath, formatEnvFile, loadEnvFile } from "../runtime/envfile";
import { GEMINI_API_EGRESS, GEMINI_API_KEY_ENV } from "../runtime/gemini-defaults";
import { describeDetection, initPolicy } from "../runtime/init";
import { createJudge } from "../runtime/judge-factory";
import { JsonlLogger } from "../runtime/log";
import { configDir, decisionsLogPath, resolvePolicyPath } from "../runtime/paths";
import { readPolicyFile } from "../runtime/policy-file";
import { defaultProbe, detectAgents, executableOnPath } from "./detect-agents";
import {
  cursorPasteValues,
  parseExposeOptions,
  parseTunnelUrl,
  pickTunnel,
  probeRelayAuth,
  refusal,
  TUNNEL_INSTALL_HINTS,
  type TunnelCommand,
} from "./expose";
import { claudeCodeBehavesAs, harnessAuth } from "./plans";
import { installService, type ServiceDeps, type ServiceSpec, serviceState, uninstallService } from "./service";
import { AGENTS, type Agent, runSetup } from "./setup";
import { statusLine } from "./statusline";
import { formatWhy } from "./why";

const USAGE = `jev-router <command>

  init [--force] [--judge openrouter|vercel|typesafe] [--egress openrouter|vercel] [--no-subscriptions]
                                        write ~/.jev-router/policy.json from the keys in your environment
                                        (OPENROUTER_API_KEY, AI_GATEWAY_API_KEY, TYPESAFE_API_KEY, and GEMINI_API_KEY
                                        for Gemini CLI) with live prices
  ping                                  ask the judge one question and report latency and cost
  up [--host 127.0.0.1] [--port 4141] [--shadow <candidate>] [--token <secret>]
                                        start the local relay and decision service; --shadow serves one
                                        candidate for everything and only logs what the router would do;
                                        --token (or JEV_ROUTER_TOKEN) is required for any non-loopback host
  stats [--log <path>]                  cost and routing summary of the decision log, against every baseline
  replay --policy <file> [--log <path>] [--policy-id default]
                                        re-decide the log under another policy using recorded judge answers
  setup [--judge-key <key>] [--agent <name>]... [--no-service] [--no-prompt] [--dry-run] [--port 4141] [--token <secret>]
                                        one command: take the judge key (asked for once, stored in ~/.jev-router/env),
                                        detect your Claude Code, Codex, and Gemini CLI logins and installed harnesses, write the
                                        policy, point each harness at the relay, install the relay as a background
                                        service, and check it answers. agents: claude-code, codex, opencode, gemini, pi, cursor
                                        (cursor: prints the steps; its settings live in the app)
  service install|uninstall|status [--port 4141]
                                        manage the background relay (launchd on macOS, systemd --user on Linux)
  expose [--port 4141] [--token <secret>] [--tunnel cloudflared|ngrok]
                                        publish a token-guarded relay through a tunnel (cloudflared, else ngrok) and
                                        print the base URL, key, and model to paste into Cursor; refuses a relay that
                                        answers without the token (--token or JEV_ROUTER_TOKEN)
  hook <claude-code|codex|gemini>       forward a native hook payload from stdin to the relay (used by hook packs)
  why [--session <key>] [--last N] [--log <path>]
                                        explain the last decision(s): tier, model, effort, reasons, judge answers,
                                        cost, counterfactuals, and the plan window it saw
  statusline [--port 4141] [--url <loopback url>]
                                        one line for Claude Code's statusLine: tier, saved today, plan 5h usage;
                                        prints nothing when the relay is not running
  policy                                validate the policy file and print where it was read from
  version | --version
  help

Environment: JEV_ROUTER_HOME, JEV_ROUTER_POLICY, JEV_ROUTER_LOG, and the judge key named by the policy
(read from the environment, else from ~/.jev-router/env).
`;

const JUDGE_KEY_ENVS = ["OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY"] as const;

/** Which environment variable a pasted judge key belongs in, from an explicit transport or the key's prefix. */
export function judgeKeyEnv(key: string, judge?: string): string {
  if (judge === "openrouter") return "OPENROUTER_API_KEY";
  if (judge === "vercel") return "AI_GATEWAY_API_KEY";
  if (judge === "typesafe") return "TYPESAFE_API_KEY";
  if (judge) throw new Error(`unknown --judge ${judge}; expected openrouter, vercel, or typesafe`);
  if (key.startsWith("sk-or-")) return "OPENROUTER_API_KEY";
  if (key.startsWith("vck_")) return "AI_GATEWAY_API_KEY";
  throw new Error("cannot tell which provider this key belongs to; add --judge openrouter|vercel|typesafe");
}

/** Store a key in the 600 env file every command (and the background service) reads. */
async function saveKey(envName: string, key: string): Promise<string> {
  const path = envFilePath(process.env);
  const vars = { ...(await loadEnvFile(path)), [envName]: key };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatEnvFile(vars), { mode: 0o600 });
  await chmod(path, 0o600);
  process.env[envName] = key;
  return path;
}

/**
 * The relay injects GEMINI_API_KEY upstream for Gemini CLI, and a background service has no shell to inherit it from,
 * so the key from this shell goes in the same 600 env file as the judge key.
 */
async function keepGeminiKey(dryRun: boolean, log: (line: string) => void): Promise<void> {
  const path = envFilePath(process.env);
  if ((await loadEnvFile(path))[GEMINI_API_KEY_ENV]) return;
  const key = process.env[GEMINI_API_KEY_ENV];
  if (!key) {
    log(`gemini: ${GEMINI_API_KEY_ENV} is not set; add it to ${path} so the background relay can reach the Gemini API`);
    return;
  }
  if (dryRun) log(`gemini: would store ${GEMINI_API_KEY_ENV} in ${path}`);
  else log(`gemini: ${GEMINI_API_KEY_ENV} stored in ${await saveKey(GEMINI_API_KEY_ENV, key)} (mode 600) for the background relay`);
}

async function askForKey(): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      "Judge key (OpenRouter sk-or-... or Vercel AI Gateway vck_...): it pays for jev, about $0.00003 a decision. Enter to skip: ",
    );
    return answer.trim() || undefined;
  } finally {
    rl.close();
  }
}

const execFileAsync = promisify(execFile);

function realServiceDeps(): ServiceDeps {
  return {
    platform: process.platform,
    homeDir: homedir(),
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    run: async (command, args) => {
      try {
        const r = await execFileAsync(command, [...args], { encoding: "utf8" });
        return { code: 0, stdout: r.stdout, stderr: r.stderr };
      } catch (e) {
        const err = e as { code?: number | string; stdout?: string; stderr?: string; message?: string };
        return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "" };
      }
    },
    writeFile: async (path, content) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    removeFile: (path) => rm(path, { force: true }),
  };
}

function serviceSpec(port: number): ServiceSpec {
  const cliPath = process.argv[1] ?? "";
  const env: Record<string, string> = { HOME: homedir(), PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
  if (process.env.JEV_ROUTER_HOME) env.JEV_ROUTER_HOME = process.env.JEV_ROUTER_HOME;
  return { execPath: process.execPath, cliPath, port, logPath: `${configDir(process.env)}/relay.log`, env };
}

async function waitHealthy(baseUrl: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function service(args: readonly string[]): Promise<void> {
  const action = args[0];
  const port = Number(flag(args, "--port") ?? 4141);
  const deps = realServiceDeps();
  if (action === "install") {
    const r = await installService(serviceSpec(port), deps);
    console.log(`${r.ok ? "ok" : "failed"}: ${r.detail}${r.path ? ` (${r.path})` : ""}`);
    if (r.ok)
      console.log(
        (await waitHealthy(`http://127.0.0.1:${port}`, 10_000))
          ? `relay answering on http://127.0.0.1:${port}`
          : `relay not answering yet; see ${configDir(process.env)}/relay.log`,
      );
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (action === "uninstall") {
    const r = await uninstallService(deps);
    console.log(`${r.ok ? "ok" : "failed"}: ${r.detail}`);
    return;
  }
  if (action === "status") {
    const state = await serviceState(deps);
    const healthy = await waitHealthy(`http://127.0.0.1:${port}`, 1500);
    console.log(`service ${state}; relay on http://127.0.0.1:${port} ${healthy ? "answering" : "not answering"}`);
    return;
  }
  throw new Error("service needs install, uninstall, or status");
}

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
  if (r.written) for (const line of describeDetection(r.detection, r.subscriptions, r.ollama)) log(`  ${line}`);
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
    ...(args.includes("--no-subscriptions") ? { subscriptions: false } : {}),
    log: (l) => console.log(l),
  });
  for (const line of describeDetection(r.detection, r.subscriptions, r.ollama)) console.log(`  ${line}`);
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
  console.error(`  routes  ${policy.routes.map((r) => `${r.id}${r.harness === "any" ? "" : ` (${r.harness})`}`).join(", ") || "(none)"}`);
  const forwarded = Object.entries(policy.egress)
    .filter(([, e]) => e.forward_auth)
    .map(([n]) => n);
  if (forwarded.length > 0) console.error(`  logins  forwarded as-is to ${forwarded.join(", ")}; nothing is stored`);
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
  const port = Number(flag(args, "--port") ?? 4141);
  const dryRun = args.includes("--dry-run");
  const setupToken = flag(args, "--token") ?? process.env.JEV_ROUTER_TOKEN;
  const log = (line: string) => console.log(line);

  // 1. The judge key, once. Stored in the env file so the background service finds it.
  const hasJudgeKey = JUDGE_KEY_ENVS.some((k) => process.env[k]);
  const pasted = flag(args, "--judge-key") ?? (!hasJudgeKey && !args.includes("--no-prompt") ? await askForKey() : undefined);
  if (pasted) {
    const envName = judgeKeyEnv(pasted, flag(args, "--judge"));
    if (dryRun) log(`judge: would store ${envName} in ${envFilePath(process.env)}`);
    else log(`judge: ${envName} stored in ${await saveKey(envName, pasted)} (mode 600)`);
  } else if (!hasJudgeKey) log("judge: no key; routing uses tool signals only until one is added (`jev-router setup --judge-key ...`)");

  // 2. The policy: keys, logins, live prices.
  const policyPath = await ensurePolicy(log);
  const policy = await readPolicyFile(policyPath);
  const auth = {
    claudeCode: harnessAuth(policy, "claude-code"),
    codex: harnessAuth(policy, "codex"),
    gemini: harnessAuth(policy, "gemini"),
  };
  const behavesAs = claudeCodeBehavesAs(policy);

  // 3. Every harness that is actually installed, unless told which.
  const detected = requested.length > 0 ? [] : await detectAgents(defaultProbe(homedir()));
  const agents = (requested.length > 0 ? requested : detected) as readonly Agent[];
  if (agents.length === 0) log(`harnesses: none of ${AGENTS.join(", ")} found; pass --agent to configure one anyway`);
  else log(`harnesses: ${agents.join(", ")}${requested.length > 0 ? "" : " (installed)"}`);
  if (agents.includes("gemini") && auth.gemini === "token" && policy.egress[GEMINI_API_EGRESS]) await keepGeminiKey(dryRun, log);
  await runSetup({
    agents,
    baseUrl: `http://127.0.0.1:${port}`,
    hookCommand: process.argv[1] ? `${process.execPath} ${process.argv[1]}` : "jev-router",
    dryRun,
    auth,
    ...(behavesAs ? { behavesAs } : {}),
    ...(setupToken ? { token: setupToken } : {}),
    openCodePluginPath: new URL("../adapters/opencode/plugin.js", import.meta.url).pathname,
    log,
  });

  // 4. The relay, as a service that outlives this terminal.
  const baseUrl = `http://127.0.0.1:${port}`;
  if (dryRun || args.includes("--no-service")) {
    log(
      `relay: ${dryRun ? "would install" : "not installing"} the background service; start it with 'jev-router up' (or 'jev-router service install')`,
    );
    return;
  }
  const r = await installService(serviceSpec(port), realServiceDeps());
  if (!r.ok) {
    log(`relay: ${r.detail}`);
    return;
  }
  log(`relay: ${r.detail} (${r.path})`);
  log(
    (await waitHealthy(baseUrl, 10_000))
      ? `relay: answering on ${baseUrl}; you are done`
      : `relay: not answering yet; check ${configDir(process.env)}/relay.log`,
  );
}

const TUNNEL_URL_TIMEOUT_MS = 30_000;
const RELAY_RECHECK_MS = 5_000;
const TUNNEL_OUTPUT_KEEP_CHARS = 16_384;

/** Publish a token-guarded relay through cloudflared or ngrok and print what Cursor needs. Runs until Ctrl-C. */
async function expose(args: readonly string[]): Promise<void> {
  const o = parseExposeOptions(args, process.env);
  const baseUrl = `http://127.0.0.1:${o.port}`;
  const state = await probeRelayAuth(fetch, baseUrl, o.token);
  if (state !== "guarded") {
    console.error(refusal(state, o.port));
    process.exitCode = 1;
    return;
  }
  const tunnel = await pickTunnel(o.port, (b) => executableOnPath(b), o.tunnel);
  if (!tunnel) {
    for (const line of TUNNEL_INSTALL_HINTS) console.error(line);
    process.exitCode = 1;
    return;
  }
  console.error(`relay on ${baseUrl} requires its token; starting ${tunnel.command} ${tunnel.args.join(" ")}`);
  process.exitCode = await runTunnel(tunnel, o.token, baseUrl);
}

/** Spawn the tunnel, print Cursor's values once its URL appears, and stop it if the relay ever answers without a token. */
function runTunnel(tunnel: TunnelCommand, token: string, baseUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(tunnel.command, [...tunnel.args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let url: string | undefined;
    let failure: string | undefined;
    const stop = (reason?: string) => {
      if (reason && !failure) failure = reason;
      child.kill("SIGTERM");
    };
    const onData = (chunk: Buffer) => {
      if (url) return;
      output = (output + chunk.toString("utf8")).slice(-TUNNEL_OUTPUT_KEEP_CHARS);
      url = parseTunnelUrl(tunnel.kind, output);
      if (url) for (const line of cursorPasteValues(url, token)) console.log(line);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      if (!url) stop(`${tunnel.command} printed no public URL within ${TUNNEL_URL_TIMEOUT_MS / 1000}s`);
    }, TUNNEL_URL_TIMEOUT_MS);
    // The relay behind the tunnel could be restarted without a token; never keep publishing it if so.
    const watchdog = setInterval(() => {
      void probeRelayAuth(fetch, baseUrl, token).then((s) => {
        if (s === "open" || s === "token-rejected") stop(`tunnel stopped: ${refusal(s, Number(new URL(baseUrl).port))}`);
      });
    }, RELAY_RECHECK_MS);
    const onSignal = () => stop();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    child.on("error", (e) => stop(`${tunnel.command} failed to start: ${e.message}`));
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(watchdog);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (failure) console.error(failure);
      else if (!url) console.error(`${tunnel.command} exited (${code ?? "signal"}) before printing a public URL:\n${output.slice(-2000)}`);
      resolve(failure || !url ? 1 : 0);
    });
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
  if (harness !== "claude-code" && harness !== "codex" && harness !== "gemini")
    throw new Error("hook needs a harness: claude-code, codex, or gemini");
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
  if (s.cascades.requests > 0)
    console.log(
      `cascades     ${s.cascades.requests} requests retried ${s.cascades.retries} times, ${usd(s.cascades.discardedCostUsd)} spent on attempts the client never saw (included in actual cost)`,
    );
  const plans = Object.entries(policy.egress)
    .filter(([, e]) => e.billing === "subscription")
    .map(([n]) => n);
  if (plans.length > 0)
    console.log(
      `note: ${plans.join(", ")} bill through a plan; their figures are API list-price equivalents, the scale the plan's allowance is consumed on`,
    );
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

async function why(args: readonly string[]): Promise<void> {
  const { records, skipped } = await loadLog(args);
  const last = Number(flag(args, "--last") ?? 1);
  if (!Number.isInteger(last) || last < 1) throw new Error(`invalid --last ${flag(args, "--last")}`);
  let policy: Awaited<ReturnType<typeof readPolicyFile>> | undefined;
  try {
    policy = await readPolicyFile(flag(args, "--policy") ?? (await resolvePolicyPath()));
  } catch {
    /* no policy: costs are shown as token counts and estimates only */
  }
  const session = flag(args, "--session");
  console.log(formatWhy(records, { last, ...(session ? { session } : {}) }, policy));
  if (skipped > 0) console.log(`(${skipped} malformed log lines skipped)`);
}

const STDIN_WAIT_MS = 200;

/** Whatever arrives on stdin within a short wait; a TTY or a silent pipe yields "". */
async function readStdinBriefly(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  const read = (async () => {
    for await (const c of process.stdin) chunks.push(c as Buffer);
  })();
  await Promise.race([read, new Promise((r) => setTimeout(r, STDIN_WAIT_MS).unref())]);
  return Buffer.concat(chunks).toString("utf8");
}

async function statusline(args: readonly string[]): Promise<void> {
  const port = flag(args, "--port") ?? process.env.JEV_ROUTER_PORT ?? "4141";
  const url = flag(args, "--url") ?? `http://127.0.0.1:${port}`;
  const token = process.env.JEV_ROUTER_TOKEN;
  const line = await statusLine({ url, stdin: await readStdinBriefly(), ...(token ? { token } : {}) });
  if (line) console.log(line);
  process.stdin.destroy();
}

async function version(): Promise<void> {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; version: string };
  console.log(`${pkg.name} ${pkg.version}`);
}

export async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  applyEnv(process.env, await loadEnvFile(envFilePath(process.env)));
  if (command === "--version" || command === "-v" || command === "version") return version();
  if (command === "init") return init(rest);
  if (command === "ping") return ping();
  if (command === "up") return up(rest);
  if (command === "setup") return setup(rest);
  if (command === "service") return service(rest);
  if (command === "expose") return expose(rest);
  if (command === "hook") return hook(rest);
  if (command === "stats") return stats(rest);
  if (command === "replay") return replayCmd(rest);
  if (command === "policy") return policy();
  if (command === "why") return why(rest);
  if (command === "statusline") return statusline(rest);
  console.log(USAGE);
  if (command && command !== "help") process.exitCode = 1;
}
