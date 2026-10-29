import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changesAsCode, changesAsMarkdown, type ImproveEvent } from "@mokalabs/core";
import { startSandbox, type RunningSandbox } from "../src/index.js";

/**
 * A model that reads the tool's wording, like a small local model: it sends a
 * proper IANA timezone only when the description asks for one.
 */
async function startWordingSensitiveLlm() {
  const server: Server = createServer(async (req, res) => {
    if (req.method === "GET") return void res.end(JSON.stringify({ data: [{ id: "small-1" }] }));
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    const base = { id: "c", object: "chat.completion.chunk", created: 0, model: body.model };
    res.setHeader("content-type", "text/event-stream");
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const done = (body.messages ?? []).some((m: any) => m.role === "tool");
    const tool = (body.tools ?? []).find((t: any) => t.function.name === "moka-demo__get_time")?.function;
    if (!done && tool) {
      const iana = /IANA/.test(tool.description) && /Asia\/Tokyo/.test(JSON.stringify(tool));
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: tool.name, arguments: JSON.stringify({ timezone: iana ? "Asia/Tokyo" : "Tokyo" }) } }] }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ ...base, choices: [{ index: 0, delta: { content: "Done." }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let sandbox: RunningSandbox;
let llm: Awaited<ReturnType<typeof startWordingSensitiveLlm>>;

beforeAll(async () => {
  llm = await startWordingSensitiveLlm();
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-improve-"));
  const configPath = path.join(home, "moka.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    llms: [{ id: "small", name: "Small", provider: "openai-compatible", model: "small-1", baseURL: llm.baseURL }],
    mcpServers: [{ id: "moka-demo", name: "Demo", transport: "stdio", command: "moka:demo", protocol: "2025" }],
    workspaces: [{ id: "w", name: "W", llmId: "small", mcpServerIds: ["moka-demo"], skillIds: [], tests: [{ id: "t1", name: "Time in Tokyo", prompt: "What time is it in Tokyo?", expectTools: ["get_time"], expectArgs: { get_time: { timezone: "Asia/Tokyo" } } }] }],
  }));
  sandbox = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
}, 30_000);

afterAll(async () => {
  await sandbox?.close();
  await llm?.close();
});

/** A scripted improver: two reworded prompts, then two proposals (one fixes the wording, one doesn't). */
const ask = async (prompt: string) => {
  if (prompt.startsWith("Rewrite each user request")) return JSON.stringify({ t1: ["tokyo time right now?", "Could you tell me the current time in Tokyo, Japan?"] });
  return JSON.stringify({
    proposals: [
      { summary: "Ask for IANA names", changes: [{ tool: "get_time", description: "Get the current date and time in a timezone. Pass an IANA timezone name, not a city.", params: { timezone: { description: "IANA name, e.g. Asia/Tokyo", examples: ["Asia/Tokyo", "Europe/Paris"] } }, reason: "Models sent city names." }] },
      { summary: "Shorter", changes: [{ tool: "get_time", description: "Returns the time.", reason: "Shorter is clearer." }, { tool: "not_a_tool", description: "x", reason: "dropped" }] },
    ],
  });
};

describe("Improve", () => {
  it("diagnoses, proposes, verifies on the holdout too, and accepts only what tests better", async () => {
    const events: ImproveEvent[] = [];
    for await (const e of sandbox.engine.improve({ workspaceId: "w", llmIds: ["small"], runs: 1 }, ask)) events.push(e);
    const start = events.find((e) => e.type === "start") as Extract<ImproveEvent, { type: "start" }>;
    expect(start.improver.id).toBe("small");
    expect(start.estimatedRuns).toBe(1 + 2 + 2 * (1 + 2));

    const diagnosis = (events.find((e) => e.type === "diagnosis") as Extract<ImproveEvent, { type: "diagnosis" }>).diagnosis;
    expect(diagnosis[0]).toMatchObject({ kind: "wrong-args", tool: "get_time", testId: "t1" });
    expect(diagnosis[0]!.detail).toMatch(/"Tokyo"/);

    const holdout = (events.find((e) => e.type === "holdout") as Extract<ImproveEvent, { type: "holdout" }>).tests;
    expect(holdout.map((t) => t.id)).toEqual(["holdout:t1:1", "holdout:t1:2"]);
    expect(holdout[0]!.expectArgs).toEqual({ get_time: { timezone: "Asia/Tokyo" } });

    const proposals = (events.find((e) => e.type === "proposals") as Extract<ImproveEvent, { type: "proposals" }>).proposals;
    expect(proposals.map((p) => p.changes.map((c) => c.tool))).toEqual([["get_time"], ["get_time"]]); // the unknown tool was dropped

    const verdict = events.find((e) => e.type === "verdict") as Extract<ImproveEvent, { type: "verdict" }>;
    expect(verdict.baseline).toMatchObject({ passed: 0, total: 1, holdoutPassed: 0, holdoutTotal: 2 });
    const [fix, shorter] = verdict.verdicts;
    expect(fix).toMatchObject({ variant: "p1", accepted: true, passed: 1, total: 1, holdoutPassed: 2, holdoutTotal: 2, regressions: [], findings: [] });
    expect(shorter).toMatchObject({ variant: "p2", accepted: false });
    expect(shorter!.notes[0]).toMatch(/Doesn't pass more often/);
    expect(verdict.winner).toBe("p1");

    const md = changesAsMarkdown(proposals[0]!.changes, [], verdict.baseline, fix);
    expect(md).toContain("| small | 0/3 | 3/3 |");
    expect(changesAsCode(proposals[0]!.changes, "ts")).toContain('.describe("IANA name, e.g. Asia/Tokyo")');
    expect(changesAsCode(proposals[0]!.changes, "python")).toContain('Field(description="IANA name, e.g. Asia/Tokyo", examples=["Asia/Tokyo","Europe/Paris"])');
  }, 60_000);

  it("stops early when nothing fails", async () => {
    const events: ImproveEvent[] = [];
    const baseline = [{ testId: "t1", llmId: "small", run: 1, passed: true, reasons: [], calls: [], text: "", durationMs: 1, runId: "x" }];
    for await (const e of sandbox.engine.improve({ workspaceId: "w", llmIds: ["small"], baseline }, ask)) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "done", message: expect.stringMatching(/nothing to improve/) });
  }, 30_000);
});
