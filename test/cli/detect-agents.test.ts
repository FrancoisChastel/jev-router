import { describe, expect, test } from "bun:test";
import { detectAgents, executableOnPath } from "../../src/cli/detect-agents";

describe("installed harness detection", () => {
  test("a config directory or a binary on PATH counts; nothing else does", async () => {
    const dirs = new Set(["/h/.claude", "/h/.config/opencode"]);
    const bins = new Set(["pi"]);
    const found = await detectAgents({ home: "/h", exists: async (p) => dirs.has(p), onPath: async (b) => bins.has(b) });
    expect(found).toEqual(["claude-code", "opencode", "pi"]);
    expect(await detectAgents({ home: "/h", exists: async () => false, onPath: async () => false })).toEqual([]);
  });
  test("executableOnPath scans PATH entries", async () => {
    expect(await executableOnPath("sh", "/nope:/bin:/usr/bin")).toBe(true);
    expect(await executableOnPath("definitely-not-a-binary-xyz", "/bin")).toBe(false);
  });
});
