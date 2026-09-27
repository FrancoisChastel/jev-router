import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** core and judge must stay free of Node-only imports so they run on edge runtimes. */
describe("edge-safe bundles", () => {
  test("core and judge bundle without any node: import", async () => {
    const out = await mkdtemp(join(tmpdir(), "jev-router-edge-"));
    const proc = Bun.spawnSync(["bun", "build", "src/core/index.ts", "src/judge/index.ts", "--target", "browser", "--outdir", out], {
      cwd: process.cwd(),
    });
    expect(proc.exitCode).toBe(0);
    const files = (await readdir(out, { recursive: true })).filter((f) => String(f).endsWith(".js"));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      const text = await readFile(join(out, String(f)), "utf8");
      expect(text).not.toMatch(/from\s*["']node:/);
      expect(text).not.toMatch(/require\(["']node:/);
    }
  });
});
