import { describe, expect, it } from "vitest";
import type { ChatChunk } from "../src/agent.js";
import { grade, matches, runToolTests, summarize, type TestHost } from "../src/tests.js";

describe("tool tests", () => {
  it("matches arguments partially, ignoring case in strings", () => {
    expect(matches({ timezone: "Asia/Tokyo", format: "long" }, { timezone: "asia/tokyo" })).toBe(true);
    expect(matches({ count: "3" }, { count: 3 })).toBe(true);
    expect(matches({ tags: ["a", "b"] }, { tags: ["a"] })).toBe(false);
    expect(matches({ filter: { status: "open", repo: "web" } }, { filter: { status: "OPEN" } })).toBe(true);
    expect(matches(undefined, { a: 1 })).toBe(false);
  });

  it("grades what the model did", () => {
    const test = { id: "t", prompt: "time in Tokyo?", expectTools: ["get_time"], forbidTools: ["fetch_url"], expectArgs: { get_time: { timezone: "Asia/Tokyo" } }, answerIncludes: ["Tokyo"] };
    expect(grade(test, [{ tool: "get_time", input: { timezone: "Asia/Tokyo" } }], "It's 9pm in Tokyo.")).toEqual({ passed: true, reasons: [] });
    expect(grade(test, [{ tool: "get_time", input: { timezone: "Japan" } }, { tool: "fetch_url", input: {} }], "It's late.").reasons).toEqual([
      "Called fetch_url, which it shouldn't",
      'get_time got {"timezone":"Japan"}, expected {"timezone":"Asia/Tokyo"}',
      'Answer doesn\'t mention "Tokyo"',
    ]);
    expect(grade(test, [], "", "429 Too Many Requests").reasons).toEqual(["Error: 429 Too Many Requests", "Didn't call get_time", 'Answer doesn\'t mention "Tokyo"']);
    // A negative test: no tool expected, one forbidden.
    expect(grade({ id: "n", prompt: "What's 2+2?", forbidTools: ["calculate"] }, [], "4").passed).toBe(true);
  });

  it("runs every test on every model, several times, and summarises", async () => {
    const seen: Array<{ llmId?: string; toolMode?: string; prompt: string }> = [];
    const host: TestHost = {
      workspace: () => ({
        id: "w",
        tests: [
          { id: "time", prompt: "What time is it in Tokyo?", expectTools: ["get_time"] },
          { id: "math", prompt: "What's 2+2?", forbidTools: ["calculate"] },
        ],
      }),
      async *chat(request): AsyncGenerator<ChatChunk> {
        seen.push({ llmId: request.llmId, toolMode: request.toolMode, prompt: request.messages[0].content });
        await new Promise((r) => setTimeout(r, request.llmId === "slow" ? 15 : 1));
        // "good" uses the right tool; "bad" reaches for the calculator every time.
        const tool = request.llmId === "good" ? (request.messages[0].content.includes("time") ? "get_time" : undefined) : "calculate";
        if (tool) yield { type: "tool-call", id: "c1", name: `demo__${tool}`, tool, source: "Demo", input: {} } as ChatChunk;
        yield { type: "text", text: "done" } as ChatChunk;
        yield { type: "finish", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, durationMs: 5, messages: [] } as ChatChunk;
      },
    };
    const results = [];
    for await (const r of runToolTests(host, { llmIds: ["good", "bad", "slow"], runs: 2 })) results.push(r);
    expect(results).toHaveLength(12);
    expect(seen.every((s) => s.toolMode === "read-only")).toBe(true);
    expect(summarize(results).map((s) => [s.llmId, s.passed, s.total, s.avgTokens])).toEqual(
      expect.arrayContaining([
        ["good", 4, 4, 110],
        ["bad", 0, 4, 110],
        ["slow", 0, 4, 110],
      ]),
    );
    expect(results.find((r) => r.llmId === "bad" && r.testId === "math")!.reasons).toEqual(["Called calculate, which it shouldn't"]);
    // Runs are numbered per test and model.
    expect(results.filter((r) => r.llmId === "good" && r.testId === "time").map((r) => r.run)).toEqual([1, 2]);
  });
});
