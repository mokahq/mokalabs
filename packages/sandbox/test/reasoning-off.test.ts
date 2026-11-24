import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { startSandbox } from "../src/index.js";
import { startFakeLlm } from "./fake-llm.js";

it("asks a local Qwen not to think when Reasoning is off", async () => {
  const fake = await startFakeLlm("none", {});
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-nothink-"));
  const configPath = path.join(home, "moka.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    llms: [{ id: "q", name: "LM Studio", provider: "openai-compatible", model: "qwen3.8-27b-mlx", baseURL: fake.baseURL, reasoning: "off" }],
    mcpServers: [],
    workspaces: [{ id: "w", name: "W", llmId: "q", mcpServerIds: [], skillIds: [] }],
  }));
  const sb = await startSandbox({ port: 0, configPath, token: false, env: { ...process.env, MOKA_HOME: home }, ui: false });
  try {
    for await (const _ of sb.engine.chat({ messages: [{ role: "user", content: "hi" }] })) void _;
    const body = fake.requests[0];
    expect(body.reasoning_effort).toBe("none");
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toMatch(/\/no_think$/);
  } finally {
    await sb.close();
    await fake.close();
  }
}, 30_000);
