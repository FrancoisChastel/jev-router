import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlLogger } from "../../src/runtime/log";

describe("jsonl logger", () => {
  test("writes records in order and flush waits for them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-router-log-"));
    const path = join(dir, "nested", "decisions.jsonl");
    const logger = new JsonlLogger(path);
    for (let i = 0; i < 20; i += 1) logger.write({ i });
    await logger.flush();
    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { i: number });
    expect(lines.map((l) => l.i)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(logger.failures).toBe(0);
  });

  test("counts failures, reports the first, and keeps trying", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-router-log-"));
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    const logger = new JsonlLogger(join(blocker, "decisions.jsonl"));
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      logger.write({ a: 1 });
      logger.write({ a: 2 });
      await logger.flush();
    } finally {
      console.error = original;
    }
    expect(logger.failures).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("decision log");
  });
});
