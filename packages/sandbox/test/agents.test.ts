import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemoAgent, startSandbox, type DemoAgent, type RunningSandbox } from "../src/index.js";

let sandbox: RunningSandbox;
let agent: DemoAgent;
let noisy: Server;
let base: string;

/** An AG-UI agent that, like ag-ui-langgraph, re-emits every framework event as RAW. */
async function startNoisyAgent(): Promise<string> {
  noisy = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ type: "RUN_STARTED", threadId: "t", runId: "r" });
    for (let i = 0; i < 250; i++) send({ type: "RAW", event: { event: "on_chain_stream", seq: i } });
    send({ type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" });
    send({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "hi" });
    send({ type: "TEXT_MESSAGE_END", messageId: "m" });
    send({ type: "RUN_FINISHED", threadId: "t", runId: "r" });
    res.end();
  });
  await new Promise<void>((resolve) => noisy.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(noisy.address() as AddressInfo).port}/agent`;
}

const post = async (pathname: string, body: unknown) => {
  const res = await fetch(`${base}${pathname}`, { method: "POST", headers: { "x-moka-token": "t", "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.text();
};
const chat = async (body: Record<string, unknown>) => (await post("/api/chat", body)).trim().split("\n").map((l) => JSON.parse(l));
const textOf = (chunks: any[]) => chunks.filter((c) => c.type === "text").map((c) => c.text).join("");

beforeAll(async () => {
  agent = await startDemoAgent(0);
  const noisyUrl = await startNoisyAgent();
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-agents-"));
  const configPath = path.join(home, "moka.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      agents: [
        { id: "a2a", name: "Demo A2A", protocol: "a2a", url: agent.a2aUrl },
        { id: "agui", name: "Demo AG-UI", protocol: "ag-ui", url: agent.aguiUrl, shareTools: true },
        { id: "noisy", name: "Noisy AG-UI", protocol: "ag-ui", url: noisyUrl },
      ],
      mcpServers: [{ id: "moka-demo", name: "Demo", transport: "stdio", command: "moka:demo" }],
      workspaces: [{ id: "w", name: "W", agentId: "a2a", mcpServerIds: ["moka-demo"], skillIds: [] }],
    }),
  );
  sandbox = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
  base = `http://127.0.0.1:${sandbox.port}`;
}, 30_000);

afterAll(async () => {
  await sandbox?.close();
  await agent?.close();
  await new Promise<void>((r) => (noisy ? noisy.close(() => r()) : r()));
});

describe("A2A agents", () => {
  it("reads the agent card", async () => {
    const res = JSON.parse(await post("/api/agents/test", { agent: { id: "x", name: "X", protocol: "a2a", url: agent.a2aUrl } }));
    expect(res.ok).toBe(true);
    expect(res.card.name).toBe("Moka demo agent");
    expect(res.card.skills).toHaveLength(2);
  });

  it("streams text and keeps the context id for the next turn", async () => {
    const chunks = await chat({ messages: [{ role: "user", content: "hello there" }] });
    expect(chunks[0]).toMatchObject({ type: "start", model: "Demo A2A", profileId: "agent:a2a" });
    expect(textOf(chunks)).toMatch(/^You said: "hello there"/);
    const finish = chunks.at(-1);
    expect(finish.type).toBe("finish");
    expect(finish.messages[0].providerOptions.moka.contextId).toBeTruthy();
    const kinds = sandbox.engine.bus.history().map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["agent.request", "agent.event", "agent.response", "run.start", "run.finish"]));
  });

  it("renders A2UI from data parts and sends button actions back as data", async () => {
    const first = await chat({ messages: [{ role: "user", content: "book a tasting" }] });
    const ui = first.filter((c) => c.type === "tool-result" && c.ui).at(-1);
    expect(ui.ui.kind).toBe("a2ui");
    expect(ui.ui.messages.map((m: any) => Object.keys(m)[1])).toEqual(["createSurface", "updateComponents", "updateDataModel"]);
    const history = [{ role: "user", content: "book a tasting" }, ...first.at(-1).messages];
    const action = { name: "book_tasting", surfaceId: "demo-booking", sourceComponentId: "go", timestamp: "", context: { when: "2026-10-01T10:00", guests: 3 } };
    const second = await chat({ messages: [...history, { role: "user", content: `[ui action] ${JSON.stringify(action)}` }] });
    expect(textOf(second)).toBe("Booked ✅ 3 guest(s) on 2026-10-01 at 10:00. See you there!");
    const request = sandbox.engine.bus.history().filter((e) => e.kind === "agent.request").at(-1)!.data as any;
    expect(request.body.params.message.parts[0]).toMatchObject({ kind: "data", data: { action: { name: "book_tasting" } } });
    expect(request.body.params.message.contextId).toBe(first.at(-1).messages[0].providerOptions.moka.contextId);
    expect(request.extensions).toEqual(["https://a2ui.org/a2a-extension/a2ui/v0.8"]);
  });
});

describe("AG-UI agents", () => {
  it("runs a quick test", async () => {
    const res = JSON.parse(await post("/api/agents/test", { agent: { id: "x", name: "X", protocol: "ag-ui", url: agent.aguiUrl } }));
    expect(res.ok).toBe(true);
    expect(res.events).toEqual(expect.arrayContaining(["RUN_STARTED", "TEXT_MESSAGE_CONTENT", "RUN_FINISHED"]));
  });

  it("streams text, state and custom A2UI events", async () => {
    const chunks = await chat({ agentId: "agui", messages: [{ role: "user", content: "show me the booking form" }] });
    expect(textOf(chunks)).toBe("Here's a booking form. Pick a time and I'll reserve it.");
    expect(chunks.find((c) => c.type === "tool-result" && c.ui)?.ui.kind).toBe("a2ui");
    const meta = chunks.at(-1).messages.at(-1).providerOptions.moka;
    expect(meta.state).toEqual({ turns: 1 });
    expect(meta.threadId).toBeTruthy();
  });

  it("runs shared MCP tools as frontend tools and continues the run", async () => {
    const chunks = await chat({ agentId: "agui", messages: [{ role: "user", content: "what time is it?" }] });
    const call = chunks.find((c) => c.type === "tool-call");
    expect(call).toMatchObject({ name: "moka-demo__get_time", tool: "get_time", source: "Demo", input: { timezone: "Asia/Tokyo" } });
    const result = chunks.find((c) => c.type === "tool-result" && c.id === call.id);
    expect(result.isError).toBe(false);
    expect(textOf(chunks)).toMatch(/^The tool answered: /);
    const roles = chunks.at(-1).messages.map((m: any) => m.role);
    expect(roles).toEqual(["assistant", "tool", "assistant"]);
    const firstRun = sandbox.engine.bus.history().filter((e) => e.kind === "agent.request").at(-2)!.data as any;
    expect(firstRun.body.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["moka-demo__get_time", "render_ui"]));
  }, 30_000);
});

describe("AG-UI RAW events", () => {
  it("collapses them into one inspector entry before RUN_FINISHED", async () => {
    const chunks = await chat({ agentId: "noisy", messages: [{ role: "user", content: "hi" }] });
    expect(textOf(chunks)).toBe("hi");
    const runId = sandbox.engine.bus.history().filter((e) => e.kind === "agent.request").at(-1)!.runId;
    const titles = sandbox.engine.bus.history().filter((e) => e.runId === runId && e.kind === "agent.event").map((e) => e.title);
    expect(titles.filter((t) => t.startsWith("AG-UI RAW"))).toEqual(["AG-UI RAW × 250 (collapsed)"]);
    expect(titles.indexOf("AG-UI RAW × 250 (collapsed)")).toBe(titles.indexOf("AG-UI RUN_FINISHED") - 1);
    const collapsed = sandbox.engine.bus.history().find((e) => e.runId === runId && e.title.startsWith("AG-UI RAW"))!.data as any;
    expect(collapsed).toMatchObject({ count: 250, truncated: 50 });
    expect(collapsed.events).toHaveLength(200);
  });
});
