import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSandbox, type RunningSandbox } from "../src/index.js";

/**
 * A sessionful Streamable HTTP server, like MongoDB's MCP server: sessions live in
 * memory and expire when idle (or when the server restarts). After that, a request
 * with the old Mcp-Session-Id gets 404 "Session not found".
 */
async function startSessionServer() {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let initializes = 0;
  let calls = 0;
  const readBody = async (req: IncomingMessage) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : undefined;
  };
  const server: Server = createServer(async (req, res) => {
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const id = req.headers["mcp-session-id"] as string | undefined;
    if (id) {
      const transport = sessions.get(id);
      if (!transport) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32003, message: "session not found" }, id: null }));
      }
      return transport.handleRequest(req, res, body);
    }
    if (body?.method !== "initialize") {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no session" }, id: null }));
    }
    initializes++;
    const mcp = new McpServer({ name: "mongo-like", version: "1.0.0" });
    mcp.registerTool("list-collections", { description: "List collections" }, async () => {
      calls++;
      return { content: [{ type: "text", text: "users, orders" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (sid) => void sessions.set(sid, transport) });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    expireAll: () => sessions.clear(),
    stats: () => ({ initializes, calls }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let sandbox: RunningSandbox;
let mongo: Awaited<ReturnType<typeof startSessionServer>>;
let base: string;
const call = async (tool: string) =>
  (await fetch(`${base}/api/mcp/mongo/call`, { method: "POST", headers: { "x-moka-token": "t", "content-type": "application/json" }, body: JSON.stringify({ tool, args: {} }) })).json() as Promise<any>;

beforeAll(async () => {
  mongo = await startSessionServer();
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-session-"));
  const configPath = path.join(home, "moka.json");
  writeFileSync(configPath, JSON.stringify({ version: 1, llms: [], mcpServers: [{ id: "mongo", name: "Mongo MCP", transport: "http", url: mongo.url, oauth: false }], workspaces: [{ id: "w", name: "W", mcpServerIds: ["mongo"], skillIds: [] }] }));
  sandbox = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
  base = `http://127.0.0.1:${sandbox.port}`;
}, 30_000);

afterAll(async () => {
  await sandbox?.close();
  await mongo?.close();
});

describe("expired HTTP sessions", () => {
  it("starts a new session and retries when the server forgot the old one", async () => {
    expect((await call("list-collections")).result.content[0].text).toBe("users, orders");
    mongo.expireAll();
    const again = await call("list-collections");
    expect(again.error).toBeUndefined();
    expect(again.result.content[0].text).toBe("users, orders");
    expect(mongo.stats()).toEqual({ initializes: 2, calls: 2 });
    expect(sandbox.engine.bus.history().some((e) => /session expired/i.test(e.title))).toBe(true);
  }, 30_000);
});
