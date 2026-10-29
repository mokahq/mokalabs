import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionRecord } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "dist", "cli.js");

const readBody = async (req: IncomingMessage) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
};

function buildServer(name: string) {
  const mcp = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: `echo: ${(request.params.arguments as any)?.text}` }] }));
  return mcp;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

/** Streamable HTTP with sessions (like Jira/MongoDB MCP servers), behind an API key; sessions can be expired. */
async function startStreamable() {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const seen = { auth: [] as (string | undefined)[], initializes: 0, deletes: 0 };
  const server = createServer(async (req, res) => {
    seen.auth.push(req.headers.authorization);
    if (req.headers.authorization !== "Bearer jira-token") {
      res.writeHead(401).end("unauthorized");
      return;
    }
    if (req.method === "DELETE") seen.deletes++;
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (sid) {
      const transport = sessions.get(sid);
      if (!transport) return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
      return transport.handleRequest(req, res, body);
    }
    if (body?.method !== "initialize") return void res.writeHead(400).end("no session");
    seen.initializes++;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => void sessions.set(id, transport) });
    await buildServer("jira").connect(transport);
    await transport.handleRequest(req, res, body);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen, expire: () => sessions.clear() };
}

/** The older HTTP+SSE transport. */
async function startSse() {
  const transports = new Map<string, SSEServerTransport>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    if (req.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      await buildServer("legacy").connect(transport);
      return;
    }
    const transport = transports.get(url.searchParams.get("sessionId") ?? "");
    if (!transport) return void res.writeHead(404).end();
    await transport.handlePostMessage(req, res, await readBody(req));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sse` };
}

async function connectThroughProxy(home: string, args: string[], env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, ...args], env: { ...process.env, MOKA_HOME: home, ...env } as Record<string, string>, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const client = new Client({ name: "vscode-ish", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

const records = (home: string): SessionRecord[] => {
  const dir = path.join(home, "proxy", "sessions");
  const [file] = readdirSync(dir);
  return readFileSync(path.join(dir, file!), "utf8").trim().split("\n").map((l) => JSON.parse(l));
};

describe("proxy for HTTP servers", () => {
  it("bridges stdio to Streamable HTTP with the headers, and records the session", async () => {
    const jira = await startStreamable();
    const home = mkdtempSync(path.join(os.tmpdir(), "moka-proxy-http-"));
    const { client } = await connectThroughProxy(home, ["--client", "vscode", "--name", "jiramcp", "--url", jira.url], { MOKA_PROXY_HEADER_1: "Authorization: Bearer jira-token" });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    expect((await client.callTool({ name: "echo", arguments: { text: "hi" } })).content).toEqual([{ type: "text", text: "echo: hi" }]);
    await client.close();
    await new Promise((r) => setTimeout(r, 400));

    const log = records(home);
    expect(log[0]).toMatchObject({ type: "start", client: "vscode", name: "jiramcp", url: jira.url, transport: "http" });
    const msgs = log.filter((r): r is Extract<SessionRecord, { type: "msg" }> => r.type === "msg").map((m) => [m.dir, (m.msg as any).method ?? `result #${(m.msg as any).id}`]);
    expect(msgs).toEqual([
      ["out", "initialize"],
      ["in", "result #0"],
      ["out", "notifications/initialized"],
      ["out", "tools/list"],
      ["in", "result #1"],
      ["out", "tools/call"],
      ["in", "result #2"],
    ]);
    expect(jira.seen.auth.every((a) => a === "Bearer jira-token")).toBe(true);
    expect(jira.seen.deletes).toBe(1); // the session is closed when the editor stops the server
  }, 20_000);

  it("opens a new session when the server forgets the old one, without the editor noticing", async () => {
    const jira = await startStreamable();
    const home = mkdtempSync(path.join(os.tmpdir(), "moka-proxy-http-"));
    const { client, stderr } = await connectThroughProxy(home, ["--url", jira.url], { MOKA_PROXY_HEADER_1: "Authorization: Bearer jira-token" });
    expect((await client.callTool({ name: "echo", arguments: { text: "one" } })).content).toEqual([{ type: "text", text: "echo: one" }]);
    jira.expire();
    expect((await client.callTool({ name: "echo", arguments: { text: "two" } })).content).toEqual([{ type: "text", text: "echo: two" }]);
    expect(jira.seen.initializes).toBe(2);
    expect(stderr()).toMatch(/session expired on the server/);
    await client.close();
  }, 20_000);

  it("turns an HTTP error into a JSON-RPC error the editor can show", async () => {
    const jira = await startStreamable();
    const home = mkdtempSync(path.join(os.tmpdir(), "moka-proxy-http-"));
    await expect(connectThroughProxy(home, ["--url", jira.url], { MOKA_PROXY_HEADER_1: "Authorization: Bearer wrong" })).rejects.toThrow(/HTTP 401/);
  }, 20_000);

  it("bridges the older HTTP+SSE transport", async () => {
    const legacy = await startSse();
    const home = mkdtempSync(path.join(os.tmpdir(), "moka-proxy-sse-"));
    const { client } = await connectThroughProxy(home, ["--name", "legacy", "--url", legacy.url, "--transport", "sse"]);
    expect((await client.callTool({ name: "echo", arguments: { text: "old" } })).content).toEqual([{ type: "text", text: "echo: old" }]);
    await client.close();
  }, 20_000);
});
