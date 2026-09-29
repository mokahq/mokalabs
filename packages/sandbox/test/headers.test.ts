import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { maskHeaderValue, maskUrl, tracingFetch, type HttpExchange } from "@mokalabs/core";
import { startSandbox, type RunningSandbox } from "../src/index.js";

/** An MCP server that authenticates with a key pair in two headers. */
async function startKeyPairServer() {
  const seen: Array<Record<string, string | string[] | undefined>> = [];
  const readBody = async (req: IncomingMessage) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw;
  };
  const server: Server = createServer(async (req, res) => {
    seen.push(req.headers);
    if (req.headers["x-api-key"] !== "pub-key-123" || req.headers["x-api-secret"] !== "very-secret-value-456") {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'ApiKey realm="quant"' });
      return res.end(JSON.stringify({ error: "bad key pair" }));
    }
    const mcp = new McpServer({ name: "quant", version: "1.0.0" });
    mcp.registerTool("ping", { description: "Ping" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.method === "POST" ? JSON.parse(await readBody(req)) : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let sandbox: RunningSandbox;
let quant: Awaited<ReturnType<typeof startKeyPairServer>>;
let base: string;

const api = async (pathname: string, body?: unknown) => {
  const res = await fetch(`${base}${pathname}`, {
    method: body ? "POST" : "GET",
    headers: { "x-moka-token": "t", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<any>;
};

beforeAll(async () => {
  quant = await startKeyPairServer();
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-headers-"));
  const configPath = path.join(home, "moka.json");
  const server = (id: string, secret: string) => ({
    id,
    name: id,
    transport: "http",
    url: `${quant.origin}/mcp?tenant=acme`,
    headers: { "X-API-Key": "${QUANT_KEY}", "X-API-Secret": secret },
    oauth: false,
  });
  writeFileSync(
    configPath,
    JSON.stringify({ version: 1, mcpServers: [server("quant", "${QUANT_SECRET}"), server("wrong", "nope")], workspaces: [{ id: "w", name: "W" }] }),
  );
  const env = { ...process.env, MOKA_HOME: home, QUANT_KEY: "pub-key-123", QUANT_SECRET: "very-secret-value-456" };
  sandbox = await startSandbox({ port: 0, configPath, token: "t", env, ui: false });
  base = `http://127.0.0.1:${sandbox.port}`;
}, 30_000);

afterAll(async () => {
  await sandbox?.close();
  await quant?.close();
});

describe("masking", () => {
  it("keeps harmless values and hides secrets", () => {
    expect(maskHeaderValue("Content-Type", "application/json")).toBe("application/json");
    expect(maskHeaderValue("mcp-protocol-version", "2025-06-18")).toBe("2025-06-18");
    expect(maskHeaderValue("authorization", "Bearer abcdefghijklmnop")).toBe("Bearer abcd••• (16 chars)");
    expect(maskHeaderValue("x-api-secret", "short")).toBe("••• (5 chars)");
    expect(maskHeaderValue("mcp-session-id", "0123456789abcdef")).toBe("01234567…");
    expect(maskUrl("https://x.dev/mcp?key=abc&tenant=acme")).toBe("https://x.dev/mcp?key=•••&tenant=•••");
  });
});

describe("tracing fetch", () => {
  it("records the endpoint only, and ignores an optional GET stream refused with 405", async () => {
    const seen: HttpExchange[] = [];
    const fake = async (url: string | URL, init?: RequestInit) =>
      new Response(null, { status: init?.method === "GET" ? 405 : 200, headers: { "mcp-session-id": "abcdef0123456789" } });
    const traced = tracingFetch({ endpoint: new URL("https://x.dev/mcp"), configured: { "X-Key": "k" }, onExchange: (e) => seen.push(e), fetch: fake });
    await traced("https://x.dev/.well-known/oauth-protected-resource", {});
    await traced("https://x.dev/mcp", { method: "GET" });
    await traced("https://x.dev/mcp", { method: "POST", headers: { "X-Key": "a-long-secret-value" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", status: 200, configured: ["x-key"], requestHeaders: { "x-key": "a-lo••• (19 chars)" }, responseHeaders: { "mcp-session-id": "abcdef01…" } });
  });
});

describe("HTTP headers", () => {
  it("sends every configured header and shows them masked", async () => {
    const { state } = await api("/api/mcp/quant/connect", {});
    expect(state.status).toBe("connected");
    // Both headers of the key pair reached the server.
    expect(quant.seen.at(-1)).toMatchObject({ "x-api-key": "pub-key-123", "x-api-secret": "very-secret-value-456" });

    const http = state.http;
    expect(http).toMatchObject({ method: "POST", status: 200, configured: ["x-api-key", "x-api-secret"] });
    expect(http.url).toBe(`${quant.origin}/mcp?tenant=•••`);
    expect(http.requestHeaders["x-api-key"]).toBe("••• (11 chars)");
    expect(http.requestHeaders["x-api-secret"]).toBe("very••• (21 chars)");
    expect(http.requestHeaders["mcp-protocol-version"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(http)).not.toContain("very-secret-value-456");
  }, 20_000);

  it("explains a rejected key pair with the HTTP status and an inspector event", async () => {
    const { state } = await api("/api/mcp/wrong/connect", {});
    expect(state.status).toBe("error");
    expect(state.error).toContain("401");
    expect(state.http).toMatchObject({ status: 401, responseHeaders: { "www-authenticate": 'ApiKey realm="quant"' } });
    const event = sandbox.engine.bus.history().find((e) => e.kind === "mcp.http" && e.serverId === "wrong");
    expect(event).toMatchObject({ level: "error", title: "wrong: HTTP 401 on POST /mcp" });
    expect(JSON.stringify(event)).not.toContain("nope");
  }, 20_000);
});
