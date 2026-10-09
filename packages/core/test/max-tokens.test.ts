import http from "node:http";
import { generateText, streamText } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModel } from "../src/index.js";

// Azure OpenAI's answer for GPT-5 / o-series models when a request has max_tokens.
const AZURE_ERROR = { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: "invalid_request_error", param: "max_tokens", code: "unsupported_parameter" } };

describe("max_tokens on Azure's newer models", () => {
  let server: http.Server;
  let baseURL: string;
  const bodies: any[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c)).on("end", () => {
        const body = JSON.parse(raw);
        bodies.push(body);
        if ("max_tokens" in body) {
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify(AZURE_ERROR));
        }
        const choice = { index: 0, finish_reason: "stop" };
        if (body.stream) {
          res.setHeader("content-type", "text/event-stream");
          res.write(`data: ${JSON.stringify({ id: "x", created: 0, model: "m", choices: [{ ...choice, finish_reason: null, delta: { role: "assistant", content: "pong" } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: "x", created: 0, model: "m", choices: [{ ...choice, delta: {} }] })}\n\n`);
          return res.end("data: [DONE]\n\n");
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ ...choice, message: { role: "assistant", content: "pong" } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(() => server.close());

  it("retries with max_completion_tokens when max_tokens is rejected, then uses it directly", async () => {
    const model = createModel({ id: "az", name: "Azure gateway", provider: "openai-compatible", model: "gpt-5.4", baseURL });
    // Like the model Test button: a short, non-streamed request with a token limit.
    expect((await generateText({ model, prompt: "ping", maxOutputTokens: 16 })).text).toBe("pong");
    expect(bodies.map((b) => [b.max_tokens, b.max_completion_tokens])).toEqual([
      [16, undefined],
      [undefined, 16],
    ]);

    // A streamed chat with a limit goes straight to max_completion_tokens now.
    let text = "";
    for await (const part of streamText({ model, prompt: "ping", maxOutputTokens: 64 }).fullStream) if (part.type === "text-delta") text += part.text;
    expect(text).toBe("pong");
    expect(bodies.at(-1)).toMatchObject({ max_completion_tokens: 64, stream: true });
    expect(bodies.at(-1)).not.toHaveProperty("max_tokens");
  });

  it("leaves other errors alone", async () => {
    const model = createModel({ id: "az", name: "Azure gateway", provider: "openai-compatible", model: "gpt-5.4", baseURL: baseURL.replace(/\d+\/v1$/, "1/v1") });
    await expect(generateText({ model, prompt: "ping", maxOutputTokens: 16, maxRetries: 0 })).rejects.toThrow();
  });
});
