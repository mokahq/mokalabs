import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isContextOverflow } from "@mokalabs/core";
import { startSandbox } from "../src/index.js";

const LM_STUDIO = "The number of tokens to keep from the initial prompt is greater than the context length. Try to load the model with a larger context length, or provide a shorter input";

describe("prompt too big for the model's context", () => {
  it("recognises each provider's wording", () => {
    for (const m of [LM_STUDIO, "This model's maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens.", "context_length_exceeded", "prompt is too long: 210000 tokens > 200000 maximum", "the input length exceeds the context length", "request exceeds the available context size"]) expect(isContextOverflow(m), m).toBe(true);
    expect(isContextOverflow("401 Incorrect API key provided")).toBe(false);
  });

  it("says what filled the context and how to fix it in LM Studio", async () => {
    const lm = createServer(async (req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/api/v0/models/")) {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ id: "qwen3-8b", loaded_context_length: 4096, max_context_length: 40960 }));
      }
      for await (const _ of req) void _;
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: LM_STUDIO } }));
    });
    await new Promise<void>((r) => lm.listen(0, "127.0.0.1", r));
    const home = mkdtempSync(path.join(os.tmpdir(), "moka-ctx-"));
    const configPath = path.join(home, "moka.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      llms: [{ id: "q", name: "LM Studio", provider: "openai-compatible", model: "qwen3-8b", baseURL: `http://127.0.0.1:${(lm.address() as AddressInfo).port}/v1` }],
      mcpServers: [{ id: "moka-demo", name: "Moka demo tools", transport: "stdio", command: "moka:demo", protocol: "2025" }],
      workspaces: [{ id: "w", name: "W", llmId: "q", mcpServerIds: ["moka-demo"], skillIds: [] }],
    }));
    const sb = await startSandbox({ port: 0, configPath, token: false, env: { ...process.env, MOKA_HOME: home }, ui: false });
    try {
      const chunks = [];
      for await (const c of sb.engine.chat({ messages: [{ role: "user", content: "hi" }] })) chunks.push(c);
      const error = chunks.at(-1) as any;
      expect(error.type).toBe("error");
      expect(error.errorKind).toBe("context-overflow");
      expect(error.message).toMatch(/LM Studio \(qwen3-8b\) can't fit the prompt in its context window/);
      expect(error.message).toMatch(/LM Studio loaded it with a 4,096-token context/);
      expect(error.message).toMatch(/≈[\d,.k]+ for 13 tool definitions \(.*Moka demo tools ≈/);
      expect(error.message).toMatch(/reload the model with a larger context length/);
      expect(error.message).toContain(LM_STUDIO);
    } finally {
      await sb.close();
      lm.close();
    }
  }, 30_000);
});
