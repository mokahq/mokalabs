import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { silentWav } from "@mokalabs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSandbox, type RunningSandbox } from "../src/index.js";

// A Whisper model on an OpenAI-compatible server (oMLX, LocalAI, Speaches…): audio in, text out.
let sandbox: RunningSandbox;
let server: Server;
const uploads: Array<{ contentType: string; body: string }> = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = Buffer.alloc(0);
    for await (const chunk of req) raw = Buffer.concat([raw, chunk]);
    if (req.url === "/v1/audio/transcriptions") {
      uploads.push({ contentType: String(req.headers["content-type"]), body: raw.toString("latin1") });
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify({ text: "Remind me to call the vet at five." }));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-stt-"));
  const configPath = path.join(home, "moka.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      llms: [
        { id: "whisper", name: "Whisper", provider: "openai-compatible", model: "whisper-large-v3-turbo", baseURL },
        { id: "qwen", name: "Qwen", provider: "openai-compatible", model: "qwen3-8b", baseURL },
      ],
      workspaces: [{ id: "w", name: "W", llmId: "whisper", mcpServerIds: [], skillIds: [] }],
    }),
  );
  sandbox = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
}, 30_000);

afterAll(async () => {
  await sandbox?.close();
  server?.close();
});

const call = (pathname: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${sandbox.port}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-moka-token": "t", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("transcription models", () => {
  it("tells the chat what each model is for", async () => {
    const boot = await (await call("/api/bootstrap")).json();
    expect(boot.models).toEqual({ whisper: { kind: "transcription" }, qwen: { kind: "chat", reasoning: "toggle" } });
  });

  it("transcribes the audio in a message", async () => {
    const audio = `data:audio/wav;base64,${Buffer.from(silentWav(200)).toString("base64")}`;
    const res = await call("/api/chat", { messages: [{ role: "user", content: [{ type: "file", data: audio, mediaType: "audio/wav", filename: "memo.wav" }, { type: "text", text: "vet" }] }] });
    const chunks = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(chunks.map((c) => c.type)).toEqual(["start", "text", "finish"]);
    expect(chunks[1].text).toBe("Remind me to call the vet at five.");
    expect(uploads.at(-1)!.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(uploads.at(-1)!.body).toContain('name="model"\r\n\r\nwhisper-large-v3-turbo');
    expect(uploads.at(-1)!.body).toContain('name="prompt"\r\n\r\nvet');
    expect(uploads.at(-1)!.body).toMatch(/name="file"; filename="memo\.wav"\r\nContent-Type: audio\/wav/);
  });

  it("checks the connection with a short silent clip", async () => {
    const profile = { id: "whisper", name: "Whisper", provider: "openai-compatible", model: "whisper-large-v3-turbo", baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
    expect(await (await call("/api/llm/test", { profile })).json()).toMatchObject({ ok: true });
    expect(uploads.at(-1)!.body).toContain('filename="silence.wav"');
  });
});
