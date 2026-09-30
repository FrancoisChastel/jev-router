import { describe, expect, test } from "bun:test";
import type { TokenUsage } from "../../src/core/record";
import { advanceSession, emptySession, resolveSessionKey, withUsage } from "../../src/core/session";
import type { NormalizedRequest } from "../../src/core/types";

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

describe("session usage", () => {
  const request: NormalizedRequest = {
    harness: "codex",
    sessionKey: "s",
    requestedModel: "auto",
    isNewUserTurn: true,
    toolNames: [],
    hasImages: false,
    estimatedInputTokens: 10,
    toolOutcomes: [],
  };

  test("withUsage records the token counts only and leaves the input untouched", () => {
    const before = emptySession();
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.5 };
    const after = withUsage(before, usage);
    expect(after.lastUsage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 });
    expect(before.lastUsage).toBeUndefined();
  });

  test("withUsage without usage clears a stale value", () => {
    const s = withUsage(emptySession(), { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 });
    expect(withUsage(s, undefined).lastUsage).toBeUndefined();
    expect("lastUsage" in withUsage(s, undefined)).toBe(false);
  });

  test("advanceSession drops the previous call's usage until the daemon supplies the new one", () => {
    const s = withUsage(emptySession(), { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 });
    expect(advanceSession(s, request, {}).lastUsage).toBeUndefined();
  });
});
