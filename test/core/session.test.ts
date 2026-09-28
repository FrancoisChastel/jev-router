import { describe, expect, test } from "bun:test";
import { resolveSessionKey } from "../../src/core/session";

describe("session keys", () => {
  test("harness headers win over the prompt-prefix digest, Codex threads included", () => {
    expect(resolveSessionKey({ "x-claude-code-session-id": "s1", "x-claude-code-agent-id": "a" }, "d")).toEqual({
      key: "cc:s1:a",
      source: "claude-code",
    });
    expect(resolveSessionKey({ "thread-id": "t1", "session-id": "s1" }, "d")).toEqual({ key: "codex:t1", source: "codex" });
    expect(resolveSessionKey({ "session-id": "s1" }, "d")).toEqual({ key: "codex:s1", source: "codex" });
    expect(resolveSessionKey({ "x-opencode-session": "o" }, "d")).toEqual({ key: "oc:o", source: "opencode" });
    expect(resolveSessionKey({ "user-agent": "x" }, "d")).toEqual({ key: "prefix:d", source: "prefix" });
  });
});
