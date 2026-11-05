import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pendingToolCalls } from "@mokalabs/core";
import { startSandbox } from "../src/index.js";
import { startFakeLlm } from "./fake-llm.js";

async function chat(port: number, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "x-moka-token": "t", "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
}

describe("time-travel forks", () => {
  it("finds tool calls without results", () => {
    const call = (id: string) => ({ type: "tool-call", toolCallId: id, toolName: "t", input: { n: id } });
    const result = (id: string) => ({ type: "tool-result", toolCallId: id, toolName: "t", output: { type: "text", value: id } });
    expect(pendingToolCalls([{ role: "user", content: "hi" }] as any)).toBeUndefined();
    expect(pendingToolCalls([{ role: "assistant", content: [call("a"), call("b")] }] as any)?.calls.map((c) => c.toolCallId)).toEqual(["a", "b"]);
    const partial = pendingToolCalls([{ role: "assistant", content: [call("a"), call("b")] }, { role: "tool", content: [result("a")] }] as any)!;
    expect(partial.calls.map((c) => c.toolCallId)).toEqual(["b"]);
    expect(partial.existing).toBeDefined();
    expect(pendingToolCalls([{ role: "assistant", content: [call("a")] }, { role: "tool", content: [result("a")] }] as any)).toBeUndefined();
  });

  it("continues from an edited result, re-runs edited arguments, and switches model", async () => {
    const fake = await startFakeLlm("moka-demo__get_time", { timezone: "Asia/Tokyo" });
    const home = mkdtempSync(path.join(os.tmpdir(), "moka-fork-"));
    const configPath = path.join(home, "moka.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      llms: [{ id: "a", name: "A", provider: "openai-compatible", model: "fake-a", baseURL: fake.baseURL }, { id: "b", name: "B", provider: "openai-compatible", model: "fake-b", baseURL: fake.baseURL }],
      mcpServers: [{ id: "moka-demo", name: "Demo", transport: "stdio", command: "moka:demo", protocol: "2025" }],
      workspaces: [{ id: "w", name: "W", llmId: "a", mcpServerIds: ["moka-demo"], skillIds: [] }],
    }));
    const sb = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
    try {
      const user = { role: "user", content: "time in tokyo" };
      const first = await chat(sb.port, { messages: [user] });
      const turn = first.find((c) => c.type === "finish").messages;
      const [assistant, toolMessage] = turn;
      expect(assistant.content.find((p: any) => p.type === "tool-call").input).toEqual({ timezone: "Asia/Tokyo" });

      // 1. Edit the result: the model continues from the edited output, no tool runs.
      const edited = { ...toolMessage, content: toolMessage.content.map((p: any) => ({ ...p, output: { type: "text", value: "MIDNIGHT" } })) };
      const byResult = await chat(sb.port, { messages: [user, assistant, edited], forkOf: { step: 1, edit: "result", tool: "get_time", label: "edited result of get_time" } });
      expect(byResult.some((c) => c.type === "tool-call")).toBe(false);
      expect(byResult.filter((c) => c.type === "text").map((c) => c.text).join("")).toContain("MIDNIGHT");
      expect(byResult.find((c) => c.type === "finish").replacesLast).toBeUndefined();
      const start = sb.engine.bus.history().filter((e) => e.kind === "run.start").at(-1)!;
      expect(start.title).toContain("Fork started");
      expect((start.data as any).forkOf).toMatchObject({ edit: "result", tool: "get_time" });

      // 2. Edit the arguments: Moka runs the call with them, then the model continues.
      const reargued = { ...assistant, content: assistant.content.map((p: any) => (p.type === "tool-call" ? { ...p, input: { timezone: "Europe/Paris" } } : p)) };
      const byArgs = await chat(sb.port, { messages: [user, reargued], forkOf: { step: 1, edit: "arguments", tool: "get_time" } });
      const ran = byArgs.find((c) => c.type === "tool-call");
      expect(ran.input).toEqual({ timezone: "Europe/Paris" });
      expect(byArgs.find((c) => c.type === "tool-result").isError).toBe(false);
      const argsTurn = byArgs.find((c) => c.type === "finish").messages;
      expect(argsTurn[0].role).toBe("tool");
      expect(argsTurn[0].content[0].output.value).toMatch(/ISO:/);
      expect(argsTurn.at(-1).role).toBe("assistant");
      const sent = fake.requests.at(-1).messages;
      expect(sent.find((m: any) => m.role === "tool")?.content).toMatch(/ISO:/);

      // 3. Another model from the same point.
      const byModel = await chat(sb.port, { messages: [user, assistant, toolMessage], llmId: "b", forkOf: { step: 2, edit: "model" } });
      expect(byModel[0]).toMatchObject({ type: "start", profileId: "b" });
      expect(fake.requests.at(-1).model).toBe("fake-b");
    } finally {
      await sb.close();
      await fake.close();
    }
  }, 60_000);
});
