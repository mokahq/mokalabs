import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MokaEvent } from "@mokalabs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSandbox, type RunningSandbox } from "../src/index.js";

let sandbox: RunningSandbox;
let sessions: string;
const t0 = Date.now() - 60_000;
const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "create_issue", arguments: { title: "Login bug", repo: "web" } } });

beforeAll(async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-proxy-ui-"));
  sessions = path.join(home, "proxy", "sessions");
  mkdirSync(sessions, { recursive: true });
  // A finished session, recorded before Moka started: a client that timed out, retried, and got a late reply.
  writeFileSync(
    path.join(sessions, "a.jsonl"),
    [
      { type: "start", v: 1, t: t0, id: "a", client: "vscode", name: "github", command: "npx", args: ["-y", "server-github"], cwd: "/w", pid: 999_999_999, proxy: "0.3.0" },
      { type: "msg", t: t0 + 1, dir: "out", msg: { jsonrpc: "2.0", id: 0, method: "initialize", params: { clientInfo: { name: "Visual Studio Code", version: "1.105.0" } } } },
      { type: "msg", t: t0 + 40, dir: "in", msg: { jsonrpc: "2.0", id: 0, result: {} } },
      { type: "msg", t: t0 + 100, dir: "out", msg: call(7) },
      { type: "msg", t: t0 + 60_100, dir: "out", msg: { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "Request timed out" } } },
      { type: "msg", t: t0 + 60_200, dir: "out", msg: { ...call(8), params: { name: "create_issue", arguments: { repo: "web", title: "Login bug" } } } },
      { type: "msg", t: t0 + 60_900, dir: "in", msg: { jsonrpc: "2.0", id: 8, result: { content: [] } } },
      { type: "msg", t: t0 + 61_000, dir: "in", msg: { jsonrpc: "2.0", id: 7, result: { content: [] } } },
      { type: "stderr", t: t0 + 61_100, text: "rate limit: 4999 left" },
      { type: "exit", t: t0 + 62_000, code: 0, signal: null },
    ]
      .map(line)
      .join(""),
  );
  sandbox = await startSandbox({ port: 0, configPath: path.join(home, "moka.json"), token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
}, 30_000);

afterAll(async () => {
  await sandbox?.close();
});

const events = (serverId: string): MokaEvent[] => sandbox.engine.bus.history().filter((e) => e.serverId === serverId);
const api = async (p: string) => (await fetch(`http://127.0.0.1:${sandbox.port}${p}`, { headers: { "x-moka-token": "t" } })).json();

describe("proxy sessions", () => {
  it("exports what was recorded, redacted unless asked for raw", async () => {
    const data = await api("/api/proxy/export?ids=a");
    expect(data).toMatchObject({ format: "moka-proxy-export", redacted: true, sessions: [{ id: "a", client: "vscode", name: "github" }] });
    expect(data.sessions[0].records).toHaveLength(10);
    expect(data.sessions[0].records[3].msg).toEqual(call(7));
    expect(await api("/api/proxy/export?ids=a&raw=1")).toMatchObject({ redacted: false });
    expect((await api("/api/proxy/export?ids=nope")).sessions).toEqual([]);
  });

  it("replays a recorded session with pairing, timeouts, retries and late replies", async () => {
    const { sessions: list } = await api("/api/proxy");
    expect(list).toEqual([
      expect.objectContaining({ id: "a", serverId: "proxy:a", client: "VS Code", name: "github", clientInfo: { name: "Visual Studio Code", version: "1.105.0" }, live: false, requests: 3, timeouts: 1, errors: 0, exitCode: 0 }),
    ]);
    const titles = events("proxy:a").map((e) => [e.kind, e.level ?? "info", e.title]);
    expect(titles).toEqual([
      ["mcp.status", "info", "VS Code → github: started through the proxy"],
      ["mcp.rpc", "info", "initialize #0"],
      ["mcp.rpc", "info", "result #0 · initialize"],
      ["mcp.rpc", "info", "tools/call #7 · create_issue"],
      ["mcp.rpc", "warn", "VS Code gave up on tools/call #7 after 60.0s (timeout)"],
      ["mcp.rpc", "warn", "tools/call #8 · create_issue · retry after a timeout: the first call may have run"],
      ["mcp.rpc", "info", "result #8 · tools/call"],
      ["mcp.rpc", "warn", "late result #7 · tools/call"],
      ["mcp.log", "info", "github: rate limit: 4999 left"],
      ["mcp.status", "info", "VS Code → github: server exited"],
    ]);
    // Times come from the log, not from when Moka read it.
    const request = events("proxy:a").find((e) => e.title === "tools/call #7 · create_issue")!;
    expect(request.ts).toBe(t0 + 100);
    expect(events("proxy:a").find((e) => e.title.startsWith("VS Code gave up"))).toMatchObject({ durationMs: 60_000, rpc: { pairId: request.id, reason: "timeout" } });
  });

  it("follows a live session as the proxy appends to it", async () => {
    const file = path.join(sessions, "b.jsonl");
    const now = Date.now();
    writeFileSync(file, line({ type: "start", v: 1, t: now, id: "b", name: "notes", command: "node", args: ["notes.js"], cwd: "/w", pid: process.pid, proxy: "0.3.0" }));
    appendFileSync(file, line({ type: "msg", t: now + 1, dir: "out", msg: { jsonrpc: "2.0", id: 0, method: "initialize", params: { clientInfo: { name: "cursor-vscode", version: "1.0" } } } }));
    appendFileSync(file, line({ type: "msg", t: now + 2, dir: "out", msg: call(1) }));
    await new Promise((r) => setTimeout(r, 700));
    const live = (await api("/api/proxy")).sessions.find((s: any) => s.id === "b");
    // No --client: the name from initialize is used.
    expect(live).toMatchObject({ client: "cursor-vscode", name: "notes", live: true, requests: 2 });
    expect(events("proxy:b").map((e) => e.title)).toContain("tools/call #1 · create_issue");
    // The server exited with both requests still open.
    appendFileSync(file, line({ type: "exit", t: now + 5, code: null, signal: "SIGTERM" }));
    await new Promise((r) => setTimeout(r, 700));
    expect(events("proxy:b").filter((e) => e.kind === "mcp.unanswered").map((e) => e.title)).toEqual([
      "initialize #0: no response (server exited after 4ms)",
      "tools/call #1: no response (server exited after 3ms)",
    ]);
    expect((await api("/api/proxy")).sessions.find((s: any) => s.id === "b")).toMatchObject({ live: false });
  });
});
