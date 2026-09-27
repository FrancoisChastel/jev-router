import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

/** Root for policy and logs: $JEV_ROUTER_HOME, else ~/.jev-router. */
export function configDir(env: Env = process.env): string {
  return env.JEV_ROUTER_HOME ?? join(homedir(), ".jev-router");
}

export function decisionsLogPath(env: Env = process.env): string {
  return env.JEV_ROUTER_LOG ?? join(configDir(env), "decisions.jsonl");
}

const CANDIDATES = ["policy.json", "policy.yaml", "policy.yml"] as const;

/** $JEV_ROUTER_POLICY, else the first of policy.json / policy.yaml / policy.yml under the config dir. */
export async function resolvePolicyPath(env: Env = process.env): Promise<string> {
  if (env.JEV_ROUTER_POLICY) return env.JEV_ROUTER_POLICY;
  const dir = configDir(env);
  for (const name of CANDIDATES) {
    const path = join(dir, name);
    try {
      await access(path);
      return path;
    } catch {
      /* try next */
    }
  }
  return join(dir, CANDIDATES[0]);
}
