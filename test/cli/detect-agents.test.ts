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
  test("Cursor counts by ~/.cursor or either of its binaries", async () => {
    const none = async () => false;
    expect(await detectAgents({ home: "/h", exists: async (p) => p === "/h/.cursor", onPath: none })).toEqual(["cursor"]);
    expect(await detectAgents({ home: "/h", exists: none, onPath: async (b) => b === "cursor-agent" })).toEqual(["cursor"]);
    expect(await detectAgents({ home: "/h", exists: none, onPath: async (b) => b === "cursor" })).toEqual(["cursor"]);
  });
  test("executableOnPath scans PATH entries", async () => {
    expect(await executableOnPath("sh", "/nope:/bin:/usr/bin")).toBe(true);
    expect(await executableOnPath("definitely-not-a-binary-xyz", "/bin")).toBe(false);
  });
});
