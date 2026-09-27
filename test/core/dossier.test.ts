import { describe, expect, test } from "bun:test";
import { buildDossier, DOSSIER_LIMITS } from "../../src/core/dossier";
import type { NormalizedRequest } from "../../src/core/types";

function req(over: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    harness: "claude-code",
    sessionKey: "s1",
    requestedModel: "auto",
    isNewUserTurn: true,
    lastUserText: "fix the failing test in auth.ts",
    toolNames: ["Read", "Edit", "Bash"],
    hasImages: false,
    estimatedInputTokens: 1200,
    toolOutcomes: [],
    ...over,
  };
}

describe("dossier", () => {
  test("caps every field and the total size", () => {
    const huge = "x".repeat(50_000);
    const d = buildDossier(
      req({
        lastUserText: huge,
        assistantIntentTail: huge,
        toolOutcomes: Array.from({ length: 40 }, () => ({ name: "Bash", isError: true, errorText: huge })),
      }),
    );
    expect(d.task.length).toBeLessThanOrEqual(DOSSIER_LIMITS.taskChars);
    expect((d.intent ?? "").length).toBeLessThanOrEqual(DOSSIER_LIMITS.intentChars);
    expect(d.recent_tools.length).toBeLessThanOrEqual(DOSSIER_LIMITS.maxToolEntries);
    expect(JSON.stringify(d).length).toBeLessThanOrEqual(DOSSIER_LIMITS.totalChars);
  });

  test("oversized tool name lists are cut down to the total cap", () => {
    const names = Array.from({ length: 40 }, (_, i) => `mcp__${"n".repeat(2000)}__${i}`);
    const d = buildDossier(req({ toolNames: names }));
    expect(JSON.stringify(d).length).toBeLessThanOrEqual(DOSSIER_LIMITS.totalChars);
  });

  test("errors come first and excerpts are tails", () => {
    const d = buildDossier(
      req({
        toolOutcomes: [
          { name: "Read", isError: false, excerpt: "a".repeat(500) },
          { name: "Bash", isError: true, errorText: `start ${"b".repeat(500)} END` },
        ],
      }),
    );
    expect(d.recent_tools[0]?.name).toBe("Bash");
    expect(d.recent_tools[0]?.error).toBe(true);
    expect(d.recent_tools[0]?.excerpt?.endsWith("END")).toBe(true);
  });

  test("redaction hook runs on every string", () => {
    const d = buildDossier(req({ lastUserText: "token sk-abc123 leaked" }), { redact: (s) => s.replace(/sk-\w+/g, "[redacted]") });
    expect(d.task).toBe("token [redacted] leaked");
  });

  test("never includes the full conversation or system prompt keys", () => {
    const d = buildDossier(req()) as unknown as Record<string, unknown>;
    expect(Object.keys(d).sort()).toEqual(["harness", "images", "intent", "recent_tools", "task", "tools"].filter((k) => k in d).sort());
    expect("messages" in d).toBe(false);
    expect("system" in d).toBe(false);
  });
});
