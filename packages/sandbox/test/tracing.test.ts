import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MokaEvent } from "@mokalabs/core";
import { startSandbox, type RunningSandbox } from "../src/index.js";

/**
 * A hand-written Streamable HTTP MCP server whose `slow` tool always answers
 * after 400 ms, even when the client has cancelled (so we can see a late reply).
 */
async function startSlowServer() {
  const readBody = async (req: IncomingMessage) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw;
  };
  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST") return res.writeHead(405).end();
    const message = JSON.parse(await readBody(req));
    if (message.id === undefined) return res.writeHead(202).end();
    const reply = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    if (message.method === "initialize") {
      return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "slow", version: "1.0.0" } });
    }
    if (message.method === "tools/list") return reply({ tools: [{ name: "slow", inputSchema: { type: "object" } }] });
    if (message.method === "tools/call") {
      await new Promise((r) => setTimeout(r, 400));
      return reply({ content: [{ type: "text", text: "done" }] });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** An OpenAI-compatible model that books the same table twice (and reads the time twice) in one step. */
async function startRepeatingModel() {
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const base = { id: "c", object: "chat.completion.chunk", created: 0, model: body.model };
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    res.setHeader("content-type", "text/event-stream");
    if (!body.messages.some((m: any) => m.role === "tool")) {
      const calls = [
        ["moka-demo__book_table", { restaurant: "Toit", partySize: 2 }],
        ["moka-demo__book_table", { partySize: 2, restaurant: "Toit" }],
        ["moka-demo__get_time", { timezone: "UTC" }],
        ["moka-demo__get_time", { timezone: "UTC" }],
      ] as const;
      const tool_calls = calls.map(([name, args], index) => ({ index, id: `call_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }));
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    } else {
      send({ ...base, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/**
 * An MCP server with a `save` tool (no readOnlyHint, so it may write) and an idempotent
 * `set_status` tool. Both always do their work, but answer their first call slowly
 * enough to hit the client's timeout.
 */
async function startSlowWriteServer() {
  const saved: string[] = [];
  const calls = new Map<string, number>();
  const server: Server = createServer(async (req, res) => {
    if (req.method !== "POST") return res.writeHead(405).end();
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    if (message.id === undefined) return res.writeHead(202).end();
    const reply = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    if (message.method === "initialize") {
      return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "writer", version: "1.0.0" } });
    }
    if (message.method === "tools/list") {
      return reply({
        tools: [
          { name: "save", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } },
          {
            name: "set_status",
            inputSchema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
            annotations: { idempotentHint: true },
          },
        ],
      });
    }
    if (message.method === "tools/call" && !["save", "set_status"].includes(message.params.name)) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Unknown tool ${message.params.name}` } }));
    }
    if (message.method === "tools/call") {
      const { name, arguments: args } = message.params;
      saved.push(args.note ?? args.status);
      calls.set(name, (calls.get(name) ?? 0) + 1);
      if (calls.get(name) === 1) await new Promise((r) => setTimeout(r, 400));
      return reply({ content: [{ type: "text", text: "saved" }] });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, saved, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/**
 * A model that calls a tool, and after an error calls it again with the same arguments:
 * `save` by default, `set_status` when asked about status. "truncated" sends broken JSON.
 */
async function startRetryingModel() {
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const base = { id: "c", object: "chat.completion.chunk", created: 0, model: body.model };
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    res.setHeader("content-type", "text/event-stream");
    const results = body.messages.filter((m: any) => m.role === "tool").length;
    const ask = String(body.messages.findLast((m: any) => m.role === "user")?.content);
    const status = /status/.test(ask);
    if (/flaky/.test(ask)) {
      if (results === 0) {
        const tool_calls = [{ index: 0, id: "flaky_0", type: "function", function: { name: "moka-demo__flaky_write", arguments: JSON.stringify({ note: "flaky note" }) } }];
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      } else {
        send({ ...base, choices: [{ index: 0, delta: { content: "it may have been saved" }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      }
    } else if (/truncated/.test(ask) && results === 0) {
      const tool_calls = [{ index: 0, id: "cut_0", type: "function", function: { name: "wr__save", arguments: '{"note":"buy mi' } }];
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    } else if (results < 2 && !/truncated/.test(ask)) {
      const args = status ? { status: "done" } : { note: "buy milk" };
      const name = status ? "wr__set_status" : "wr__save";
      const tool_calls = [{ index: 0, id: `${status ? "status" : "save"}_${results}`, type: "function", function: { name, arguments: JSON.stringify(args) } }];
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    } else {
      send({ ...base, choices: [{ index: 0, delta: { content: "saved" }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** An AG-UI agent with two graph nodes, the second one overlapping a third. */
async function startGraphAgent() {
  const server: Server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ type: "RUN_STARTED", threadId: "t", runId: "r" });
    send({ type: "STEP_STARTED", stepName: "planner" });
    send({ type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "search" });
    send({ type: "TOOL_CALL_END", toolCallId: "t1" });
    send({ type: "STATE_DELTA", delta: [{ op: "add", path: "/plan", value: "x" }] });
    send({ type: "STEP_FINISHED", stepName: "planner" });
    send({ type: "STEP_STARTED", stepName: "writer" });
    send({ type: "STEP_STARTED", stepName: "critic" });
    send({ type: "STATE_SNAPSHOT", snapshot: { plan: "x" } });
    send({ type: "STEP_FINISHED", stepName: "critic" });
    send({ type: "STEP_FINISHED", stepName: "writer" });
    send({ type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" });
    send({ type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "done" });
    send({ type: "TEXT_MESSAGE_END", messageId: "m" });
    send({ type: "RUN_FINISHED", threadId: "t", runId: "r" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let sandbox: RunningSandbox;
let writer: Awaited<ReturnType<typeof startSlowWriteServer>>;
let base: string;
const closers: Array<() => Promise<void>> = [];

const api = async (pathname: string, body?: unknown) => {
  const res = await fetch(`${base}${pathname}`, {
    method: body ? "POST" : "GET",
    headers: { "x-moka-token": "t", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.text();
};
const json = async (pathname: string, body?: unknown) => JSON.parse(await api(pathname, body));
const events = (): MokaEvent[] => sandbox.engine.bus.history();
const byId = (id?: string) => events().find((e) => e.id === id);

beforeAll(async () => {
  const slow = await startSlowServer();
  const model = await startRepeatingModel();
  const agent = await startGraphAgent();
  writer = await startSlowWriteServer();
  const retrier = await startRetryingModel();
  closers.push(slow.close, model.close, agent.close, writer.close, retrier.close);
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-tracing-"));
  const configPath = path.join(home, "moka.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      llms: [
        { id: "rep", name: "Repeater", provider: "openai-compatible", model: "m", baseURL: model.baseURL },
        { id: "retry", name: "Retrier", provider: "openai-compatible", model: "m", baseURL: retrier.baseURL },
      ],
      mcpServers: [
        { id: "moka-demo", name: "Demo", transport: "stdio", command: "moka:demo" },
        { id: "slow", name: "Slow", transport: "http", url: slow.url, oauth: false },
        { id: "wr", name: "Writer", transport: "http", url: writer.url, oauth: false, toolTimeoutMs: 150 },
      ],
      agents: [{ id: "graph", name: "Graph", protocol: "ag-ui", url: agent.url }],
      workspaces: [
        { id: "w", name: "W", llmId: "rep", mcpServerIds: ["moka-demo"], skillIds: [], generativeUi: false },
        { id: "retry", name: "Retry", llmId: "retry", mcpServerIds: ["wr"], skillIds: [], generativeUi: false },
        { id: "flaky", name: "Flaky", llmId: "retry", mcpServerIds: ["moka-demo"], skillIds: [], generativeUi: false },
      ],
    }),
  );
  sandbox = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
  base = `http://127.0.0.1:${sandbox.port}`;
}, 30_000);

afterAll(async () => {
  await sandbox?.close();
  await Promise.all(closers.map((c) => c()));
});

describe("request/response pairing", () => {
  it("links each response to its request with the latency", async () => {
    await json("/api/mcp/moka-demo/call", { tool: "get_time", args: {} });
    const request = events().filter((e) => e.kind === "mcp.rpc" && e.rpc?.method === "tools/call" && !e.rpc.pairId).at(-1)!;
    expect(request.direction).toBe("out");
    const response = events().find((e) => e.rpc?.pairId === request.id)!;
    expect(response).toMatchObject({ kind: "mcp.rpc", direction: "in", rpc: { id: request.rpc!.id, method: "tools/call", outcome: "ok" } });
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
    expect(response.title).toBe(`result #${request.rpc!.id} · tools/call`);
  }, 20_000);

  it("marks a request that never got an answer when the server dies mid-call", async () => {
    const note = `note-${Date.now()}`;
    const res = await json("/api/mcp/moka-demo/call", { tool: "flaky_write", args: { note } });
    expect(JSON.stringify(res)).toMatch(/closed|error/i);
    const marker = events().filter((e) => e.kind === "mcp.unanswered").at(-1)!;
    expect(marker).toMatchObject({ level: "warn", serverId: "moka-demo", rpc: { method: "tools/call", outcome: "unanswered" } });
    expect(byId(marker.rpc!.pairId)).toMatchObject({ kind: "mcp.rpc", rpc: { method: "tools/call" } });
    expect(marker.title).toMatch(/^tools\/call #\d+: no response \(connection closed after/);
    // The write happened anyway, and Moka reconnects on the next use.
    await json("/api/mcp/moka-demo/connect", {});
    const notes = await json("/api/mcp/moka-demo/resource", { uri: "moka://notes" });
    expect(JSON.stringify(notes)).toContain(note);
  }, 20_000);

  it("shows a cancellation and the late reply that followed it", async () => {
    await json("/api/mcp/slow/connect", {});
    const controller = new AbortController();
    setTimeout(() => controller.abort("stop"), 100);
    await expect(sandbox.engine.mcp.callTool("slow", "slow", {}, { signal: controller.signal })).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 600));
    const request = events().filter((e) => e.serverId === "slow" && e.rpc?.method === "tools/call" && !e.rpc.pairId).at(-1)!;
    const answers = events().filter((e) => e.rpc?.pairId === request.id);
    expect(answers.map((a) => a.rpc!.outcome)).toEqual(["cancelled", "late"]);
    expect(answers[0]).toMatchObject({ direction: "out", title: `notifications/cancelled → tools/call #${request.rpc!.id}` });
    expect(answers[1]).toMatchObject({ direction: "in", level: "warn", title: `late result #${request.rpc!.id} · tools/call` });
    // The late reply is in the RPC log, not reported again as an error.
    expect(events().some((e) => e.kind === "mcp.log" && /unknown message ID/.test(e.title))).toBe(false);
  }, 20_000);
});

describe("duplicate writes", () => {
  it("warns when a tool that may write is called twice with the same arguments", async () => {
    const chunks = (await api("/api/chat", { messages: [{ role: "user", content: "book Toit" }] }))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const calls = chunks.filter((c) => c.type === "tool-call");
    expect(calls.map((c) => [c.tool, c.duplicateOf ?? null])).toEqual([
      ["book_table", null],
      ["book_table", "call_0"],
      ["get_time", null],
      ["get_time", null],
    ]);
    const warned = events().filter((e) => e.kind === "tool.call" && e.level === "warn");
    expect(warned.at(-1)).toMatchObject({ title: "Demo › book_table · same call again", data: { id: "call_1", duplicateOf: "call_0" } });
    // Key order doesn't matter, and a read-only repeat is an attempt, not a warning.
    expect(calls.map((c) => [c.lineage.id, c.lineage.attempt])).toEqual([
      ["call_0", 1],
      ["call_0", 2],
      ["call_2", 1],
      ["call_2", 2],
    ]);
    expect(events().filter((e) => e.kind === "tool.call").at(-1)!.title).toBe("Demo › get_time · attempt 2");
  }, 30_000);
});

describe("retry lineage", () => {
  it("groups a retry after a timeout under one lineage and flags the possible double write", async () => {
    const chunks = (await api("/api/chat", { workspaceId: "retry", messages: [{ role: "user", content: "save a note" }] }))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const calls = chunks.filter((c) => c.type === "tool-call");
    const results = chunks.filter((c) => c.type === "tool-result");
    expect(calls.map((c) => c.lineage)).toEqual([
      { id: "save_0", attempt: 1, fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/) },
      { id: "save_0", attempt: 2, fingerprint: calls[0].lineage.fingerprint },
    ]);
    // The first attempt timed out: nobody knows whether the note was saved…
    expect(results[0]).toMatchObject({ id: "save_0", isError: true, errorClass: "timeout", outcomeUnknown: true });
    // …and the retry succeeded, so it may have been saved twice.
    expect(results[1]).toMatchObject({ id: "save_1", isError: false, possibleDoubleWrite: true });

    const run = events().filter((e) => e.runId && e.runId === events().find((x) => x.kind === "tool.call" && (x.data as any)?.id === "save_1")?.runId);
    const titles = run.filter((e) => e.kind.startsWith("tool.")).map((e) => [e.kind, e.level ?? "info", e.title]);
    expect(titles).toEqual([
      ["tool.call", "info", "Writer › save"],
      ["tool.error", "error", "save ✗ timeout · outcome unknown (the write may have happened)"],
      ["tool.call", "warn", "Writer › save · retry after an unknown outcome (attempt 2)"],
      ["tool.result", "warn", "save ✓ · may have run twice (an earlier attempt's outcome is unknown)"],
    ]);
    expect(run.find((e) => e.kind === "tool.call" && (e.data as any).id === "save_1")!.data).toMatchObject({ duplicateOf: "save_0" });
    // The arguments exactly as the model streamed them.
    expect(run.find((e) => e.kind === "tool.call")!.data).toMatchObject({ input: { note: "buy milk" }, rawInput: '{"note":"buy milk"}' });

    // The raw tools/call requests, and what happened to them, point at their tool call.
    const wire = events().filter((e) => e.serverId === "wr" && e.rpc?.method === "tools/call");
    const requests = wire.filter((e) => !e.rpc!.pairId);
    expect(requests.map((e) => e.rpc!.callId)).toEqual(["save_0", "save_1"]);
    const gaveUp = wire.find((e) => e.rpc!.reason === "timeout")!;
    expect(gaveUp.rpc).toMatchObject({ callId: "save_0", outcome: "cancelled", pairId: requests[0]!.id });

    // The server did save it twice.
    await new Promise((r) => setTimeout(r, 500));
    expect(writer.saved).toEqual(["buy milk", "buy milk"]);
    expect(events().some((e) => e.kind === "mcp.log" && e.serverId === "wr")).toBe(false);
  }, 30_000);

  it("doesn't warn about retrying an idempotent write", async () => {
    const chunks = (await api("/api/chat", { workspaceId: "retry", messages: [{ role: "user", content: "set the status" }] }))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const results = chunks.filter((c) => c.type === "tool-result");
    // Still unknown whether the first call landed…
    expect(results[0]).toMatchObject({ id: "status_0", errorClass: "timeout", outcomeUnknown: true });
    // …but repeating it is harmless.
    expect(results[1]).toMatchObject({ id: "status_1", isError: false });
    expect(results[1].possibleDoubleWrite).toBeUndefined();
    const retry = events().filter((e) => e.kind === "tool.call" && (e.data as any).id === "status_1")[0]!;
    expect(retry).toMatchObject({ title: "Writer › set_status · attempt 2 (idempotent)" });
    expect(retry.level).toBeUndefined();
    expect((retry.data as any).duplicateOf).toBeUndefined();
  }, 30_000);

  it("keeps the raw arguments when the model sends broken JSON", async () => {
    const chunks = (await api("/api/chat", { workspaceId: "retry", messages: [{ role: "user", content: "truncated" }] }))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(chunks.find((c) => c.type === "tool-result")).toMatchObject({ id: "cut_0", isError: true, errorClass: "input" });
    const call = events().filter((e) => e.kind === "tool.call" && (e.data as any).id === "cut_0")[0]!;
    expect(call.data).toMatchObject({ rawInput: '{"note":"buy mi', invalid: true });
    // Nothing reached the server.
    expect(events().some((e) => e.rpc?.callId === "cut_0")).toBe(false);
  }, 30_000);

  it("tells the model a write may have happened, and brings a crashed server back", async () => {
    const chunks = (await api("/api/chat", { workspaceId: "flaky", messages: [{ role: "user", content: "flaky save" }] }))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const result = chunks.find((c) => c.type === "tool-result");
    expect(result).toMatchObject({ id: "flaky_0", isError: true, errorClass: "transport", outcomeUnknown: true });
    // The model is told, so it doesn't claim the save failed.
    expect(result.output).toMatch(/connection broke before it answered, so the tool may have run\. Check whether it did before retrying\.$/);
    // The server shows as disconnected, not as one Moka couldn't reach…
    await new Promise((r) => setTimeout(r, 300));
    expect(sandbox.engine.mcp.state("moka-demo")).toMatchObject({ status: "disconnected", error: expect.stringMatching(/closed the connection/) });
    // …and the next call starts it again by itself, so the note can be checked.
    const notes = await sandbox.engine.mcp.callTool("moka-demo", "read_notes", {});
    expect(JSON.stringify(notes.content)).toContain("flaky note");
    expect(sandbox.engine.mcp.state("moka-demo")?.status).toBe("connected");
  }, 30_000);

  it("classifies tool errors", async () => {
    // Not connected: nothing was sent, so the outcome is known.
    const error = await sandbox.engine.mcp.callTool("nope", "save", {}).catch((e) => e);
    expect(error).toMatchObject({ errorClass: "transport", notSent: true });
    // The server answered with a JSON-RPC error.
    const rejected = await sandbox.engine.mcp.callTool("wr", "erase", {}).catch((e) => e);
    expect(rejected).toMatchObject({ errorClass: "protocol", code: -32602 });
    // The server crashed mid-call (it saved the note first): the transport broke, so the outcome is unknown.
    await json("/api/mcp/moka-demo/connect", {});
    const crashed = await sandbox.engine.mcp.callTool("moka-demo", "flaky_write", { note: "crash test" }).catch((e) => e);
    expect(crashed).toMatchObject({ errorClass: "transport" });
    expect(crashed.notSent).toBeUndefined();
    await json("/api/mcp/moka-demo/connect", {});
    // Stopped by the user.
    await json("/api/mcp/slow/connect", {});
    const stopped = await sandbox.engine.mcp.callTool("slow", "slow", {}, { signal: AbortSignal.abort("stop") }).catch((e) => e);
    expect(stopped).toMatchObject({ errorClass: "cancelled" });
  }, 20_000);
});

describe("AG-UI node grouping", () => {
  it("nests events under the step that emitted them", async () => {
    await api("/api/chat", { agentId: "graph", messages: [{ role: "user", content: "go" }] });
    const runId = events().filter((e) => e.kind === "agent.request").at(-1)!.runId;
    const run = events().filter((e) => e.runId === runId && e.kind === "agent.event");
    const parentTitle = (title: string) => byId(run.find((e) => e.title === title)!.parentId)?.title;
    expect(parentTitle("AG-UI TOOL_CALL_START · search")).toBe("AG-UI STEP_STARTED · planner");
    expect(parentTitle("AG-UI STATE_DELTA")).toBe("AG-UI STEP_STARTED · planner");
    expect(parentTitle("AG-UI STEP_FINISHED · planner")).toBe("AG-UI STEP_STARTED · planner");
    // A node that starts while another is running is flagged, and its events go to the innermost one.
    expect(run.find((e) => e.title.startsWith("AG-UI STEP_STARTED · critic"))!.title).toBe("AG-UI STEP_STARTED · critic · overlaps writer");
    expect(parentTitle("AG-UI STATE_SNAPSHOT")).toBe("AG-UI STEP_STARTED · critic · overlaps writer");
    expect(parentTitle("AG-UI STEP_FINISHED · writer")).toBe("AG-UI STEP_STARTED · writer");
    expect(run.find((e) => e.title === "AG-UI RUN_FINISHED")!.parentId).toBeUndefined();
    expect(run.find((e) => e.title === "AG-UI STEP_FINISHED · planner")!.durationMs).toBeGreaterThanOrEqual(0);
  }, 20_000);
});
