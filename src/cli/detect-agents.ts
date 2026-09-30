import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { Agent } from "./setup";

export interface AgentProbe {
  readonly home: string;
  readonly exists: (path: string) => Promise<boolean>;
  readonly onPath: (binary: string) => Promise<boolean>;
}

const fsExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** Whether an executable of this name sits in any $PATH entry. */
export async function executableOnPath(binary: string, pathVar = process.env.PATH ?? ""): Promise<boolean> {
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    try {
      await access(join(dir, binary), constants.X_OK);
      return true;
    } catch {
      /* next entry */
    }
  }
  return false;
}

export const defaultProbe = (home: string): AgentProbe => ({ home, exists: fsExists, onPath: executableOnPath });

/** Harnesses installed on this machine, judged by their config directory or their binary on $PATH. */
export async function detectAgents(probe: AgentProbe): Promise<Agent[]> {
  const checks: readonly (readonly [Agent, readonly string[], readonly string[]])[] = [
    ["claude-code", [join(probe.home, ".claude")], ["claude"]],
    ["codex", [join(probe.home, ".codex")], ["codex"]],
    ["opencode", [join(probe.home, ".config", "opencode")], ["opencode"]],
    ["pi", [join(probe.home, ".pi")], ["pi"]],
    ["cursor", [join(probe.home, ".cursor")], ["cursor", "cursor-agent"]],
    ["gemini", [join(probe.home, ".gemini")], ["gemini"]],
  ];
  const found: Agent[] = [];
  for (const [agent, dirs, binaries] of checks) {
    let present = false;
    for (const d of dirs) if (!present && (await probe.exists(d))) present = true;
    for (const b of binaries) if (!present && (await probe.onPath(b))) present = true;
    if (present) found.push(agent);
  }
  return found;
}
