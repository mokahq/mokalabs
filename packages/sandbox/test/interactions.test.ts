import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSandbox, type RunningSandbox } from "../src/index.js";
import { startFakeLlm } from "./fake-llm.js";

let sandbox: RunningSandbox;
let base: string;
const fakes: Array<Awaited<ReturnType<typeof startFakeLlm>>> = [];

const post = (pathname: string, body: unknown) =>
  fetch(`${base}${pathname}`, { method: "POST", headers: { "x-moka-token": "t", "content-type": "application/json" }, body: JSON.stringify(body) });
const pending = async () => (await (await fetch(`${base}/api/interactions`, { headers: { "x-moka-token": "t" } })).json()).interactions as any[];

async function waitForInteraction() {
  for (let i = 0; i < 200; i++) {
    const list = await pending();
    if (list.length) return list[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no interaction arrived");
}

beforeAll(async () => {
  const coffee = await startFakeLlm("moka-demo__order_coffee", { name: "Bruce" });
  const brainstorm = await startFakeLlm("moka-demo__brainstorm", { topic: "dino names" });
  fakes.push(coffee, brainstorm);
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-ix-"));
  const configPath = path.join(home, "moka.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      llms: [
        { id: "coffee", name: "Coffee", provider: "openai-compatible", model: "coffee-model", baseURL: coffee.baseURL },
        { id: "brainstorm", name: "Brainstorm", provider: "openai-compatible", model: "brainstorm-model", baseURL: brainstorm.baseURL },
      ],
      mcpServers: [{ id: "moka-demo", name: "Demo", transport: "stdio", command: "moka:demo" }],
      workspaces: [{ id: "w", name: "W", llmId: "brainstorm", mcpServerIds: ["moka-demo"], skillIds: [] }],
    }),
  );
  sandbox = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
  base = `http://127.0.0.1:${sandbox.port}`;
}, 30_000);

afterAll(async () => {
  await sandbox?.close();
  await Promise.all(fakes.map((f) => f.close()));
});

describe("MCP elicitation", () => {
  it("asks the user through the UI and returns their answer to the server", async () => {
    const chat = post("/api/chat", { llmId: "coffee", messages: [{ role: "user", content: "coffee please" }] }).then((r) => r.text());
    const request = await waitForInteraction();
    expect(request).toMatchObject({ kind: "elicitation", serverId: "moka-demo", mode: "form", message: "What can we get you, Bruce? ☕" });
    expect(request.requestedSchema.required).toEqual(["drink", "size"]);
    await post(`/api/interactions/${request.id}`, { response: { action: "accept", content: { drink: "flat white", size: "medium", oatMilk: true } } });
    const result = (await chat).trim().split("\n").map((l) => JSON.parse(l)).find((c) => c.type === "tool-result");
    expect(result.output).toBe("Order placed: medium flat white with oat milk. Ready in 4 minutes.");
  }, 30_000);

  it("reports a declined request", async () => {
    const chat = post("/api/chat", { llmId: "coffee", messages: [{ role: "user", content: "coffee please" }] }).then((r) => r.text());
    const request = await waitForInteraction();
    await post(`/api/interactions/${request.id}`, { response: { action: "decline" } });
    const result = (await chat).trim().split("\n").map((l) => JSON.parse(l)).find((c) => c.type === "tool-result");
    expect(result.output).toBe("The user declined the order.");
  }, 30_000);
});

describe("MCP sampling", () => {
  it("asks for approval, then runs the workspace model for the server", async () => {
    const chat = post("/api/chat", { messages: [{ role: "user", content: "brainstorm" }] }).then((r) => r.text());
    const request = await waitForInteraction();
    expect(request).toMatchObject({ kind: "sampling", serverId: "moka-demo", maxTokens: 200 });
    expect(request.systemPrompt).toMatch(/three short bullet points/);
    await post(`/api/interactions/${request.id}`, { response: { approved: true } });
    const result = (await chat).trim().split("\n").map((l) => JSON.parse(l)).find((c) => c.type === "tool-result");
    // The fake model answers non-streaming requests with "pong".
    expect(result.output).toBe("Ideas from brainstorm-model:\npong");
    expect(sandbox.engine.bus.history().some((e) => e.kind === "llm.request" && e.title.includes("sampling for Demo"))).toBe(true);
  }, 30_000);

  it("lets the server know when sampling is denied", async () => {
    const chat = post("/api/chat", { messages: [{ role: "user", content: "brainstorm" }] }).then((r) => r.text());
    const request = await waitForInteraction();
    await post(`/api/interactions/${request.id}`, { response: { approved: false } });
    const result = (await chat).trim().split("\n").map((l) => JSON.parse(l)).find((c) => c.type === "tool-result");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/Sampling failed: .*rejected/);
  }, 30_000);
});

describe("attachments", () => {
  it("sends images and files to the model as content parts", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const content = [
      { type: "image", image: png, mediaType: "image/png" },
      { type: "text", text: '<file name="notes.txt">\nhello\n</file>' },
      { type: "text", text: "what is in the picture?" },
    ];
    const chat = post("/api/chat", { llmId: "coffee", messages: [{ role: "user", content }] }).then((r) => r.text());
    // The fake model then calls order_coffee, which asks the user; decline it.
    const request = await waitForInteraction();
    await post(`/api/interactions/${request.id}`, { response: { action: "decline" } });
    await chat;
    const sent = fakes[0]!.requests.at(-2)!.messages.find((m: any) => m.role === "user");
    expect(sent.content[0]).toMatchObject({ type: "image_url", image_url: { url: png } });
    expect(sent.content.map((c: any) => c.type)).toEqual(["image_url", "text", "text"]);
  }, 30_000);
});
