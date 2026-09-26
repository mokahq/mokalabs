import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash } from "node:crypto";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSandbox, type RunningSandbox } from "../src/index.js";

/** A tiny OAuth 2.1 authorization server + protected MCP server (spec-shaped). */
async function startProtectedServer() {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const registrations: any[] = [];
  let origin = "";
  const readBody = async (req: IncomingMessage) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw;
  };
  const json = (res: any, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const metadata = JSON.parse(await readBody(req));
      registrations.push(metadata);
      return json(res, 201, { ...metadata, client_id: `client-${registrations.length}` });
    }
    if (url.pathname === "/authorize") {
      // A real server shows a login page; the test grabs the params instead.
      const code = `code-${codes.size + 1}`;
      codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect: url.searchParams.get("redirect_uri")! });
      res.writeHead(302, { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${url.searchParams.get("state")}` });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const entry = codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!entry || entry.challenge !== challenge || entry.redirect !== form.get("redirect_uri")) return json(res, 400, { error: "invalid_grant" });
      return json(res, 200, { access_token: "secret-token", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh" });
    }
    if (url.pathname === "/mcp") {
      if (req.headers.authorization !== "Bearer secret-token") {
        return json(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
      }
      const mcp = new McpServer({ name: "secure", version: "1.0.0" });
      mcp.registerTool("whoami", { description: "Who am I" }, async () => ({ content: [{ type: "text", text: "you are signed in" }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcp.connect(transport);
      const body = req.method === "POST" ? JSON.parse(await readBody(req)) : undefined;
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, registrations, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let sandbox: RunningSandbox;
let protectedServer: Awaited<ReturnType<typeof startProtectedServer>>;
let base: string;
let home: string;

const api = async (pathname: string, body?: unknown) => {
  const res = await fetch(`${base}${pathname}`, {
    method: body ? "POST" : "GET",
    headers: { "x-moka-token": "t", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<any>;
};

beforeAll(async () => {
  protectedServer = await startProtectedServer();
  home = mkdtempSync(path.join(os.tmpdir(), "moka-oauth-"));
  const configPath = path.join(home, "moka.json");
  writeFileSync(
    configPath,
    JSON.stringify({ version: 1, mcpServers: [{ id: "secure", name: "Secure", transport: "http", url: `${protectedServer.origin}/mcp` }], workspaces: [{ id: "w", name: "W" }] }),
  );
  sandbox = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
  base = `http://127.0.0.1:${sandbox.port}`;
}, 30_000);

afterAll(async () => {
  await sandbox?.close();
  await protectedServer?.close();
});

describe("MCP OAuth", () => {
  it("asks the user to sign in, with PKCE and a registered client", async () => {
    const { state } = await api("/api/mcp/secure/connect", {});
    expect(state.status).toBe("auth");
    const authUrl = new URL(state.authUrl);
    expect(authUrl.origin + authUrl.pathname).toBe(`${protectedServer.origin}/authorize`);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(`http://localhost:${sandbox.port}/oauth/callback`);
    expect(authUrl.searchParams.get("state")).toMatch(/^secure\./);
    expect(protectedServer.registrations[0]).toMatchObject({ client_name: "Moka", redirect_uris: [`http://localhost:${sandbox.port}/oauth/callback`] });
  }, 20_000);

  it("finishes sign-in on the callback and connects", async () => {
    const { state } = await api("/api/mcp/secure/connect", { force: true });
    // Follow the provider's redirect back to Moka, like a browser would.
    const redirect = await fetch(state.authUrl, { redirect: "manual" });
    const callback = redirect.headers.get("location")!.replace("localhost", "127.0.0.1");
    const page = await fetch(callback);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Signed in to Secure");
    const { servers } = await api("/api/mcp");
    const secure = servers.find((s: any) => s.id === "secure");
    expect(secure).toMatchObject({ status: "connected", oauth: { signedIn: true } });
    expect(secure.tools.map((t: any) => t.name)).toEqual(["whoami"]);
    const call = await api("/api/mcp/secure/call", { tool: "whoami", args: {} });
    expect(call.result.content[0].text).toBe("you are signed in");
    // POSIX permissions only; Windows always reports 0o666 and relies on the user-profile ACL.
    if (process.platform !== "win32") expect(statSync(path.join(home, "oauth.json")).mode & 0o777).toBe(0o600);
  }, 20_000);

  it("reuses stored tokens and signs out", async () => {
    const again = await api("/api/mcp/secure/connect", { force: true });
    expect(again.state.status).toBe("connected");
    const out = await api("/api/mcp/secure/signout", {});
    expect(out.state.status).toBe("auth");
  }, 20_000);

  it("rejects unknown callbacks", async () => {
    const res = await fetch(`${base}/oauth/callback?code=x&state=nope`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Sign-in failed");
  });
});
