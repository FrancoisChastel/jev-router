import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAgents } from "../../src/cli/detect-agents";
import { geminiEndpoint, planGeminiEnv, planGeminiSettings } from "../../src/cli/gemini-plans";
import { parseJsonc, stripJsonComments } from "../../src/cli/jsonc";
import { harnessAuth } from "../../src/cli/plans";
import { runSetup } from "../../src/cli/setup";
import { loadPolicy } from "../../src/core/policy";
import { buildDefaultPolicy, detectKeys } from "../../src/runtime/defaults";

const target = { baseUrl: "http://127.0.0.1:4141", hookCommand: "/usr/local/bin/jev-router" };
const login = { ...target, auth: { gemini: "subscription" as const } };

type Settings = {
  model: { name: string; maxSessionTurns?: number };
  security?: { auth: { selectedType: string } };
  hooks?: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]>;
  ui?: unknown;
};

describe("gemini settings plan", () => {
  test("with an API key: the relay model and an explicit api-key auth type, other settings kept, no hooks", () => {
    const out = planGeminiSettings(
      { ui: { theme: "GitHub" }, model: { name: "gemini-3.1-pro-preview", maxSessionTurns: 50 } },
      target,
    ) as Settings;
    expect(out.model).toEqual({ name: "jev-router/auto", maxSessionTurns: 50 });
    expect(out.security?.auth.selectedType).toBe("gemini-api-key");
    expect(out.ui).toEqual({ theme: "GitHub" });
    expect(out.hooks).toBeUndefined();
    // A chosen auth type is never overridden.
    const vertex = planGeminiSettings({ security: { auth: { selectedType: "vertex-ai" } } }, target) as Settings;
    expect(vertex.security?.auth.selectedType).toBe("vertex-ai");
  });

  test("with a Google login: hook commands for tool results and prompts, replacing only our own", () => {
    const existing = {
      security: { auth: { selectedType: "oauth-personal" } },
      hooks: {
        AfterTool: [
          { matcher: "write_file", hooks: [{ type: "command", command: "prettier --write" }] },
          { hooks: [{ type: "command", command: "/old/bin/jev-router hook gemini", timeout: 5000 }] },
        ],
      },
    };
    const out = planGeminiSettings(existing, login) as Settings;
    expect(out.security?.auth.selectedType).toBe("oauth-personal");
    expect(out.hooks?.AfterTool).toHaveLength(2);
    expect(out.hooks?.AfterTool?.[0]?.hooks[0]?.command).toBe("prettier --write");
    expect(out.hooks?.AfterTool?.[1]?.hooks[0]).toEqual({
      type: "command",
      command: "/usr/local/bin/jev-router hook gemini",
      timeout: 5000,
    });
    expect(Object.keys(out.hooks ?? {}).sort()).toEqual(["AfterTool", "BeforeAgent"]);
    expect(existing.hooks.AfterTool).toHaveLength(2);
  });

  test("the .env block points at the right mount, is refreshed in place, and keeps the user's own lines", () => {
    expect(geminiEndpoint(target)).toEqual({ name: "GOOGLE_GEMINI_BASE_URL", value: "http://127.0.0.1:4141/gemini" });
    expect(geminiEndpoint(login)).toEqual({ name: "CODE_ASSIST_ENDPOINT", value: "http://127.0.0.1:4141/code-assist" });
    const first = planGeminiEnv("GEMINI_API_KEY=abc\n", target);
    expect(first).toBe(
      "GEMINI_API_KEY=abc\n\n# >>> jev-router >>>\nGOOGLE_GEMINI_BASE_URL=http://127.0.0.1:4141/gemini\n# <<< jev-router <<<\n",
    );
    const switched = planGeminiEnv(first, login);
    expect(switched).toContain("CODE_ASSIST_ENDPOINT=http://127.0.0.1:4141/code-assist");
    expect(switched).not.toContain("GOOGLE_GEMINI_BASE_URL");
    expect(switched.startsWith("GEMINI_API_KEY=abc\n")).toBe(true);
    expect(planGeminiEnv(switched, login)).toBe(switched);
    expect(planGeminiEnv("", target).startsWith("# >>> jev-router >>>")).toBe(true);
  });

  test("harnessAuth reads the gemini route: a Google login forwards, an API key does not", () => {
    const key = loadPolicy(buildDefaultPolicy({ detection: detectKeys({ GEMINI_API_KEY: "k" }) }));
    expect(harnessAuth(key, "gemini")).toBe("token");
    const google = loadPolicy(buildDefaultPolicy({ detection: detectKeys({}), subscriptions: { gemini: { authType: "oauth-personal" } } }));
    expect(harnessAuth(google, "gemini")).toBe("subscription");
  });
});

describe("settings.json with comments", () => {
  test("comments and trailing commas go, strings that look like them stay", () => {
    const text = `{
      // Login with Google
      "security": { "auth": { "selectedType": "oauth-personal" } }, /* block */
      "url": "http://example.com/a//b",
      "odd": "a,}",
      "list": [1, 2,],
    }`;
    expect(parseJsonc(text)).toEqual({
      security: { auth: { selectedType: "oauth-personal" } },
      url: "http://example.com/a//b",
      odd: "a,}",
      list: [1, 2],
    });
    expect(stripJsonComments('{"a": "\\"//"}')).toBe('{"a": "\\"//"}');
  });
});

describe("gemini detection and setup", () => {
  test("~/.gemini or a gemini binary counts as installed", async () => {
    expect(await detectAgents({ home: "/h", exists: async (p) => p === "/h/.gemini", onPath: async () => false })).toEqual(["gemini"]);
    expect(await detectAgents({ home: "/h", exists: async () => false, onPath: async (b) => b === "gemini" })).toEqual(["gemini"]);
  });

  test("setup --agent gemini: dry run writes nothing; a run writes settings and .env with backups", async () => {
    const home = await mkdtemp(join(tmpdir(), "jev-gemini-home-"));
    const routerHome = await mkdtemp(join(tmpdir(), "jev-router-home-"));
    const previous = process.env.JEV_ROUTER_HOME;
    process.env.JEV_ROUTER_HOME = routerHome;
    try {
      const lines: string[] = [];
      const base = {
        agents: ["gemini"] as const,
        baseUrl: "http://127.0.0.1:4141",
        hookCommand: "/bin/jev-router",
        home,
        log: (l: string) => lines.push(l),
      };
      await runSetup({ ...base, dryRun: true });
      await expect(stat(join(home, ".gemini", "settings.json"))).rejects.toThrow();
      expect(lines.some((l) => l.includes("would write") && l.includes(".gemini/settings.json"))).toBe(true);

      await runSetup({ ...base, dryRun: false });
      const settings = JSON.parse(await readFile(join(home, ".gemini", "settings.json"), "utf8")) as Settings;
      expect(settings.model.name).toBe("jev-router/auto");
      expect(await readFile(join(home, ".gemini", ".env"), "utf8")).toContain("GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:4141/gemini");
      expect(lines.some((l) => l.includes("export GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:4141/gemini"))).toBe(true);

      await writeFile(join(home, ".gemini", "settings.json"), '{\n  // mine\n  "ui": { "theme": "Dracula" },\n}\n');
      await runSetup({ ...base, dryRun: false, auth: { gemini: "subscription" } });
      expect(lines.some((l) => l.includes("has comments"))).toBe(true);
      expect(await readFile(join(home, ".gemini", "settings.json.bak"), "utf8")).toContain("// mine");
      expect((await stat(join(home, ".gemini", "settings.json.bak"))).isFile()).toBe(true);
      const again = JSON.parse(await readFile(join(home, ".gemini", "settings.json"), "utf8")) as Settings;
      expect(again.ui).toEqual({ theme: "Dracula" });
      expect(again.hooks?.AfterTool?.[0]?.hooks[0]?.command).toBe("/bin/jev-router hook gemini");
      expect(await readFile(join(home, ".gemini", ".env"), "utf8")).toContain("CODE_ASSIST_ENDPOINT=http://127.0.0.1:4141/code-assist");
    } finally {
      if (previous === undefined) delete process.env.JEV_ROUTER_HOME;
      else process.env.JEV_ROUTER_HOME = previous;
    }
  });
});
