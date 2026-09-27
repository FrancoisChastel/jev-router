import { describe, expect, test } from "bun:test";
import { parseUpOptions } from "../../src/cli/main";

describe("up options", () => {
  test("parses host, port, shadow, and token with env fallback", () => {
    expect(parseUpOptions([], {})).toEqual({ host: "127.0.0.1", port: 4141 });
    expect(parseUpOptions(["--host", "0.0.0.0", "--port", "5000", "--shadow", "fast", "--token", "abc"], {})).toEqual({
      host: "0.0.0.0",
      port: 5000,
      shadow: "fast",
      token: "abc",
    });
    expect(parseUpOptions([], { JEV_ROUTER_TOKEN: "env-token" }).token).toBe("env-token");
    expect(parseUpOptions(["--token", "flag"], { JEV_ROUTER_TOKEN: "env-token" }).token).toBe("flag");
  });

  test("rejects a bad port", () => {
    expect(() => parseUpOptions(["--port", "abc"], {})).toThrow(/port/);
    expect(() => parseUpOptions(["--port", "70000"], {})).toThrow(/port/);
  });
});
