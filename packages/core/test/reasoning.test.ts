import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { streamText } from "ai";
import { describe, expect, it } from "vitest";
import { claudeThinking, createModel, reasoningOptions } from "../src/providers.js";

const profile = (provider: any, model: string, extra: Record<string, unknown> = {}) => ({ id: "x", name: "X", provider, model, ...extra }) as any;

describe("reasoning", () => {
  it("knows how each Claude model thinks", () => {
    expect(claudeThinking("claude-3-5-sonnet-latest")).toBe("none");
    expect(claudeThinking("claude-3-haiku-20240307")).toBe("none");
    expect(claudeThinking("claude-3-7-sonnet-latest")).toBe("budget");
    expect(claudeThinking("claude-sonnet-4-20250514")).toBe("budget");
    expect(claudeThinking("claude-sonnet-4-5")).toBe("budget");
    expect(claudeThinking("claude-opus-4-1-20250805")).toBe("budget");
    expect(claudeThinking("claude-sonnet-4-6")).toBe("adaptive");
    expect(claudeThinking("claude-sonnet-5")).toBe("adaptive");
    expect(claudeThinking("claude-opus-5-5")).toBe("adaptive");
  });

  it("asks each provider for visible reasoning, and the profile's own options win", () => {
    expect(reasoningOptions(profile("openai", "gpt-5-mini")).providerOptions).toEqual({ openai: { reasoningSummary: "auto" } });
    expect(reasoningOptions(profile("openai", "gpt-5", { useChatApi: true })).providerOptions).toBeUndefined();
    expect(reasoningOptions(profile("anthropic", "claude-sonnet-5")).providerOptions).toEqual({ anthropic: { thinking: { type: "adaptive", display: "summarized" } } });
    expect(reasoningOptions(profile("anthropic", "claude-sonnet-4-5", { reasoning: "high" })).providerOptions).toEqual({ anthropic: { thinking: { type: "enabled", budgetTokens: 24576 } } });
    expect(reasoningOptions(profile("anthropic", "claude-3-5-haiku-latest")).providerOptions).toBeUndefined();
    expect(reasoningOptions(profile("google", "gemini-2.5-flash")).providerOptions).toEqual({ google: { thinkingConfig: { includeThoughts: true } } });
    expect(reasoningOptions(profile("google", "gemini-2.0-flash")).providerOptions).toBeUndefined();
    expect(reasoningOptions(profile("google", "gemini-3.5-flash")).providerOptions).toEqual({ google: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } } });
    expect(reasoningOptions(profile("google", "gemini-2.5-flash-lite")).providerOptions).toEqual({ google: { thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 } } });
    expect(reasoningOptions(profile("google", "gemini-3-pro-preview")).providerOptions).toEqual({ google: { thinkingConfig: { includeThoughts: true } } });
    expect(reasoningOptions(profile("google", "gemini-3.5-flash", { reasoning: "medium" }))).toEqual({ reasoning: "medium", providerOptions: { google: { thinkingConfig: { includeThoughts: true } } } });
    expect(reasoningOptions(profile("openai", "gpt-5", { reasoning: "off" })).providerOptions).toBeUndefined();
    expect(reasoningOptions(profile("openai", "o3", { providerOptions: { openai: { reasoningSummary: "detailed" } } })).providerOptions).toEqual({ openai: { reasoningSummary: "detailed" } });
    expect(reasoningOptions(profile("openai-compatible", "qwen3", { reasoning: "low" }))).toEqual({ reasoning: "low" });
  });

  it("shows <think> blocks from local models as reasoning, not as the answer", async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "text/event-stream");
      const send = (content: string) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "qwen3", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
      for (const piece of ["<think>", "The user wants ", "a greeting.", "</think>", "\n\nHello!"]) send(piece);
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "qwen3", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      const result = streamText({ model: createModel(profile("openai-compatible", "qwen3", { baseURL })), prompt: "hi" });
      let reasoning = "";
      let text = "";
      for await (const part of result.fullStream) {
        if (part.type === "reasoning-delta") reasoning += part.text;
        if (part.type === "text-delta") text += part.text;
      }
      expect(reasoning).toBe("The user wants a greeting.");
      expect(text.trim()).toBe("Hello!");
    } finally {
      server.close();
    }
  });
});
