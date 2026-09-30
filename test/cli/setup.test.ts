import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardHook } from "../../src/cli/main";
import { runSetup } from "../../src/cli/setup";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("runSetup", () => {
  test("dry run writes nothing; a real run writes files and backs up on the second pass", async () => {
    const home = await mkdtemp(join(tmpdir(), "jev-home-"));
    const routerHome = await mkdtemp(join(tmpdir(), "jev-router-home-"));
    const previous = process.env.JEV_ROUTER_HOME;
    process.env.JEV_ROUTER_HOME = routerHome;
    try {
      const lines: string[] = [];
      const base = {
        agents: ["claude-code", "codex", "opencode"] as const,
        baseUrl: "http://127.0.0.1:4141",
        hookCommand: "/bin/jev-router",
        home,
        log: (l: string) => lines.push(l),
      };

      await runSetup({ ...base, dryRun: true });
      expect(await exists(join(home, ".claude", "settings.json"))).toBe(false);
      expect(lines.some((l) => l.includes("would write"))).toBe(true);

      await runSetup({ ...base, dryRun: false });
      const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")) as { env: Record<string, string> };
      expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4141");
      expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toContain("[model_providers.jev-router]");
      expect(await exists(join(home, ".codex", "hooks.json"))).toBe(true);

      await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ env: { FOO: "bar" } }));
      await runSetup({ ...base, dryRun: false, token: "t0k" });
      expect(await exists(join(home, ".claude", "settings.json.bak"))).toBe(true);
      const merged = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")) as { env: Record<string, string> };
      expect(merged.env.FOO).toBe("bar");
      expect(merged.env.ANTHROPIC_AUTH_TOKEN).toBe("t0k");
    } finally {
      if (previous === undefined) delete process.env.JEV_ROUTER_HOME;
      else process.env.JEV_ROUTER_HOME = previous;
    }
  });
});

describe("runSetup for Cursor", () => {
  test("prints the tunnel, key, and model steps and writes nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "jev-home-"));
    const routerHome = await mkdtemp(join(tmpdir(), "jev-router-home-"));
    const previous = process.env.JEV_ROUTER_HOME;
    process.env.JEV_ROUTER_HOME = routerHome;
    try {
      const lines: string[] = [];
      await runSetup({
        agents: ["cursor"],
        baseUrl: "http://127.0.0.1:5000",
        hookCommand: "/bin/jev-router",
        home,
        dryRun: false,
        log: (l) => lines.push(l),
      });
      const text = lines.join("\n");
      expect(text).toContain("cursor:");
      expect(text).toContain("jev-router up --port 5001 --token");
      expect(text).toContain("jev-router expose --port 5001");
      expect(text).toContain("jev-router/auto");
      expect(await exists(join(home, ".cursor"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.JEV_ROUTER_HOME;
      else process.env.JEV_ROUTER_HOME = previous;
    }
  });
});

describe("forwardHook", () => {
  test("posts the payload with the token and always returns an empty hook result", async () => {
    let seen: { url: string; auth: string | null; body: string } | undefined;
    const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(url), auth: new Headers(init?.headers).get("authorization"), body: String(init?.body) };
      return new Response("{}", { status: 200 });
    };
    expect(await forwardHook("codex", '{"a":1}', { port: "9", token: "tok", fetch: fetchImpl })).toBe("{}");
    expect(seen).toEqual({ url: "http://127.0.0.1:9/hooks/codex", auth: "Bearer tok", body: '{"a":1}' });
    const warnings: string[] = [];
    const down = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await forwardHook("claude-code", "", { port: "9", fetch: down, warn: (m) => warnings.push(m) })).toBe("{}");
    expect(warnings).toHaveLength(1);
  });
});
