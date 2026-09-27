import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpJudge } from "../../src/judge/http";
import { createJudge } from "../../src/runtime/judge-factory";
import { readPolicyFile } from "../../src/runtime/policy-file";
import { minimalPolicy } from "../fixtures/policies";

describe("policy file", () => {
  test("reads JSON and YAML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-router-"));
    await writeFile(join(dir, "policy.json"), JSON.stringify(minimalPolicy()));
    const p = await readPolicyFile(join(dir, "policy.json"));
    expect(Object.keys(p.candidates)).toEqual(["fast", "mid", "frontier"]);

    await writeFile(
      join(dir, "policy.yaml"),
      [
        "version: 1",
        "judge: { transport: mock }",
        "candidates:",
        "  fast: { model: a, price: { in: 1, out: 2 } }",
        "routes: []",
        "policies:",
        "  default: { default: fast, rules: [] }",
      ].join("\n"),
    );
    const y = await readPolicyFile(join(dir, "policy.yaml"));
    expect(y.candidates.fast?.model).toBe("a");
  });

  test("reports YAML syntax errors as such", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jev-router-"));
    await writeFile(join(dir, "policy.yaml"), "version: 1\njudge: {transport: mock\n");
    await expect(readPolicyFile(join(dir, "policy.yaml"))).rejects.toThrow(/YAML/);
    await expect(readPolicyFile(join(dir, "policy.yaml"))).rejects.not.toThrow(/package/);
  });

  test("reports a clear error for a missing file", async () => {
    await expect(readPolicyFile("/nonexistent/policy.json")).rejects.toThrow(/policy file/);
  });
});

describe("judge factory", () => {
  test("builds an http judge from the policy and environment", () => {
    const j = createJudge(
      { transport: "openrouter", timeout_ms: 900, on_error: "fail_open", mode: "signals" },
      { OPENROUTER_API_KEY: "k" },
    );
    expect(j).toBeInstanceOf(HttpJudge);
  });

  test("honors api_key_env and fails clearly when the key is missing", () => {
    expect(() =>
      createJudge({ transport: "vercel", api_key_env: "MY_KEY", timeout_ms: 1500, on_error: "fail_open", mode: "signals" }, {}),
    ).toThrow(/MY_KEY/);
  });

  test("returns undefined for the mock transport", () => {
    expect(createJudge({ transport: "mock", timeout_ms: 1500, on_error: "fail_open", mode: "signals" }, {})).toBeUndefined();
  });
});
