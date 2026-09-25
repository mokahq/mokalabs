import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/demo-server.js";
import { startSandbox, type RunningSandbox } from "../src/index.js";
import { startFakeLlm } from "./fake-llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let sandbox: RunningSandbox;
let llm: Awaited<ReturnType<typeof startFakeLlm>>;
let base: string;
const TOKEN = "test-token";

async function call(pathname: string, init: { method?: string; body?: unknown; token?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (init.token !== null) headers["x-moka-token"] = init.token ?? TOKEN;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${pathname}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.text()) as string };
}

beforeAll(async () => {
  llm = await startFakeLlm("moka-demo__calculate", { expression: "6*7" });
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-e2e-"));
  const configPath = path.join(home, "moka.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      llms: [{ id: "fake", name: "Fake", provider: "openai-compatible", model: "fake-1", baseURL: llm.baseURL }],
      mcpServers: [{ id: "moka-demo", name: "Demo", transport: "stdio", command: "moka:demo" }],
      skills: [{ id: "inline", content: "---\nname: haiku\ndescription: Writes haiku\n---\nFive seven five." }],
      workspaces: [{ id: "w", name: "W", llmId: "fake", mcpServerIds: ["moka-demo"], skillIds: ["inline"] }],
    }),
  );
  sandbox = await startSandbox({ port: 0, configPath, token: TOKEN, env: { ...process.env, MOKA_HOME: home }, ui: false });
  base = `http://127.0.0.1:${sandbox.port}`;
}, 30_000);

afterAll(async () => {
  await sandbox?.close();
  await llm?.close();
});

describe("sandbox server", () => {
  it("requires the access token", async () => {
    expect((await call("/api/bootstrap", { token: null })).status).toBe(401);
    expect((await call("/api/bootstrap", { token: "wrong" })).status).toBe(401);
    expect((await call("/api/health", { token: null })).status).toBe(200);
  });

  it("bootstraps config, presets and skills", async () => {
    const res = await call("/api/bootstrap");
    const boot = JSON.parse(res.body);
    expect(boot.config.llms[0].id).toBe("fake");
    expect(boot.presets.length).toBeGreaterThan(5);
    expect(boot.skills[0]).toMatchObject({ name: "haiku", description: "Writes haiku" });
  });

  it("connects the bundled demo MCP server and calls a tool", async () => {
    const connect = JSON.parse((await call("/api/mcp/moka-demo/connect", { body: {} })).body);
    expect(connect.state.status).toBe("connected");
    expect(connect.state.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["get_time", "calculate", "roll_dice", "fetch_url"]));
    const result = JSON.parse((await call("/api/mcp/moka-demo/call", { body: { tool: "calculate", args: { expression: "2^10" } } })).body);
    expect(result.result.content[0].text).toBe("1024");
  }, 30_000);

  it("streams a full agent turn with a tool call", async () => {
    const res = await call("/api/chat", { body: { messages: [{ role: "user", content: "what is 6*7?" }] } });
    const chunks = res.body.trim().split("\n").map((l) => JSON.parse(l));
    const types = chunks.map((c) => c.type);
    expect(types[0]).toBe("start");
    expect(chunks.find((c) => c.type === "tool-call")).toMatchObject({ tool: "calculate", input: { expression: "6*7" } });
    expect(chunks.find((c) => c.type === "tool-result")).toMatchObject({ output: "42", isError: false });
    const text = chunks.filter((c) => c.type === "text").map((c) => c.text).join("");
    expect(text).toBe("The answer is 42");
    const finish = chunks.at(-1);
    expect(finish.type).toBe("finish");
    expect(finish.usage.totalTokens).toBe(41);
    // tool call + tool result + final answer are all carried forward for the next turn
    expect(finish.messages.map((m: any) => m.role)).toEqual(["assistant", "tool", "assistant"]);
    // skills are advertised to the model and exposed as a tool
    const sent = llm.requests.at(-1);
    expect(JSON.stringify(sent.messages[0])).toContain("haiku");
    expect(sent.tools.map((t: any) => t.function.name)).toContain("load_skill");
  }, 30_000);

  it("records inspector events, including raw MCP JSON-RPC", async () => {
    const events = sandbox.engine.bus.history();
    const kinds = new Set(events.map((e) => e.kind));
    for (const kind of ["mcp.status", "mcp.rpc", "run.start", "llm.request", "llm.response", "tool.call", "tool.result", "run.finish"]) {
      expect(kinds.has(kind as any), kind).toBe(true);
    }
    expect(events.some((e) => e.kind === "mcp.rpc" && e.title.startsWith("initialize"))).toBe(true);
  });

  it("lists models and tests the LLM", async () => {
    const profile = { id: "fake", name: "Fake", provider: "openai-compatible", model: "fake-1", baseURL: llm.baseURL };
    expect(JSON.parse((await call("/api/llm/models", { body: { profile } })).body).models).toEqual(["fake-1", "fake-2"]);
    expect(JSON.parse((await call("/api/llm/test", { body: { profile } })).body)).toMatchObject({ ok: true, text: "pong" });
  });

  it("validates and persists config", async () => {
    expect((await call("/api/config", { method: "PUT", body: {} })).status).toBe(400);
    const current = JSON.parse((await call("/api/bootstrap")).body).config;
    const bad = { ...current, llms: [{ id: "x", name: "X", provider: "nope", model: "m" }] };
    expect((await call("/api/config", { method: "PUT", body: bad })).status).toBe(400);
    const next = { ...current, workspaces: [...current.workspaces, { id: "w2", name: "Second", mcpServerIds: [], skillIds: [] }] };
    expect((await call("/api/config", { method: "PUT", body: next })).status).toBe(200);
    const onDisk = JSON.parse(readFileSync(sandbox.configPath, "utf8"));
    expect(onDisk.workspaces.map((w: any) => w.id)).toEqual(["w", "w2"]);
  });

  it("imports mcp.json and exports code", async () => {
    const imported = JSON.parse((await call("/api/mcp/import", { body: { json: '{"mcpServers":{"x":{"command":"node"}}}' } })).body);
    expect(imported.servers[0]).toMatchObject({ id: "x", transport: "stdio" });
    const code = JSON.parse((await call("/api/export", { body: { target: "ai-sdk", workspaceId: "w" } })).body).code;
    expect(code).toContain("streamText");
  });

  it("stores chat sessions", async () => {
    const session = { title: "Hello", createdAt: Date.now(), messageCount: 1, data: { messages: [], modelMessages: [] } };
    expect((await call("/api/sessions/s_1", { method: "PUT", body: session })).status).toBe(200);
    const list = JSON.parse((await call("/api/sessions")).body).sessions;
    expect(list[0]).toMatchObject({ id: "s_1", title: "Hello" });
    expect((await call("/api/sessions/..%2Fetc", { method: "PUT", body: session })).status).toBe(400);
    expect((await call("/api/sessions/s_1", { method: "DELETE" })).status).toBe(200);
  });

  it("loads the create-moka template config", async () => {
    const template = path.resolve(here, "../../create-moka/templates/default/moka.json");
    const { parseConfig } = await import("@mokalabs/core");
    const config = parseConfig(JSON.parse(readFileSync(template, "utf8")));
    expect(config.workspaces.length).toBeGreaterThan(1);
  });
});

describe("demo calculator", () => {
  it("evaluates safely", () => {
    expect(evaluate("(2 + 3) * sqrt(16)")).toBe(20);
    expect(evaluate("-2^2")).toBe(-4);
    expect(evaluate("2^3^2")).toBe(512);
    expect(evaluate("max(1, 5, 3) % 4")).toBe(1);
    expect(() => evaluate("process.exit()")).toThrow();
    expect(() => evaluate("1 +")).toThrow();
  });
});

describe("generative UI", () => {
  it("exposes the demo MCP App and serves its ui:// resource", async () => {
    const state = JSON.parse((await call("/api/mcp/moka-demo/connect", { body: {} })).body).state;
    const dice = state.tools.find((t: any) => t.name === "roll_dice");
    expect(dice._meta.ui.resourceUri).toBe("ui://moka-demo/dice");
    const res = JSON.parse((await call("/api/mcp/moka-demo/resource", { body: { uri: "ui://moka-demo/dice" } })).body);
    expect(res.result.contents[0].mimeType).toBe("text/html;profile=mcp-app");
    expect(res.result.contents[0].text).toContain("ui/initialize");
  });

  it("attaches MCP App UI and the raw result to tool-result chunks", async () => {
    const dice = await startFakeLlm("moka-demo__roll_dice", { sides: 6, count: 2 });
    const config = JSON.parse((await call("/api/bootstrap")).body).config;
    config.llms.push({ id: "dice", name: "Dice", provider: "openai-compatible", model: "m", baseURL: dice.baseURL });
    await call("/api/config", { method: "PUT", body: config });
    const res = await call("/api/chat", { body: { llmId: "dice", messages: [{ role: "user", content: "roll" }] } });
    const result = res.body.trim().split("\n").map((l) => JSON.parse(l)).find((c) => c.type === "tool-result");
    expect(result.ui).toEqual({ kind: "mcp-app", serverId: "moka-demo", resourceUri: "ui://moka-demo/dice" });
    expect(result.raw.structuredContent.rolls).toHaveLength(2);
    await dice.close();
  }, 30_000);

  it("lets any model render A2UI through render_ui", async () => {
    const ui = await startFakeLlm("render_ui", {
      surfaceId: "s1",
      components: [
        { id: "root", component: "Column", children: ["t"] },
        { id: "t", component: "Text", text: { path: "/greeting" } },
      ],
      data: { greeting: "hello" },
    });
    const config = JSON.parse((await call("/api/bootstrap")).body).config;
    config.llms.push({ id: "ui", name: "UI", provider: "openai-compatible", model: "m", baseURL: ui.baseURL });
    await call("/api/config", { method: "PUT", body: config });
    const res = await call("/api/chat", { body: { llmId: "ui", messages: [{ role: "user", content: "show ui" }] } });
    const chunks = res.body.trim().split("\n").map((l) => JSON.parse(l));
    const result = chunks.find((c) => c.type === "tool-result");
    expect(result.isError).toBe(false);
    expect(result.ui.kind).toBe("a2ui");
    expect(result.ui.messages.map((m: any) => Object.keys(m)[1])).toEqual(["createSurface", "updateComponents", "updateDataModel"]);
    expect(ui.requests[0].tools.map((t: any) => t.function.name)).toContain("render_ui");
    await ui.close();
  }, 30_000);

  it("rejects invalid UI with actionable feedback", async () => {
    const bad = await startFakeLlm("render_ui", { components: [{ id: "x", component: "Text" }] });
    const config = JSON.parse((await call("/api/bootstrap")).body).config;
    config.llms.push({ id: "bad", name: "Bad", provider: "openai-compatible", model: "m", baseURL: bad.baseURL });
    await call("/api/config", { method: "PUT", body: config });
    const res = await call("/api/chat", { body: { llmId: "bad", messages: [{ role: "user", content: "ui" }] } });
    const result = res.body.trim().split("\n").map((l) => JSON.parse(l)).find((c) => c.type === "tool-result");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/root/);
    await bad.close();
  }, 30_000);
});
