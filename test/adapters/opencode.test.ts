import { describe, expect, test } from "bun:test";
import { createOpenCodePlugin, mapEvent, mapToolResult } from "../../src/adapters/opencode";

describe("opencode mapping", () => {
  test("tool results become observe events with inferred errors", () => {
    expect(
      mapToolResult({ tool: "bash", sessionID: "S", callID: "c", args: {} }, { title: "t", output: "ok", metadata: { exit: 0 } }),
    ).toEqual({ session: "oc:S", event: "tool_result", tool: { name: "bash", isError: false, text: "ok" } });
    expect(
      mapToolResult({ tool: "bash", sessionID: "S", callID: "c", args: {} }, { title: "t", output: "boom", metadata: { exit: 2 } }).tool
        ?.isError,
    ).toBe(true);
    expect(
      mapToolResult({ tool: "read", sessionID: "S", callID: "c", args: {} }, { title: "t", output: "Error: file not found", metadata: {} })
        .tool?.isError,
    ).toBe(true);
  });

  test("session events map to compaction and api errors, others are ignored", () => {
    expect(mapEvent({ type: "session.compacted", properties: { sessionID: "S" } })).toEqual({ session: "oc:S", event: "compaction" });
    expect(
      mapEvent({ type: "session.error", properties: { sessionID: "S", error: { name: "APIError", data: { message: "overloaded" } } } }),
    ).toEqual({ session: "oc:S", event: "api_error", error: "APIError: overloaded" });
    expect(mapEvent({ type: "session.idle", properties: { sessionID: "S" } })).toBeUndefined();
    expect(mapEvent({ type: "session.error", properties: {} })).toBeUndefined();
  });
});

describe("opencode plugin", () => {
  test("injects the session header and posts signals to the relay, warning once when it is down", async () => {
    const posted: unknown[] = [];
    let fail = false;
    const warnings: string[] = [];
    const fetchImpl = async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (fail) throw new Error("ECONNREFUSED");
      posted.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    };
    const hooks = await createOpenCodePlugin({ relayUrl: "http://127.0.0.1:1/", fetch: fetchImpl, warn: (m) => warnings.push(m) })(
      {} as never,
    );
    const headers: Record<string, string> = {};
    await hooks["chat.headers"]?.({ sessionID: "S1" } as never, { headers });
    expect(headers["x-opencode-session"]).toBe("S1");
    await hooks["tool.execute.after"]?.(
      { tool: "edit", sessionID: "S1", callID: "c1", args: {} },
      { title: "t", output: "done", metadata: {} },
    );
    await hooks.event?.({ event: { type: "session.compacted", properties: { sessionID: "S1" } } as never });
    expect(posted).toHaveLength(2);
    fail = true;
    await hooks["tool.execute.after"]?.(
      { tool: "edit", sessionID: "S1", callID: "c2", args: {} },
      { title: "t", output: "x", metadata: {} },
    );
    await hooks["tool.execute.after"]?.(
      { tool: "edit", sessionID: "S1", callID: "c3", args: {} },
      { title: "t", output: "x", metadata: {} },
    );
    expect(warnings).toHaveLength(1);
  });
});
