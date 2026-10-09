import http from "node:http";
import { streamText } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModel, filterCompletionStream } from "../src/index.js";

const chunk = (content: string) => ({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const metrics = { start_time: 1791561594.66, ttft: 1791561595.63, ttlt: 1791561597.13, elapsed_time: 1.66 };

async function filter(pieces: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const p of pieces) c.enqueue(encoder.encode(p)); c.close(); } });
  const dropped: string[] = [];
  const text = await new Response(filterCompletionStream(body, (d) => dropped.push(d))).text();
  return { text, dropped };
}

describe("gateway stream events", () => {
  it("drops events that are neither completion chunks nor errors, wherever the network splits them", async () => {
    const stream = [metrics, chunk("Hi"), { error: { message: "rate limited" } }].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
    // Split into 7-byte pieces so events arrive across chunk boundaries.
    const { text, dropped } = await filter(stream.match(/[\s\S]{1,7}/g)!);
    expect(text).toBe([chunk("Hi"), { error: { message: "rate limited" } }].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n");
    expect(dropped.map((d) => JSON.parse(d))).toEqual([metrics]);
  });

  it("handles gateways that name their events and end with a timings event instead of [DONE]", async () => {
    // The shape of a real enterprise gateway: "event: chunk" for each delta, then "event: done" with timings.
    const stream = `event: chunk\ndata: ${JSON.stringify(chunk("Hi"))}\n\nevent: done\ndata: ${JSON.stringify(metrics)}\n\n`;
    const { text, dropped } = await filter([stream]);
    expect(text).toBe(`event: chunk\ndata: ${JSON.stringify(chunk("Hi"))}\n\n`);
    expect(dropped.map((d) => JSON.parse(d.replace(/^event: done\n/, "")))).toEqual([metrics]);
  });

  it("keeps CRLF line endings, comments and anything that isn't JSON", async () => {
    const stream = `: keep-alive\r\n\r\ndata: ${JSON.stringify(metrics)}\r\n\r\ndata: not json\r\n\r\ndata: ${JSON.stringify(chunk("ok"))}`;
    const { text } = await filter([stream]);
    expect(text).toBe(`: keep-alive\r\n\r\ndata: not json\r\n\r\ndata: ${JSON.stringify(chunk("ok"))}`);
  });

  describe("an OpenAI-compatible gateway that adds a timing event", () => {
    let server: http.Server;
    let baseURL: string;
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        req.resume().on("end", () => {
          res.setHeader("content-type", "text/event-stream");
          for (const e of [metrics, chunk("Hi "), chunk("there!"), { ...chunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]) res.write(`data: ${JSON.stringify(e)}\n\n`);
          res.end("data: [DONE]\n\n");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    });
    afterAll(() => server.close());

    it("streams the reply instead of failing on the extra event", async () => {
      const model = createModel({ id: "gw", name: "Gateway", provider: "openai-compatible", model: "corp-llama", baseURL });
      const result = streamText({ model, prompt: "hey" });
      const errors: unknown[] = [];
      let text = "";
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") text += part.text;
        if (part.type === "error") errors.push(part.error);
      }
      expect(errors).toEqual([]);
      expect(text).toBe("Hi there!");
    });
  });

  describe("streaming off", () => {
    let server: http.Server;
    let baseURL: string;
    const bodies: any[] = [];
    beforeAll(async () => {
      // Streams are broken here; plain replies work (like a gateway that only does "stream": false well).
      server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c)).on("end", () => {
          const body = JSON.parse(raw);
          bodies.push(body);
          if (body.stream) {
            res.setHeader("content-type", "text/event-stream");
            return res.end(`data: ${JSON.stringify({ unexpected: true })}\n\n`);
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "Whole reply." }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    });
    afterAll(() => server.close());

    it("asks for the whole reply and still streams it to Moka", async () => {
      const model = createModel({ id: "gw", name: "Gateway", provider: "openai-compatible", model: "corp", baseURL, stream: false });
      const result = streamText({ model, prompt: "hey" });
      let text = "";
      for await (const part of result.fullStream) if (part.type === "text-delta") text += part.text;
      expect(text).toBe("Whole reply.");
      expect((await result.usage).totalTokens).toBe(5);
      expect(bodies.at(-1)).toMatchObject({ model: "corp" });
      expect(bodies.at(-1).stream).not.toBe(true);
    });
  });

  it("streams Azure OpenAI's chunk shapes behind a gateway", async () => {
    const cf = { hate: { filtered: false, severity: "safe" } };
    const events = [
      { choices: [], created: 0, id: "", model: "", object: "", prompt_filter_results: [{ prompt_index: 0, content_filter_results: cf }] },
      { ...chunk("Hello"), choices: [{ index: 0, delta: { role: "assistant", content: "Hello", refusal: null }, finish_reason: null, logprobs: null, content_filter_results: cf }] },
      { ...chunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }] },
      { ...chunk(""), choices: [{ index: 0, finish_reason: null, content_filter_offsets: { check_offset: 0, start_offset: 0, end_offset: 5 }, content_filter_results: cf }] },
      { ...chunk(""), choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, completion_tokens_details: { reasoning_tokens: 0 } } },
    ];
    const server = http.createServer((req, res) => {
      req.resume().on("end", () => {
        res.setHeader("content-type", "text/event-stream");
        for (const e of events) res.write(`event: chunk\ndata: ${JSON.stringify(e)}\n\n`);
        res.end(`event: done\ndata: ${JSON.stringify(metrics)}\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
      const result = streamText({ model: createModel({ id: "az", name: "Azure", provider: "openai-compatible", model: "gpt-5.4", baseURL }), prompt: "hi" });
      const errors: unknown[] = [];
      let text = "";
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") text += part.text;
        if (part.type === "error") errors.push(part.error);
      }
      expect(errors).toEqual([]);
      expect(text).toBe("Hello");
      expect((await result.usage).totalTokens).toBe(6);
    } finally {
      server.close();
    }
  });
});

