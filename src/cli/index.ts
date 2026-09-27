#!/usr/bin/env node
import { startDaemon } from "../daemon/server";
import { createJudge } from "../runtime/judge-factory";
import { JsonlLogger } from "../runtime/log";
import { decisionsLogPath, resolvePolicyPath } from "../runtime/paths";
import { readPolicyFile } from "../runtime/policy-file";
import { AGENTS, type Agent, runSetup } from "./setup";

const USAGE = `jev-router <command>

  up [--host 127.0.0.1] [--port 4141]   start the local relay and decision service
  setup [--agent <name>]... [--dry-run] [--port 4141]
                                        point installed harnesses at the relay and install their hook packs
                                        agents: claude-code, codex, opencode, pi (default: all)
  hook <claude-code|codex>              forward a native hook payload from stdin to the relay (used by hook packs)
  policy                                validate the policy file and print where it was read from
  help

Environment: JEV_ROUTER_HOME, JEV_ROUTER_POLICY, JEV_ROUTER_LOG, and the judge key named by the policy.
`;

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function up(args: readonly string[]): Promise<void> {
  const policyPath = await resolvePolicyPath();
  const policy = await readPolicyFile(policyPath);
  const judge = createJudge(policy.judge);
  const logger = new JsonlLogger(decisionsLogPath());
  const host = flag(args, "--host") ?? "127.0.0.1";
  const port = Number(flag(args, "--port") ?? 4141);
  const daemon = await startDaemon({ policy, ...(judge ? { judge } : {}), log: (r) => logger.write(r), host, port });
  console.error(`jev-router listening on ${daemon.url}`);
  console.error(`  policy  ${policyPath}`);
  console.error(`  judge   ${policy.judge.transport}${judge ? "" : " (none: deterministic only)"}`);
  console.error(`  routes  ${policy.routes.map((r) => r.id).join(", ") || "(none)"}`);
  console.error(`  log     ${decisionsLogPath()}`);
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
  const examplePolicy = new URL("../../examples/policy.json", import.meta.url).pathname;
  await runSetup({
    agents,
    baseUrl: `http://127.0.0.1:${port}`,
    hookCommand: process.argv[1] ? `${process.execPath} ${process.argv[1]}` : "jev-router",
    dryRun: args.includes("--dry-run"),
    examplePolicyPath: examplePolicy,
    log: (line) => console.log(line),
  });
}

/** Forward a native hook payload to the relay. Never fails the harness: errors go to stderr and the exit code stays 0. */
async function hook(args: readonly string[]): Promise<void> {
  const harness = args[0];
  if (harness !== "claude-code" && harness !== "codex") throw new Error("hook needs a harness: claude-code or codex");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const port = process.env.JEV_ROUTER_PORT ?? "4141";
  try {
    await fetch(`http://127.0.0.1:${port}/hooks/${harness}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.concat(chunks).toString("utf8") || "{}",
      signal: AbortSignal.timeout(2000),
    });
  } catch (e) {
    console.error(`jev-router hook: relay unreachable (${e instanceof Error ? e.message : String(e)})`);
  }
  console.log("{}");
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "up") return up(rest);
  if (command === "setup") return setup(rest);
  if (command === "hook") return hook(rest);
  if (command === "policy") return policy();
  console.log(USAGE);
  if (command && command !== "help") process.exitCode = 1;
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`jev-router: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
