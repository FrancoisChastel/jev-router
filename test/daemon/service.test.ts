import { describe, expect, test } from "bun:test";
import { loadPolicy } from "../../src/core/policy";
import { RouterService } from "../../src/daemon/service";
import { SessionStore } from "../../src/daemon/session-store";
import { minimalPolicy } from "../fixtures/policies";

const body = {
  requestedModel: "auto",
  isNewUserTurn: true,
  lastUserText: "hi",
  toolNames: [],
  hasImages: false,
  toolOutcomes: [],
  stream: false,
  prefixDigestInput: "",
};

describe("router service pending signals", () => {
  test("hook signals survive a failed request and are consumed by the next successful one", async () => {
    const store = new SessionStore();
    const service = new RouterService({
      policy: loadPolicy(minimalPolicy()),
      judge: undefined,
      store,
      log: () => undefined,
      now: () => 0,
      randomId: () => "id",
    });
    store.observe({ session: "s", event: "tool_result", tool: { name: "Bash", isError: true, text: "boom" } });

    const failed = await service.decide({ harness: "unknown", sessionKey: "s", policyId: "default", body, estimatedInputTokens: 10 });
    expect(failed.request.toolOutcomes).toHaveLength(1);
    failed.commit({ ok: false, error: "upstream 502" });
    expect(store.peekPending("s").outcomes).toHaveLength(1);
    expect(store.get("s")?.turn ?? 0).toBe(0);

    store.observe({ session: "s", event: "compaction" });
    const ok = await service.decide({ harness: "unknown", sessionKey: "s", policyId: "default", body, estimatedInputTokens: 10 });
    expect(ok.request.contextCompacted).toBe(true);
    ok.commit({ ok: true });
    expect(store.peekPending("s").outcomes).toHaveLength(0);
    expect(store.peekPending("s").compaction).toBe(false);
    expect(store.get("s")?.turn).toBe(1);
  });

  test("signals reported while a request is in flight are kept for the next one", async () => {
    const store = new SessionStore();
    const service = new RouterService({
      policy: loadPolicy(minimalPolicy()),
      judge: undefined,
      store,
      log: () => undefined,
      now: () => 0,
      randomId: () => "id",
    });
    const d = await service.decide({ harness: "unknown", sessionKey: "s", policyId: "default", body, estimatedInputTokens: 10 });
    store.observe({ session: "s", event: "tool_result", tool: { name: "Edit", isError: false } });
    d.commit({ ok: true });
    expect(store.peekPending("s").outcomes).toHaveLength(1);
  });

  test("a completed response's usage is kept on the session for the next decision", async () => {
    const store = new SessionStore();
    const service = new RouterService({
      policy: loadPolicy(minimalPolicy()),
      judge: undefined,
      store,
      log: () => undefined,
      now: () => 0,
      randomId: () => "id",
    });
    const first = await service.decide({ harness: "unknown", sessionKey: "s", policyId: "default", body, estimatedInputTokens: 10 });
    first.commit({ ok: true }, { inputTokens: 900, outputTokens: 50, cacheReadTokens: 800, costUsd: 0.01 });
    expect(store.get("s")?.lastUsage).toEqual({ inputTokens: 900, outputTokens: 50, cacheReadTokens: 800 });

    const second = await service.decide({ harness: "unknown", sessionKey: "s", policyId: "default", body, estimatedInputTokens: 10 });
    second.commit({ ok: true });
    expect(store.get("s")?.lastUsage).toBeUndefined();
  });
});
