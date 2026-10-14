import { describe, expect, it } from "vitest";
import { EventBus } from "../src/events.js";
import { RpcTracker } from "../src/rpc-tracker.js";

describe("MCP 2026-07-28 multi-round-trip requests", () => {
  it("labels input_required results and links the retried rounds to the tool call", () => {
    const bus = new EventBus();
    const tracker = new RpcTracker(bus, { serverId: "s", linkCall: (m) => (m.method === "tools/call" ? "call-1" : undefined) });
    const params = { name: "brainstorm", arguments: { topic: "dinos" } };
    tracker.record("out", { jsonrpc: "2.0", id: 1, method: "tools/call", params });
    const asked = tracker.record("in", {
      jsonrpc: "2.0",
      id: 1,
      result: { resultType: "input_required", inputRequests: { ideas: { method: "sampling/createMessage", params: {} } }, requestState: "s1" },
    });
    expect(asked.title).toBe("input required #1 · tools/call: sampling/createMessage");
    expect(asked.rpc).toMatchObject({ inputRequired: [{ key: "ideas", method: "sampling/createMessage" }], callId: "call-1" });

    const retry = tracker.record("out", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { ...params, inputResponses: { ideas: { content: { type: "text", text: "x" } } }, requestState: "s1" } });
    expect(retry.title).toBe("tools/call #2 · round 2 with ideas");
    expect(retry.rpc).toMatchObject({ round: 2, callId: "call-1" });

    // A second input_required round, then the final result.
    tracker.record("in", { jsonrpc: "2.0", id: 2, result: { resultType: "input_required", inputRequests: { ok: { method: "elicitation/create", params: {} } }, requestState: "s2" } });
    const third = tracker.record("out", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { ...params, inputResponses: { ok: { action: "accept" } }, requestState: "s2" } });
    expect(third.rpc).toMatchObject({ round: 3, callId: "call-1" });
    const done = tracker.record("in", { jsonrpc: "2.0", id: 3, result: { content: [] } });
    expect(done.title).toBe("result #3 · tools/call");
    expect(done.rpc?.inputRequired).toBeUndefined();
  });

  it("keeps an extra title and adds the round", () => {
    const bus = new EventBus();
    const tracker = new RpcTracker(bus, { serverId: "s" });
    tracker.record("out", { jsonrpc: "2.0", id: 7, method: "prompts/get", params: { name: "p" } });
    tracker.record("in", { jsonrpc: "2.0", id: 7, result: { resultType: "input_required", requestState: "x" } });
    const retry = tracker.record("out", { jsonrpc: "2.0", id: 8, method: "prompts/get", params: { name: "p", requestState: "x" } }, Date.now(), { title: "prompts/get #8 · p" });
    expect(retry.title).toBe("prompts/get #8 · p · round 2");
  });
});
