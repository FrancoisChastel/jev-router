import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir, type Env } from "./paths";

/**
 * A small KEY=value file under the config dir holds the judge key for the background relay, since a service has no
 * shell to export from. Written by `setup` with mode 0600; read by every command, filling in only what the process
 * environment lacks.
 */
export function envFilePath(env: Env = process.env): string {
  return join(configDir(env), "env");
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (KEY.test(key)) out[key] = value;
  }
  return out;
}

export function formatEnvFile(vars: Readonly<Record<string, string>>): string {
  return `${Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
}

export async function loadEnvFile(path: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

/** Copy file values into the environment where it has nothing; returns the names that were filled in. */
export function applyEnv(env: Record<string, string | undefined>, vars: Readonly<Record<string, string>>): string[] {
  const applied: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if (env[k] === undefined || env[k] === "") {
      env[k] = v;
      applied.push(k);
    }
  }
  return applied;
}
