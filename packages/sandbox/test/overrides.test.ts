import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startSandbox } from "../src/index.js";
import { startFakeLlm } from "./fake-llm.js";

describe("toolOverrides", () => {
  it("is what the model sees, and the call still reaches the server's tool", async () => {
    const fake = await startFakeLlm("moka-demo__get_time", { timezone: "Asia/Tokyo" });
    const home = mkdtempSync(path.join(os.tmpdir(), "moka-ovr-"));
    const configPath = path.join(home, "moka.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      llms: [{ id: "f", name: "F", provider: "openai-compatible", model: "f-1", baseURL: fake.baseURL }],
      mcpServers: [{ id: "moka-demo", name: "Demo", transport: "stdio", command: "moka:demo", protocol: "2025", toolOverrides: { get_time: { description: "Current time. Pass an IANA timezone like Asia/Tokyo, never a city name.", params: { timezone: { examples: ["Asia/Tokyo"] } } } } }],
      workspaces: [{ id: "w", name: "W", llmId: "f", mcpServerIds: ["moka-demo"], skillIds: [] }],
    }));
    const sb = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
    try {
      const res = await fetch(`http://127.0.0.1:${sb.port}/api/chat`, { method: "POST", headers: { "x-moka-token": "t", "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "time in tokyo" }] }) });
      const chunks = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
      const sent = fake.requests[0].tools.find((t: any) => t.function.name === "moka-demo__get_time").function;
      expect(sent.description).toBe("Current time. Pass an IANA timezone like Asia/Tokyo, never a city name.");
      expect(sent.parameters.properties.timezone.examples).toEqual(["Asia/Tokyo"]);
      expect(chunks.find((c) => c.type === "tool-result")?.output).toMatch(/ISO:/);
      const start = sb.engine.bus.history().find((e) => e.kind === "run.start");
      expect((start?.data as any).overridden).toEqual(["moka-demo__get_time"]);
    } finally {
      await sb.close();
      await fake.close();
    }
  }, 30_000);
});
