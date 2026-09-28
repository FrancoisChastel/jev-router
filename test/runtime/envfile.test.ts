import { describe, expect, test } from "bun:test";
import { applyEnv, envFilePath, formatEnvFile, parseEnvFile } from "../../src/runtime/envfile";

describe("env file", () => {
  test("parses KEY=value lines, ignores comments and junk, strips quotes and export", () => {
    expect(
      parseEnvFile(
        "# judge\nOPENROUTER_API_KEY=sk-or-1\nexport AI_GATEWAY_API_KEY=\"vck_2\"\n\nnot a line\n=nokey\n1BAD=x\nTYPESAFE_API_KEY='t'\n",
      ),
    ).toEqual({
      OPENROUTER_API_KEY: "sk-or-1",
      AI_GATEWAY_API_KEY: "vck_2",
      TYPESAFE_API_KEY: "t",
    });
  });
  test("round-trips through formatEnvFile and only fills gaps in the environment", () => {
    const vars = { A: "1", B: "2" };
    expect(parseEnvFile(formatEnvFile(vars))).toEqual(vars);
    const env: Record<string, string | undefined> = { A: "already", C: "" };
    expect(applyEnv(env, { ...vars, C: "3" })).toEqual(["B", "C"]);
    expect(env).toEqual({ A: "already", B: "2", C: "3" });
  });
  test("lives under the config dir", () => {
    expect(envFilePath({ JEV_ROUTER_HOME: "/x" })).toBe("/x/env");
  });
});
