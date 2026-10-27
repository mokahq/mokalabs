import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSandbox, type RunningSandbox } from "../src/index.js";

let sandbox: RunningSandbox;
let silent: Server;

beforeAll(async () => {
  // A gateway that accepts the request and never answers.
  silent = createServer(() => {});
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  const baseURL = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/v1`;
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-timeout-"));
  const configPath = path.join(home, "moka.json");
  writeFileSync(configPath, JSON.stringify({ version: 1, llms: [{ id: "g", name: "Gateway", provider: "openai-compatible", model: "g-1", baseURL, timeoutMs: 1500 }], mcpServers: [], workspaces: [{ id: "w", name: "W", llmId: "g", mcpServerIds: [], skillIds: [] }] }));
  sandbox = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
}, 30_000);

afterAll(async () => {
  await sandbox?.close();
  silent.closeAllConnections();
  silent.close();
});

describe("a model that never answers", () => {
  it("ends the run with a clear error instead of hanging", async () => {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${sandbox.port}/api/chat`, { method: "POST", headers: { "x-moka-token": "t", "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    const chunks = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(Date.now() - started).toBeLessThan(10_000);
    const error = chunks.find((c) => c.type === "error");
    console.log(JSON.stringify(error));
    expect(error?.message).toMatch(/Gateway sent nothing for 1\.5s, so Moka stopped waiting/);
  }, 20_000);
});

describe("the model timeout and slow tools", () => {
  it("doesn't count time spent running tools or waiting for approval", async () => {
    const { startFakeLlm } = await import("./fake-llm.js");
    const fake = await startFakeLlm("moka-demo__slow_backtest", { symbol: "AAPL", years: 1, seconds: 3 });
    const home = mkdtempSync(path.join(os.tmpdir(), "moka-timeout2-"));
    const configPath = path.join(home, "moka.json");
    writeFileSync(configPath, JSON.stringify({ version: 1, llms: [{ id: "f", name: "F", provider: "openai-compatible", model: "f-1", baseURL: fake.baseURL, timeoutMs: 1500 }], mcpServers: [{ id: "moka-demo", name: "Demo", transport: "stdio", command: "moka:demo", protocol: "2025" }], workspaces: [{ id: "w", name: "W", llmId: "f", mcpServerIds: ["moka-demo"], skillIds: [], requireApproval: true }] }));
    const sb = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
    const base = `http://127.0.0.1:${sb.port}`;
    const headers = { "x-moka-token": "t", "content-type": "application/json" };
    try {
      const chat = fetch(`${base}/api/chat`, { method: "POST", headers, body: JSON.stringify({ messages: [{ role: "user", content: "backtest" }] }) }).then((r) => r.text());
      // Wait 3s before approving: longer than the model timeout.
      let pending: any[] = [];
      for (let i = 0; i < 100 && !pending.length; i++) {
        await new Promise((r) => setTimeout(r, 50));
        pending = (await (await fetch(`${base}/api/interactions`, { headers })).json()).interactions;
      }
      await new Promise((r) => setTimeout(r, 3000));
      await fetch(`${base}/api/interactions/${pending[0].id}`, { method: "POST", headers, body: JSON.stringify({ response: { approved: true } }) });
      const chunks = (await chat).trim().split("\n").map((l) => JSON.parse(l));
      expect(chunks.find((c) => c.type === "error")).toBeUndefined();
      expect(chunks.find((c) => c.type === "tool-result")?.output).toMatch(/Backtest of AAPL/);
    } finally {
      await sb.close();
      await fake.close();
    }
  }, 30_000);
});
