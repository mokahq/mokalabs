import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { guessName, type SessionRecord } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "dist", "cli.js");
const fixture = path.join(here, "fixtures", "server.mjs");

const sessions = (home: string): SessionRecord[][] => {
  const dir = path.join(home, "proxy", "sessions");
  return readdirSync(dir).map((f) =>
    readFileSync(path.join(dir, f), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l)),
  );
};

describe("proxy", () => {
  it("passes a real MCP session through untouched and records every message", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "moka-proxy-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "--client", "vscode", "--name", "fixture", "--", process.execPath, fixture],
      env: { ...process.env, MOKA_HOME: home } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: "echo: hi ☕" }]);
    await client.close();
    await new Promise((r) => setTimeout(r, 300));

    const [records] = sessions(home);
    expect(records![0]).toMatchObject({ type: "start", v: 1, client: "vscode", name: "fixture", command: process.execPath, args: [fixture] });
    const msgs = records!.filter((r) => r.type === "msg") as Extract<SessionRecord, { type: "msg" }>[];
    expect(msgs.map((m) => [m.dir, (m.msg as any).method ?? `result #${(m.msg as any).id}`])).toEqual([
      ["out", "initialize"],
      ["in", "result #0"],
      ["out", "notifications/initialized"],
      ["out", "tools/list"],
      ["in", "result #1"],
      ["out", "tools/call"],
      ["in", "result #2"],
    ]);
    expect((msgs.at(-1)!.msg as any).result.content[0].text).toBe("echo: hi ☕");
    expect(records!.some((r) => r.type === "stderr" && r.text === "fixture server ready")).toBe(true);
    expect(records!.at(-1)).toMatchObject({ type: "exit" });
  }, 20_000);

  it("reports a server that can't start, without writing to stdout", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "moka-proxy-"));
    const run = spawnSync(process.execPath, [cli, "--", "definitely-not-a-command-xyz"], { env: { ...process.env, MOKA_HOME: home }, encoding: "utf8", input: "" });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/could not start definitely-not-a-command-xyz/);
    const [records] = sessions(home);
    expect(records!.map((r) => r.type)).toEqual(["start", "error"]);
  });

  it("names a server from its command", () => {
    expect(guessName("npx", ["-y", "@modelcontextprotocol/server-github"])).toBe("server-github");
    expect(guessName("uvx", ["mcp-server-fetch"])).toBe("mcp-server-fetch");
    expect(guessName("node", ["/home/me/notes/server.js"])).toBe("server");
    expect(guessName("npx", ["-y", "@playwright/mcp@latest"])).toBe("playwright");
    expect(guessName("npx", ["-y", "@modelcontextprotocol/server-everything@2025.1.1"])).toBe("server-everything");
  });
});
