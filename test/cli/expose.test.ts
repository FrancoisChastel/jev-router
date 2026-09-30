import { describe, expect, test } from "bun:test";
import {
  CURSOR_MODEL,
  cursorPasteValues,
  cursorSetupSteps,
  parseExposeOptions,
  parseTunnelUrl,
  pickTunnel,
  probeRelayAuth,
  refusal,
  tunnelCommand,
} from "../../src/cli/expose";
import { loadPolicy } from "../../src/core/policy";
import { startDaemon } from "../../src/daemon";
import { minimalPolicy } from "../fixtures/policies";

// Captured from cloudflared 2026.5.0 on a quick tunnel (subdomain replaced).
const CLOUDFLARED_OUTPUT = `2026-09-30T02:32:18Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms. If you intend to use Tunnels in production you should use a pre-created named tunnel by following: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps
2026-09-30T02:32:18Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-09-30T02:32:21Z INF +--------------------------------------------------------------------------------------------+
2026-09-30T02:32:21Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-09-30T02:32:21Z INF |  https://example-words-for-tests.trycloudflare.com                                        |
2026-09-30T02:32:21Z INF +--------------------------------------------------------------------------------------------+
2026-09-30T02:32:21Z INF Settings: map[ha-connections:1 no-autoupdate:true protocol:quic url:http://127.0.0.1:4142]
`;

const NGROK_JSON = [
  '{"lvl":"info","msg":"no configuration paths supplied","t":"2026-09-30T02:40:00Z"}',
  '{"addr":"http://localhost:4142","lvl":"info","msg":"started tunnel","name":"command_line","obj":"tunnels","t":"2026-09-30T02:40:01Z","url":"https://ab12-203-0-113-7.ngrok-free.app"}',
].join("\n");

const NGROK_LOGFMT = [
  't=2026-09-30T02:40:00+0000 lvl=info msg="starting web service" obj=web addr=127.0.0.1:4040',
  't=2026-09-30T02:40:01+0000 lvl=info msg="started tunnel" obj=tunnels name=command_line addr=http://localhost:4142 url=https://ab12.ngrok-free.app',
].join("\n");

describe("tunnel output parsing", () => {
  test("cloudflared: the trycloudflare URL from the banner, not the terms or docs links", () => {
    expect(parseTunnelUrl("cloudflared", CLOUDFLARED_OUTPUT)).toBe("https://example-words-for-tests.trycloudflare.com");
    const beforeBanner = CLOUDFLARED_OUTPUT.split("\n").slice(0, 2).join("\n");
    expect(parseTunnelUrl("cloudflared", beforeBanner)).toBeUndefined();
  });

  test("ngrok: the started-tunnel URL in json or logfmt, never the local addr", () => {
    expect(parseTunnelUrl("ngrok", NGROK_JSON)).toBe("https://ab12-203-0-113-7.ngrok-free.app");
    expect(parseTunnelUrl("ngrok", NGROK_LOGFMT)).toBe("https://ab12.ngrok-free.app");
    expect(parseTunnelUrl("ngrok", NGROK_JSON.split("\n")[0] ?? "")).toBeUndefined();
    expect(parseTunnelUrl("ngrok", 'lvl=info msg="started tunnel" url=http://insecure.example')).toBeUndefined();
  });
});

describe("tunnel choice", () => {
  test("cloudflared first, then ngrok, else nothing; an explicit choice is honoured", async () => {
    const has = (bins: string[]) => async (b: string) => bins.includes(b);
    expect((await pickTunnel(4142, has(["cloudflared", "ngrok"])))?.kind).toBe("cloudflared");
    expect((await pickTunnel(4142, has(["ngrok"])))?.kind).toBe("ngrok");
    expect(await pickTunnel(4142, has([]))).toBeUndefined();
    expect((await pickTunnel(4142, has(["cloudflared", "ngrok"]), "ngrok"))?.kind).toBe("ngrok");
    expect(await pickTunnel(4142, has(["cloudflared"]), "ngrok")).toBeUndefined();
  });

  test("the tunnel always targets loopback on the relay port", () => {
    expect(tunnelCommand("cloudflared", 4142).args).toContain("http://127.0.0.1:4142");
    expect(tunnelCommand("ngrok", 4142).args.slice(0, 2)).toEqual(["http", "4142"]);
  });
});

describe("expose options", () => {
  test("a token is mandatory, from the flag or the environment", () => {
    expect(() => parseExposeOptions([], {})).toThrow(/token/);
    expect(parseExposeOptions([], { JEV_ROUTER_TOKEN: "env" })).toEqual({ port: 4141, token: "env" });
    expect(parseExposeOptions(["--port", "4142", "--token", "flag", "--tunnel", "ngrok"], { JEV_ROUTER_TOKEN: "env" })).toEqual({
      port: 4142,
      token: "flag",
      tunnel: "ngrok",
    });
  });

  test("rejects a bad port or tunnel", () => {
    expect(() => parseExposeOptions(["--port", "0", "--token", "t"], {})).toThrow(/port/);
    expect(() => parseExposeOptions(["--tunnel", "frp", "--token", "t"], {})).toThrow(/tunnel/);
  });
});

describe("refusing to expose an unguarded relay", () => {
  test("open, token-rejected, down, and guarded are told apart against real relays", async () => {
    const open = await startDaemon({ policy: loadPolicy(minimalPolicy()), port: 0 });
    const guarded = await startDaemon({ policy: loadPolicy(minimalPolicy()), port: 0, token: "s3cret" });
    try {
      expect(await probeRelayAuth(fetch, open.url, "s3cret")).toBe("open");
      expect(await probeRelayAuth(fetch, guarded.url, "s3cret")).toBe("guarded");
      expect(await probeRelayAuth(fetch, guarded.url, "wrong")).toBe("token-rejected");
    } finally {
      await open.close();
      await guarded.close();
    }
    expect(await probeRelayAuth(fetch, open.url, "s3cret")).toBe("down");
  });

  test("every refusal says why and what to run instead", () => {
    expect(refusal("open", 4141)).toMatch(/refusing.*without a token/);
    expect(refusal("down", 4142)).toContain("--token");
    expect(refusal("token-rejected", 4142)).toMatch(/rejects this token/);
  });
});

describe("what Cursor needs", () => {
  test("base URL under /v1, the relay token as the key, and a model that routes as auto", () => {
    const lines = cursorPasteValues("https://x.trycloudflare.com", "tok").join("\n");
    expect(lines).toContain("https://x.trycloudflare.com/v1");
    expect(lines).toMatch(/OpenAI API Key\s+tok/);
    expect(lines).toContain(CURSOR_MODEL);
    expect(CURSOR_MODEL.endsWith("/auto")).toBe(true);
  });

  test("setup steps use a separate token-guarded port and never claim Tab is routed", () => {
    const steps = cursorSetupSteps(4141).join("\n");
    expect(steps).toContain("jev-router up --port 4142 --token");
    expect(steps).toContain("jev-router expose --port 4142");
    expect(steps).toMatch(/Tab completion always uses Cursor's own models/);
  });
});
