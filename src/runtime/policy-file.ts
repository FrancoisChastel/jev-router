import { readFile } from "node:fs/promises";
import { loadPolicy, PolicyError } from "../core/policy";
import type { Policy } from "../core/policy/types";

interface YamlModule {
  parse(text: string): unknown;
}

async function loadYamlParser(): Promise<YamlModule> {
  const bun = (globalThis as { Bun?: { YAML?: YamlModule } }).Bun;
  if (bun?.YAML) return bun.YAML;
  const specifier = "yaml";
  try {
    return (await import(specifier)) as YamlModule;
  } catch {
    throw new PolicyError("YAML policies need Bun or the optional 'yaml' package; use policy.json instead");
  }
}

async function parseYaml(text: string, path: string): Promise<unknown> {
  const parser = await loadYamlParser();
  try {
    return parser.parse(text);
  } catch (e) {
    throw new PolicyError(`YAML syntax error in ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Read and validate a policy file. JSON always works; YAML works under Bun or with the 'yaml' package installed. */
export async function readPolicyFile(path: string): Promise<Policy> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw new PolicyError(`policy file not readable at ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let raw: unknown;
  if (/\.ya?ml$/i.test(path)) {
    raw = await parseYaml(text, path);
  } else {
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new PolicyError(`JSON syntax error in ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return loadPolicy(raw);
}
