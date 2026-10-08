import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exportSessions, redactArgs, redactRecord } from "../src/index.js";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const line = (record: unknown) => `${JSON.stringify(record)}\n`;

function setup() {
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-export-"));
  const dir = path.join(home, "proxy", "sessions");
  mkdirSync(dir, { recursive: true });
  const t = Date.now() - 5_000;
  writeFileSync(
    path.join(dir, "s1.jsonl"),
    [
      { type: "start", v: 1, t, id: "s1", client: "vscode", name: "github", command: "npx", args: ["-y", "server-github", "--token", "ghp_abcdefghijklmnopqrstuvwxyz0123"], cwd: "/w", pid: 1, proxy: "0.3.0" },
      { type: "msg", t: t + 1, dir: "out", msg: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fetch", arguments: { url: "https://x.test", apiKey: "k-123", headers: { Authorization: "Bearer abc.def.ghi" } }, _meta: { progressToken: "p1" } } } },
      { type: "msg", t: t + 2, dir: "in", msg: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "used sk-ABCDEFGHIJKLMNOPQRSTUV" }] } } },
      { type: "stderr", t: t + 3, text: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 loaded" },
      { type: "exit", t: t + 4, code: 0, signal: null },
    ]
      .map(line)
      .join("") + '{"type":"msg","t":', // a torn last line, as while the proxy is still writing
  );
  writeFileSync(path.join(dir, "s2.jsonl"), line({ type: "start", v: 1, t: t + 10, id: "s2", client: "cursor", name: "fs", command: "npx", args: [], cwd: "/w", pid: 2, proxy: "0.3.0" }));
  return { home, dir };
}

describe("export", () => {
  it("exports every record, newest session first, and filters by client and name", () => {
    const { dir } = setup();
    const all = exportSessions(dir, { redact: false });
    expect(all).toMatchObject({ format: "moka-proxy-export", version: 1, redacted: false });
    expect(all.sessions.map((s) => [s.id, s.client, s.name, s.records.length])).toEqual([
      ["s2", "cursor", "fs", 1],
      ["s1", "vscode", "github", 5],
    ]);
    expect(all.sessions[1]!.endedAt).toBe(all.sessions[1]!.records[4]!.t);
    expect(exportSessions(dir, { client: "vscode" }).sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(exportSessions(dir, { ids: ["s2"] }).sessions.map((s) => s.id)).toEqual(["s2"]);
  });

  it("redacts secrets but keeps the protocol intact", () => {
    const { dir } = setup();
    const [s1] = exportSessions(dir, { ids: ["s1"] }).sessions;
    const [start, call, result, stderr] = s1!.records as any[];
    expect(start.args).toEqual(["-y", "server-github", "--token", "<redacted>"]);
    expect(call.msg.params).toEqual({ name: "fetch", arguments: { url: "https://x.test", apiKey: "<redacted>", headers: { Authorization: "<redacted>" } }, _meta: { progressToken: "p1" } });
    expect(result.msg.result.content[0].text).toBe("used <redacted>");
    expect(stderr.text).toBe("GITHUB_TOKEN=<redacted> loaded");
    expect(redactArgs(["--api-key=abc", "API_KEY=xyz", "--model", "gpt"])).toEqual(["--api-key=<redacted>", "API_KEY=<redacted>", "--model", "gpt"]);
    expect(redactRecord({ type: "raw", t: 0, dir: "in", text: "Authorization: Bearer abcdefghij" })).toMatchObject({ text: "Authorization: Bearer <redacted>" });
  });

  it("exports from the command line", () => {
    const { home } = setup();
    const env = { ...process.env, MOKA_HOME: home };
    const out = path.join(home, "trace.json");
    const run = spawnSync(process.execPath, [cli, "export", "--client", "vscode", "-o", out], { env, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/Exported 1 session \(5 records\) to .*trace\.json \(secrets redacted/);
    const data = JSON.parse(readFileSync(out, "utf8"));
    expect(data.sessions[0].records[0].args.at(-1)).toBe("<redacted>");

    const raw = spawnSync(process.execPath, [cli, "export", "--raw", "-o", "-"], { env, encoding: "utf8" });
    expect(JSON.parse(raw.stdout)).toMatchObject({ redacted: false, sessions: [{ id: "s2" }, { id: "s1" }] });

    const none = spawnSync(process.execPath, [cli, "export", "--name", "nope"], { env, encoding: "utf8" });
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/No recorded sessions match/);
    expect(spawnSync(process.execPath, [cli, "export", "--since", "soon"], { env, encoding: "utf8" }).status).toBe(2);
  });
});
