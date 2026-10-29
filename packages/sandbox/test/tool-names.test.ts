import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startSandbox, type RunningSandbox } from "../src/index.js";
import { startFakeLlm } from "./fake-llm.js";

let sandbox: RunningSandbox | undefined;
let fake: Awaited<ReturnType<typeof startFakeLlm>> | undefined;

afterEach(async () => {
  await sandbox?.close();
  await fake?.close();
});

async function chatWith(toolName: string, args: Record<string, unknown>) {
  fake = await startFakeLlm(toolName, args);
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-names-"));
  const configPath = path.join(home, "moka.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      llms: [{ id: "f", name: "F", provider: "openai-compatible", model: "f-1", baseURL: fake.baseURL }],
      mcpServers: [{ id: "moka-demo", name: "Demo", transport: "stdio", command: "moka:demo", protocol: "2025" }],
      workspaces: [{ id: "w", name: "W", llmId: "f", mcpServerIds: ["moka-demo"], skillIds: [] }],
    }),
  );
  sandbox = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
  const res = await fetch(`http://127.0.0.1:${sandbox.port}/api/chat`, {
    method: "POST",
    headers: { "x-moka-token": "t", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  return (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
}

describe("tool names models get wrong", () => {
  it("runs the one tool a misnamed call means", async () => {
    const chunks = await chatWith("default_api__calculate", { expression: "2+3" });
    expect(chunks.find((c) => c.type === "tool-result")).toMatchObject({ output: "5" });
    expect(sandbox!.engine.bus.history().some((e) => e.title.includes('called "default_api__calculate"; Moka ran "moka-demo__calculate"'))).toBe(true);
  }, 30_000);

  it("reports a made-up tool as an unknown tool", async () => {
    const chunks = await chatWith("make_coffee", {});
    expect(chunks.find((c) => c.type === "tool-result")).toMatchObject({ isError: true, errorClass: "unknown-tool" });
  }, 30_000);
});
