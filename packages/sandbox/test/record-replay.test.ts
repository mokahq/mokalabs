import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findRecorded, parseRecording, startSandbox } from "../src/index.js";

function setup(servers: unknown[]) {
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-rec-"));
  const configPath = path.join(home, "moka.json");
  writeFileSync(configPath, JSON.stringify({ version: 1, llms: [], mcpServers: servers, workspaces: [{ id: "w", name: "W", mcpServerIds: (servers as any[]).map((s) => s.id), skillIds: [] }] }));
  return { home, configPath };
}

describe("record and replay", () => {
  it("records a server's traffic and serves it back with moka:mock, in both MCP revisions", async () => {
    const { home, configPath } = setup([{ id: "moka-demo", name: "Demo", transport: "stdio", command: "moka:demo", protocol: "2025", record: true }]);
    const sb = await startSandbox({ port: 0, configPath, token: false, env: { ...process.env, MOKA_HOME: home }, ui: false });
    let file: string;
    try {
      const server = sb.engine.getConfig().mcpServers[0]!;
      await sb.engine.mcp.ensure(server);
      const tokyo = await sb.engine.mcp.callTool("moka-demo", "get_time", { timezone: "Asia/Tokyo" });
      expect(JSON.stringify(tokyo.content)).toMatch(/GMT\+9/);
      await sb.engine.mcp.callTool("moka-demo", "roll_dice", { sides: 6, count: 2 });
      await sb.engine.mcp.disconnect("moka-demo");
      const dir = path.join(home, "recordings", "moka-demo");
      file = path.join(dir, readdirSync(dir)[0]!);
    } finally {
      await sb.close();
    }

    const recording = parseRecording(readFileSync(file, "utf8"));
    expect(recording.tools.map((t) => t.name)).toContain("get_time");
    expect(findRecorded(recording, "tools/call", { name: "get_time", arguments: { timezone: "Asia/Tokyo" } })?.match).toBe("exact");
    expect(findRecorded(recording, "tools/call", { name: "roll_dice", arguments: { sides: 6, count: 3 } })?.match).toBe("partial");
    expect(findRecorded(recording, "tools/call", { name: "roll_dice", arguments: { sides: 8, count: 3 } })).toBeUndefined();
    expect(findRecorded(recording, "tools/call", { name: "roll_dice", arguments: { sides: 8, count: 3 } }, "last")?.match).toBe("last");

    for (const protocol of ["2025", "2026"]) {
      const replay = setup([{ id: "mock", name: "Mock", transport: "stdio", command: "moka:mock", args: [file], protocol }]);
      const mock = await startSandbox({ port: 0, configPath: replay.configPath, token: false, env: { ...process.env, MOKA_HOME: replay.home }, ui: false });
      try {
        const state = await mock.engine.mcp.ensure(mock.engine.getConfig().mcpServers[0]!);
        expect(state.status, `${protocol}: ${state.error ?? ""}`).toBe("connected");
        expect(state.tools.map((t) => t.name)).toEqual(recording.tools.map((t) => t.name));
        const again = await mock.engine.mcp.callTool("mock", "get_time", { timezone: "Asia/Tokyo" });
        expect(again.content).toEqual(recording.calls.find((c) => c.method === "tools/call" && c.params.name === "get_time")!.result.content);
        await expect(mock.engine.mcp.callTool("mock", "get_time", { timezone: "Europe/Paris" })).rejects.toThrow(/No recording for this call/);
      } finally {
        await mock.close();
      }
    }
  }, 60_000);
});

describe("fault injection", () => {
  it("delays, fails and marks injected faults in the inspector", async () => {
    const { home, configPath } = setup([{ id: "moka-demo", name: "Demo", transport: "stdio", command: "moka:demo", protocol: "2025", toolTimeoutMs: 1500, faults: { seed: 1, rules: [
      { tools: ["calculate"], delayMs: 300 },
      { tools: ["get_time"], fail: "tool-error" },
      { tools: ["generate_uuid"], fail: "error" },
      { tools: ["roll_dice"], fail: "malformed" },
      { tools: ["fetch_url"], fail: "hang" },
    ] } }]);
    const sb = await startSandbox({ port: 0, configPath, token: false, env: { ...process.env, MOKA_HOME: home }, ui: false });
    try {
      const server = sb.engine.getConfig().mcpServers[0]!;
      const state = await sb.engine.mcp.ensure(server);
      const names = state.tools.map((t) => t.name);
      const started = Date.now();
      const sum = await sb.engine.mcp.callTool("moka-demo", "calculate", { expression: "2+3" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(290);
      expect(JSON.stringify(sum.content)).toMatch(/5/);
      const failed = await sb.engine.mcp.callTool("moka-demo", "get_time", {});
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed.content)).toMatch(/Injected fault/);
      expect(names).toContain("generate_uuid");
      await expect(sb.engine.mcp.callTool("moka-demo", "generate_uuid", {})).rejects.toThrow(/Injected fault/);
      await expect(sb.engine.mcp.callTool("moka-demo", "roll_dice", {})).rejects.toThrow();
      await expect(sb.engine.mcp.callTool("moka-demo", "fetch_url", { url: "https://example.com" })).rejects.toThrow(/time/i);
      const marked = sb.engine.bus.history().filter((e) => e.kind === "mcp.rpc" && e.title.startsWith("⚡ injected"));
      expect(marked.map((e) => e.title)).toEqual(expect.arrayContaining([expect.stringMatching(/injected delay .*tools\/call/), expect.stringMatching(/injected tool-error/)]));

      // Turning faults off applies without reconnecting.
      await sb.engine.mcp.ensure({ ...server, faults: { ...server.faults!, enabled: false } });
      const ok = await sb.engine.mcp.callTool("moka-demo", "get_time", {});
      expect(ok.isError).toBeFalsy();
    } finally {
      await sb.close();
    }
  }, 60_000);
});
