import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { loadPolicy } from "../core/policy";
import type { JudgeTransport, Policy } from "../core/policy/types";
import type { FetchLike } from "../judge/http";
import {
  buildDefaultPolicy,
  describeSubscriptions,
  detectKeys,
  type EgressName,
  geminiLadder,
  type KeyDetection,
  parseOpenRouterCatalog,
} from "./defaults";
import type { Env } from "./paths";
import { detectSubscriptions, type SubscriptionDetection } from "./subscriptions";

export interface InitOptions {
  readonly path: string;
  readonly env?: Env;
  readonly force?: boolean;
  readonly judge?: JudgeTransport;
  readonly egress?: EgressName;
  /** Fetch used for the live catalog. Pass undefined to skip the network. */
  readonly fetch?: FetchLike | null;
  /** Home directory scanned for harness logins; defaults to the user's. */
  readonly home?: string;
  /** Subscriptions to build from, or `false` to ignore harness logins. Detected from `home` when omitted. */
  readonly subscriptions?: SubscriptionDetection | false;
  readonly readFile?: (path: string) => Promise<string>;
  readonly log?: (line: string) => void;
}

export interface InitResult {
  readonly path: string;
  readonly written: boolean;
  readonly detection: KeyDetection;
  readonly subscriptions?: SubscriptionDetection;
  readonly pricesFrom: "live catalog" | "built-in table";
  readonly policy: Policy;
}

const CATALOG_URL = "https://openrouter.ai/api/v1/models";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a ready-to-use policy from the keys in the environment. Idempotent: an existing file is left alone unless
 * `force` is set. Never writes secrets, only the names of the environment variables that hold them.
 */
export async function initPolicy(opts: InitOptions): Promise<InitResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => undefined);
  const detection = detectKeys(env, { ...(opts.judge ? { judge: opts.judge } : {}), ...(opts.egress ? { egress: opts.egress } : {}) });
  const subscriptions =
    opts.subscriptions === false
      ? undefined
      : (opts.subscriptions ??
        (await detectSubscriptions({ home: opts.home ?? homedir(), ...(opts.readFile ? { readFile: opts.readFile } : {}) })));

  let catalog: ReturnType<typeof parseOpenRouterCatalog> | undefined;
  const fetchImpl = opts.fetch === null ? undefined : (opts.fetch ?? fetch);
  if (fetchImpl) {
    try {
      const res = await fetchImpl(CATALOG_URL, { signal: AbortSignal.timeout(4000) });
      if (res.ok) catalog = parseOpenRouterCatalog(await res.json());
    } catch {
      /* offline: curated prices are used */
    }
  }
  const build = { detection, ...(catalog && catalog.size > 0 ? { catalog } : {}), ...(subscriptions ? { subscriptions } : {}) };
  const policy = loadPolicy(buildDefaultPolicy(build));
  const pricesFrom: InitResult["pricesFrom"] = catalog && catalog.size > 0 ? "live catalog" : "built-in table";
  const result = { path: opts.path, detection, ...(subscriptions ? { subscriptions } : {}), pricesFrom, policy };

  if ((await exists(opts.path)) && !opts.force) {
    log(`policy: keeping existing ${opts.path} (use --force to regenerate)`);
    return { ...result, written: false };
  }
  await mkdir(dirname(opts.path), { recursive: true });
  await writeFile(opts.path, `${JSON.stringify(buildDefaultPolicy(build), null, 2)}\n`);
  log(`policy: wrote ${opts.path}`);
  return { ...result, written: true };
}

export function describeDetection(d: KeyDetection, subs?: SubscriptionDetection): string[] {
  const lines: string[] = [];
  lines.push(d.found.length > 0 ? `keys    ${d.found.join(", ")}` : "keys    none found");
  lines.push(
    `judge   ${d.judge === "mock" ? "none (deterministic only): set OPENROUTER_API_KEY, AI_GATEWAY_API_KEY, or TYPESAFE_API_KEY" : `jev via ${d.judge} ($${d.judgeKeyEnv})`}`,
  );
  lines.push(
    d.egress
      ? `egress  ${d.egress}`
      : subs?.anthropic || subs?.chatgpt || subs?.gemini || d.gemini
        ? "egress  no gateway key: harnesses without a subscription route below have nowhere to send traffic"
        : "egress  none: the relay needs OPENROUTER_API_KEY or AI_GATEWAY_API_KEY; the Pi extension works without one",
  );
  lines.push(...describeSubscriptions(subs));
  if (d.gemini && !subs?.gemini) lines.push(`gemini  GEMINI_API_KEY: Gemini CLI routes ${geminiLadder("api-key")} on the Gemini API`);
  return lines;
}
