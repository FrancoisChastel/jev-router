import type { FetchLike } from "../judge/http";

/**
 * Pure parts of `jev-router expose`: which tunnel to run, how to read its public URL, whether the relay is safe to
 * publish, and what to paste into Cursor. Spawning the tunnel lives in main.ts.
 *
 * Cursor sends custom-model requests from its own servers, so they can only reach a relay through a public URL. The
 * relay injects real provider keys; a public URL on a relay without a token would be an open proxy on your bill.
 */

export type TunnelKind = "cloudflared" | "ngrok";

export interface TunnelCommand {
  readonly kind: TunnelKind;
  readonly command: string;
  readonly args: readonly string[];
}

/** Model id to add in Cursor. `auto` alone risks clashing with Cursor's built-in Auto; any `<prefix>/auto` routes as `auto`. */
export const CURSOR_MODEL = "jev-router/auto";

export interface ExposeOptions {
  readonly port: number;
  readonly token: string;
  readonly tunnel?: TunnelKind;
}

const flagValue = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Parse `expose` flags. A token is mandatory: it is the only thing between the public URL and your provider keys. */
export function parseExposeOptions(args: readonly string[], env: Readonly<Record<string, string | undefined>>): ExposeOptions {
  const port = Number(flagValue(args, "--port") ?? 4141);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid --port ${flagValue(args, "--port")}`);
  const token = flagValue(args, "--token") ?? env.JEV_ROUTER_TOKEN;
  if (!token)
    throw new Error(
      "expose needs the relay's token (--token or JEV_ROUTER_TOKEN): a public URL on a relay without one would let anyone spend your provider keys",
    );
  const tunnel = flagValue(args, "--tunnel");
  if (tunnel !== undefined && tunnel !== "cloudflared" && tunnel !== "ngrok")
    throw new Error(`unknown --tunnel ${tunnel}; expected cloudflared or ngrok`);
  return { port, token, ...(tunnel ? { tunnel } : {}) };
}

/** cloudflared first (no account, no browser interstitial), then ngrok. Undefined when neither is installed. */
export async function pickTunnel(
  port: number,
  onPath: (binary: string) => Promise<boolean>,
  prefer?: TunnelKind,
): Promise<TunnelCommand | undefined> {
  const order: readonly TunnelKind[] = prefer ? [prefer] : ["cloudflared", "ngrok"];
  for (const kind of order) if (await onPath(kind)) return tunnelCommand(kind, port);
  return undefined;
}

export function tunnelCommand(kind: TunnelKind, port: number): TunnelCommand {
  if (kind === "cloudflared")
    return { kind, command: "cloudflared", args: ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`] };
  return { kind, command: "ngrok", args: ["http", String(port), "--log", "stdout", "--log-format", "json"] };
}

export const TUNNEL_INSTALL_HINTS: readonly string[] = [
  "no tunnel found: install one of",
  "  cloudflared  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/  (brew install cloudflared)",
  "  ngrok        https://ngrok.com/download  (then `ngrok config add-authtoken <token>`)",
];

const TRYCLOUDFLARE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;
const NGROK_JSON_URL = /"url"\s*:\s*"(https:\/\/[^"\s]+)"/;
const NGROK_LOGFMT_URL = /(?:^|\s)url=(https:\/\/\S+)/;

/**
 * The public URL in a chunk of tunnel output, or undefined. cloudflared prints its quick-tunnel URL in a banner on
 * stderr; ngrok logs a `started tunnel` line with `url=` (logfmt) or `"url":` (json). Only https URLs count.
 */
export function parseTunnelUrl(kind: TunnelKind, text: string): string | undefined {
  if (kind === "cloudflared") return TRYCLOUDFLARE.exec(text)?.[0];
  for (const line of text.split("\n")) {
    if (!line.includes("started tunnel")) continue;
    const m = NGROK_JSON_URL.exec(line) ?? NGROK_LOGFMT_URL.exec(line);
    if (m?.[1]) return m[1].replace(/\/+$/, "");
  }
  return undefined;
}

export type RelayAuth = "down" | "open" | "token-rejected" | "guarded";

/**
 * Whether the relay behind `baseUrl` is safe to publish: it answers, turns away a request without the token, and
 * accepts one with it. Anything short of `guarded` must stop `expose`.
 */
export async function probeRelayAuth(fetchImpl: FetchLike, baseUrl: string, token: string): Promise<RelayAuth> {
  const get = async (path: string, headers: Record<string, string> = {}): Promise<number | undefined> => {
    try {
      const r = await fetchImpl(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(2000) });
      await r.body?.cancel();
      return r.status;
    } catch {
      return undefined;
    }
  };
  if ((await get("/healthz")) !== 200) return "down";
  if ((await get("/v1/models")) !== 401) return "open";
  if ((await get("/v1/models", { authorization: `Bearer ${token}` })) !== 200) return "token-rejected";
  return "guarded";
}

export function refusal(state: Exclude<RelayAuth, "guarded">, port: number): string {
  if (state === "down")
    return `no relay answering on http://127.0.0.1:${port}; start one with a token first: jev-router up --port ${port} --token "$JEV_ROUTER_TOKEN"`;
  if (state === "open")
    return `refusing to expose http://127.0.0.1:${port}: it answers without a token, so a public URL would let anyone spend your provider keys. Run a relay with --token (for example on another port: jev-router up --port 4142 --token "$JEV_ROUTER_TOKEN") and expose that`;
  return `the relay on http://127.0.0.1:${port} rejects this token; pass the token it was started with (--token or JEV_ROUTER_TOKEN)`;
}

/** What to paste into Cursor once the tunnel is up. The token is printed because Cursor needs it as the API key. */
export function cursorPasteValues(publicUrl: string, token: string): readonly string[] {
  return [
    `public URL  ${publicUrl}   (treat it as a secret; it changes every time the tunnel restarts)`,
    "",
    "In Cursor: Settings > Models",
    `  OpenAI API Key             ${token}`,
    `  Override OpenAI Base URL   ${publicUrl}/v1   (turn the override on)`,
    `  Add custom model           ${CURSOR_MODEL}   (then pick it in Chat or Agent)`,
    "",
    "Tab completion and Cursor's own models do not go through the relay. Ctrl-C stops the tunnel.",
  ];
}

/** Steps `setup --agent cursor` prints: Cursor's settings live in its app, and its requests come from its servers. */
export function cursorSetupSteps(port: number): readonly string[] {
  const exposed = port + 1;
  return [
    "  Cursor is not configured automatically: its custom-model requests come from Cursor's servers, not this machine,",
    "  and its model settings live inside the app. Three steps:",
    `  1. a relay with a token, on its own port:  export JEV_ROUTER_TOKEN=$(openssl rand -hex 24); jev-router up --port ${exposed} --token "$JEV_ROUTER_TOKEN"`,
    `  2. a public URL for it:                    jev-router expose --port ${exposed}   (same JEV_ROUTER_TOKEN; needs cloudflared or ngrok)`,
    `  3. in Cursor Settings > Models: the API key and base URL that expose prints, the override on, custom model ${CURSOR_MODEL}`,
    "  Only Chat and Agent requests on that model are routed; Tab completion always uses Cursor's own models.",
  ];
}
