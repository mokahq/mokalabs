import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSandbox, type RunningSandbox } from "../src/index.js";
import { expandTemplate, templateVariables } from "../web/src/uriTemplate.js";

let sandbox: RunningSandbox;
let base: string;

const api = async (pathname: string, body?: unknown) => {
  const res = await fetch(`${base}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-moka-token": "t", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
};

const updates = () => sandbox.engine.bus.history().filter((e) => e.kind === "resource.updated");

async function waitFor(check: () => boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-res-"));
  const configPath = path.join(home, "moka.json");
  writeFileSync(configPath, JSON.stringify({ version: 1, mcpServers: [{ id: "demo", name: "Demo", transport: "stdio", command: "moka:demo" }], workspaces: [{ id: "w", name: "W" }] }));
  sandbox = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
  base = `http://127.0.0.1:${sandbox.port}`;
}, 30_000);

afterAll(async () => {
  await sandbox?.close();
});

describe("MCP resources", () => {
  it("lists resources, templates and subscribe support", async () => {
    const { state } = (await api("/api/mcp/demo/connect", {})).json;
    expect(state.canSubscribe).toBe(true);
    expect(state.resources.map((r: any) => r.uri)).toEqual(expect.arrayContaining(["moka://about", "moka://brew/status"]));
    expect(state.resourceTemplates.map((t: any) => t.uriTemplate)).toContain("moka://drinks/{drink}");
    expect(state.subscriptions).toEqual([]);
  }, 30_000);

  it("reads a templated resource", async () => {
    const { json } = await api("/api/mcp/demo/resource", { uri: "moka://drinks/espresso" });
    expect(JSON.parse(json.result.contents[0].text)).toMatchObject({ drink: "espresso", caffeineMg: 63 });
  });

  it("subscribes and receives resources/updated notifications", async () => {
    const res = await api("/api/mcp/demo/subscribe", { uri: "moka://brew/status" });
    expect(res.json.subscriptions).toEqual(["moka://brew/status"]);
    await waitFor(() => updates().length > 0);
    expect(updates()[0]).toMatchObject({ serverId: "demo", data: { uri: "moka://brew/status" } });
    expect(sandbox.engine.bus.history().some((e) => e.kind === "mcp.rpc" && e.title.startsWith("resources/subscribe"))).toBe(true);
  }, 20_000);

  it("keeps subscriptions across reconnects", async () => {
    const { state } = (await api("/api/mcp/demo/connect", { force: true })).json;
    expect(state.subscriptions).toEqual(["moka://brew/status"]);
    const before = updates().length;
    await waitFor(() => updates().length > before);
  }, 20_000);

  it("unsubscribes", async () => {
    const res = await api("/api/mcp/demo/subscribe", { uri: "moka://brew/status", subscribe: false });
    expect(res.json.subscriptions).toEqual([]);
    const count = updates().length;
    await new Promise((r) => setTimeout(r, 3500));
    expect(updates().length).toBe(count);
  }, 20_000);
});

describe("URI templates", () => {
  it("finds variables and expands RFC 6570 expressions", () => {
    expect(templateVariables("db://{table}/rows{?limit,offset}")).toEqual(["table", "limit", "offset"]);
    expect(expandTemplate("moka://drinks/{drink}", { drink: "flat white" })).toBe("moka://drinks/flat%20white");
    expect(expandTemplate("file:///{+path}", { path: "src/a b.ts" })).toBe("file:///src/a%20b.ts");
    expect(expandTemplate("file:///{+path}", { path: "src/index.ts" })).toBe("file:///src/index.ts");
    expect(expandTemplate("db://{table}/rows{?limit,offset}", { table: "users", limit: "10" })).toBe("db://users/rows?limit=10");
    expect(expandTemplate("x{/a,b}", { a: "1", b: "2" })).toBe("x/1/2");
  });
});
