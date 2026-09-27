#!/usr/bin/env node
import { startDaemon } from "../daemon/server";
import { createJudge } from "../runtime/judge-factory";
import { JsonlLogger } from "../runtime/log";
import { decisionsLogPath, resolvePolicyPath } from "../runtime/paths";
import { readPolicyFile } from "../runtime/policy-file";

const USAGE = `jev-router <command>

  up [--host 127.0.0.1] [--port 4141]   start the local relay and decision service
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

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "up") return up(rest);
  if (command === "policy") return policy();
  console.log(USAGE);
  if (command && command !== "help") process.exitCode = 1;
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(`jev-router: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
