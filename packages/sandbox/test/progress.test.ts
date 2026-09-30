import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSandbox, type RunningSandbox } from "../src/index.js";

let sandbox: RunningSandbox;

beforeAll(async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-progress-"));
  const configPath = path.join(home, "moka.json");
  const demo = (id: string, extra: Record<string, unknown>) => ({ id, name: id, transport: "stdio", command: "moka:demo", ...extra });
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      mcpServers: [
        demo("demo", {}),
        // Like a client on the MCP SDK defaults, but with a 1.5 s limit so the test is quick.
        demo("strict", { toolTimeoutMs: 1500, resetTimeoutOnProgress: false }),
        demo("patient", { toolTimeoutMs: 1500 }),
      ],
      workspaces: [{ id: "w", name: "W", mcpServerIds: ["demo"], skillIds: [] }],
    }),
  );
  sandbox = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
  const config = sandbox.engine.getConfig();
  await Promise.all(config.mcpServers.map((s) => sandbox.engine.mcp.ensure(s)));
}, 60_000);

afterAll(async () => {
  await sandbox?.close();
});

const history = () => sandbox.engine.bus.history();

describe("progress notifications", () => {
  it("asks for progress and reports it per tool call", async () => {
    const result = await sandbox.engine.mcp.callTool("demo", "slow_backtest", { symbol: "MSFT", seconds: 3 }, { runId: "r1", callId: "call_1" });
    expect(JSON.stringify(result.content)).toContain("Backtest of MSFT over 5 years (simulated)");
    const progress = history().filter((e) => e.kind === "tool.progress" && e.runId === "r1");
    // The last update can arrive together with the result; the SDK then drops it (see mcp.ts).
    expect(progress.map((e) => (e.data as any).progress).slice(0, 2)).toEqual([1, 2]);
    expect(progress[0]).toMatchObject({ serverId: "demo", title: expect.stringMatching(/^slow_backtest · 33% · Replaying MSFT \d{4}$/), data: { id: "call_1", total: 3 } });
    // …and that race is never reported as an error.
    expect(history().some((e) => e.kind === "mcp.log" && /unknown token/.test(e.title))).toBe(false);
    // The raw notifications are linked to their request in the RPC log.
    const request = history().filter((e) => e.serverId === "demo" && e.rpc?.method === "tools/call" && !e.rpc.pairId).at(-1)!;
    const notes = history().filter((e) => e.kind === "mcp.rpc" && e.rpc?.pairId === request.id && e.title.startsWith("progress"));
    expect(notes.map((e) => e.title)).toEqual([1, 2, 3].map((n) => `progress ${Math.round((n / 3) * 100)}% → tools/call #${request.rpc!.id}`));
  }, 20_000);
});

describe("tool timeouts", () => {
  it("gives up at the limit when progress doesn't extend it, and says so", async () => {
    const started = Date.now();
    await expect(sandbox.engine.mcp.callTool("strict", "slow_backtest", { seconds: 4 })).rejects.toThrow(
      "No answer from strict after 1.5s (tool timeout), so Moka stopped waiting.",
    );
    expect(Date.now() - started).toBeLessThan(3000);
    const gaveUp = history().filter((e) => e.serverId === "strict" && e.rpc?.reason === "timeout").at(-1)!;
    expect(gaveUp).toMatchObject({ level: "warn", rpc: { outcome: "cancelled", method: "tools/call" } });
    expect(gaveUp.title).toMatch(/^Moka gave up on tools\/call #\d+ after 1\.5s \(timeout\)$/);
  }, 20_000);

  it("keeps waiting while progress arrives when reset-on-progress is on (the default)", async () => {
    const result = await sandbox.engine.mcp.callTool("patient", "slow_backtest", { seconds: 3 });
    expect(JSON.stringify(result.content)).toContain("Backtest of AAPL");
  }, 20_000);
});
