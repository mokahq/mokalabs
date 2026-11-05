import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startSandbox, typeStrippingFlags } from "../src/index.js";

const canRunTs = typeStrippingFlags() !== undefined;

describe("Server Studio", () => {
  it("knows when Node can run TypeScript", () => {
    expect(typeStrippingFlags("20.19.0", {})).toBeUndefined();
    expect(typeStrippingFlags("22.12.0", {})).toContain("--experimental-strip-types");
    expect(typeStrippingFlags("24.1.0", { typescript: "strip" })).not.toContain("--experimental-strip-types");
  });

  // Node before 22.15 has no synchronous module hooks; MOKA_STUDIO_ASYNC_HOOKS=1 takes that path on any Node.
  it.runIf(canRunTs).each([["sync module hooks", "0"], ["async hooks, as on Node before 22.15", "1"]])("starts a template server with %s", async (_label, asyncHooks) => {
    const home = mkdtempSync(path.join(os.tmpdir(), "moka-studio-hooks-"));
    const configPath = path.join(home, "moka.json");
    writeFileSync(configPath, JSON.stringify({ version: 1, llms: [], mcpServers: [], workspaces: [{ id: "w", name: "W", mcpServerIds: [], skillIds: [] }] }));
    const sb = await startSandbox({ port: 0, configPath, token: false, env: { ...process.env, MOKA_HOME: home }, ui: false });
    try {
      const res = await fetch(`http://127.0.0.1:${sb.port}/api/studio/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Hooks" }) });
      const { serverId } = await res.json();
      const config = sb.engine.getConfig();
      await sb.engine.setConfig({ ...config, mcpServers: config.mcpServers.map((s) => (s.id === serverId ? { ...s, env: { MOKA_STUDIO_ASYNC_HOOKS: asyncHooks } } : s)) });
      const state = await sb.engine.mcp.ensure(sb.engine.getConfig().mcpServers.find((s) => s.id === serverId)!);
      expect(state.status, `${state.error ?? ""}\n${(state.stderr ?? []).join("\n")}`).toBe("connected");
      expect((await sb.engine.mcp.callTool(serverId, "greet", { name: "Ada" })).content).toEqual([{ type: "text", text: "Hello, Ada!" }]);
    } finally {
      await sb.close();
    }
  }, 60_000);

  it.runIf(canRunTs)("creates a server from a template, reloads it on save, and exports it", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "moka-studio-"));
    const configPath = path.join(home, "moka.json");
    writeFileSync(configPath, JSON.stringify({ version: 1, llms: [], mcpServers: [], workspaces: [{ id: "w", name: "W", mcpServerIds: [], skillIds: [] }] }));
    const sb = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
    const api = async (p: string, init: { method?: string; body?: unknown } = {}) => {
      const res = await fetch(`http://127.0.0.1:${sb.port}${p}`, { method: init.method ?? (init.body ? "POST" : "GET"), headers: { "x-moka-token": "t", "content-type": "application/json" }, body: init.body ? JSON.stringify(init.body) : undefined });
      return { status: res.status, json: res.headers.get("content-type")?.includes("json") ? await res.json() : undefined, res };
    };
    const waitFor = async (check: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 100; i++) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("timed out");
    };
    try {
      const created = await api("/api/studio/create", { body: { name: "My Tools", template: "blank" } });
      expect(created.status).toBe(200);
      const { serverId, dir } = created.json;
      expect(dir).toBe(path.join(home, "studio", "my-tools"));
      expect(sb.engine.workspace("w").mcpServerIds).toContain(serverId);
      const server = () => sb.engine.getConfig().mcpServers.find((s) => s.id === serverId)!;
      let state = await sb.engine.mcp.ensure(server());
      expect(state.status, `${state.error ?? ""}\n${(state.stderr ?? []).join("\n")}`).toBe("connected");
      expect(state.tools.map((t) => t.name)).toEqual(["greet"]);
      const hello = await sb.engine.mcp.callTool(serverId, "greet", { name: "Ada" });
      expect(hello.content).toEqual([{ type: "text", text: "Hello, Ada!" }]);

      // Save a change: the server restarts with the new tool.
      const source = (await api(`/api/studio/file?dir=${encodeURIComponent(dir)}&path=server.ts`)).json.content as string;
      const edited = source.replace('"greet"', '"say_hello"');
      expect((await api("/api/studio/file", { method: "PUT", body: { dir, path: "server.ts", content: edited } })).status).toBe(200);
      await waitFor(async () => (await sb.engine.mcp.ensure(server())).tools.some((t) => t.name === "say_hello"));
      expect(sb.engine.bus.history().some((e) => e.title.startsWith("Studio: My Tools reloaded"))).toBe(true);

      // Can't write outside the folder, or outside Studio's folders.
      expect((await api("/api/studio/file", { method: "PUT", body: { dir, path: "../evil.ts", content: "x" } })).status).toBe(400);
      expect((await api("/api/studio/file", { method: "PUT", body: { dir: os.tmpdir(), path: "x.ts", content: "x" } })).status).toBe(400);

      // Export: a zip with the server plus package.json, tsconfig and README.
      const exported = await api(`/api/studio/export?dir=${encodeURIComponent(dir)}`);
      expect(exported.res.headers.get("content-type")).toBe("application/zip");
      const zipPath = path.join(home, "out.zip");
      writeFileSync(zipPath, Buffer.from(await exported.res.arrayBuffer()));
      const listing = execFileSync("python3", ["-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print('\\n'.join(z.namelist()));print(z.read('my-tools/package.json').decode())", zipPath]).toString();
      expect(listing).toContain("my-tools/server.ts");
      expect(listing).toContain("my-tools/tsconfig.json");
      expect(listing).toContain("my-tools/README.md");
      expect(listing).toContain('"@modelcontextprotocol/server"');

      // The other templates start too.
      for (const template of ["http-api", "files"]) {
        const made = await api("/api/studio/create", { body: { name: `T ${template}`, template } });
        state = await sb.engine.mcp.ensure(sb.engine.getConfig().mcpServers.find((s) => s.id === made.json.serverId)!);
        expect(state.status, `${template}: ${state.error ?? ""} ${state.stderr?.join("\n") ?? ""}`).toBe("connected");
        expect(state.tools.length).toBeGreaterThan(0);
      }
      const files = (await api("/api/studio")).json;
      expect(files.projects).toHaveLength(3);
      expect(readFileSync(path.join(dir, "server.ts"), "utf8")).toContain("say_hello");
    } finally {
      await sb.close();
    }
  }, 60_000);

  it.runIf(canRunTs)("shows a syntax error with its line", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "moka-studio-err-"));
    const configPath = path.join(home, "moka.json");
    writeFileSync(configPath, JSON.stringify({ version: 1, llms: [], mcpServers: [], workspaces: [{ id: "w", name: "W", mcpServerIds: [], skillIds: [] }] }));
    const sb = await startSandbox({ port: 0, configPath, token: false, env: { ...process.env, MOKA_HOME: home }, ui: false });
    try {
      const res = await fetch(`http://127.0.0.1:${sb.port}/api/studio/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Broken" }) });
      const { serverId, dir } = await res.json();
      writeFileSync(path.join(dir, "server.ts"), 'import { z } from "zod";\nconst x = ;\n');
      const state = await sb.engine.mcp.reconnect(sb.engine.getConfig().mcpServers.find((s) => s.id === serverId)!);
      expect(state.status).not.toBe("connected");
      expect((state.stderr ?? []).join("\n")).toMatch(/server\.ts:2/);
    } finally {
      await sb.close();
    }
  }, 60_000);
});
