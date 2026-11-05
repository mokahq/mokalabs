import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { conditionHolds, matchBreakpoint } from "@mokalabs/core";
import { startSandbox } from "../src/index.js";
import { startFakeLlm } from "./fake-llm.js";

describe("breakpoint conditions", () => {
  it("compare arguments simply, without running code", () => {
    expect(conditionHolds({ arg: "priority", op: "eq", value: "HIGH" }, { priority: "high" })).toBe(true);
    expect(conditionHolds({ arg: "issue.title", op: "contains", value: "prod" }, { issue: { title: "Prod is down" } })).toBe(true);
    expect(conditionHolds({ arg: "labels", op: "contains", value: "bug" }, { labels: ["bug", "p1"] })).toBe(true);
    expect(conditionHolds({ arg: "count", op: "gt", value: 5 }, { count: 3 })).toBe(false);
    expect(conditionHolds({ arg: "x", op: "exists" }, {})).toBe(false);
    const list = [{ id: "a", on: "before-tool" as const, tool: "get_time", when: { arg: "timezone", op: "contains" as const, value: "asia" } }, { id: "b", on: "model-step" as const, enabled: false }];
    expect(matchBreakpoint(list, { phase: "before-tool", tool: "get_time", serverId: "s", input: { timezone: "Asia/Tokyo" } })?.id).toBe("a");
    expect(matchBreakpoint(list, { phase: "before-tool", tool: "get_time", serverId: "s", input: { timezone: "Europe/Paris" } })).toBeUndefined();
    expect(matchBreakpoint(list, { phase: "model-step" })).toBeUndefined();
  });
});

describe("breakpoints in a run", () => {
  async function setup(breakpoints: unknown[]) {
    const fake = await startFakeLlm("moka-demo__get_time", { timezone: "Asia/Tokyo" });
    const home = mkdtempSync(path.join(os.tmpdir(), "moka-bp-"));
    const configPath = path.join(home, "moka.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      llms: [{ id: "a", name: "A", provider: "openai-compatible", model: "fake-a", baseURL: fake.baseURL }, { id: "b", name: "B", provider: "openai-compatible", model: "fake-b", baseURL: fake.baseURL }],
      mcpServers: [{ id: "moka-demo", name: "Demo", transport: "stdio", command: "moka:demo", protocol: "2025" }],
      workspaces: [{ id: "w", name: "W", llmId: "a", mcpServerIds: ["moka-demo"], skillIds: [], breakpoints, tests: [{ id: "t", prompt: "time in tokyo", expectTools: ["get_time"] }] }],
    }));
    const sb = await startSandbox({ port: 0, configPath, token: false, env: { ...process.env, MOKA_HOME: home }, ui: false });
    const chunks: any[] = [];
    const run = (async () => {
      for await (const c of sb.engine.chat({ messages: [{ role: "user", content: "time in tokyo" }] })) chunks.push(c);
    })();
    const paused = async () => {
      for (let i = 0; i < 200; i++) {
        const p = sb.engine.interactions.pending().find((x) => x.kind === "breakpoint");
        if (p) return p as any;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("never paused");
    };
    const close = async () => {
      await sb.close();
      await fake.close();
    };
    return { sb, fake, chunks, run, paused, close };
  }

  it("pauses before a tool, and runs it with edited arguments", async () => {
    const t = await setup([{ id: "bp1", on: "before-tool", tool: "get_time" }]);
    try {
      const p = await t.paused();
      expect(p).toMatchObject({ phase: "before-tool", tool: "get_time", input: { timezone: "Asia/Tokyo" }, breakpointId: "bp1" });
      expect(t.sb.engine.bus.history().some((e) => e.title === "Paused before get_time")).toBe(true);
      t.sb.engine.interactions.respond(p.id, { action: "continue", input: { timezone: "Europe/Paris" } });
      await t.run;
      const result = t.chunks.find((c) => c.type === "tool-result");
      expect(result.output).toMatch(/GMT\+1|GMT\+2|CET|CEST|Paris/);
      expect(result).toMatchObject({ edited: "arguments", input: { timezone: "Europe/Paris" } });
    } finally {
      await t.close();
    }
  }, 30_000);

  it("pauses after a tool: the model gets the edited result", async () => {
    const t = await setup([{ id: "bp", on: "after-tool" }]);
    try {
      const p = await t.paused();
      expect(p.phase).toBe("after-tool");
      expect(p.output).toMatch(/ISO:/);
      t.sb.engine.interactions.respond(p.id, { action: "continue", output: "EDITED AT BREAKPOINT" });
      await t.run;
      expect(t.fake.requests.at(-1).messages.find((m: any) => m.role === "tool").content).toBe("EDITED AT BREAKPOINT");
      expect(t.chunks.find((c) => c.type === "tool-result")).toMatchObject({ output: "EDITED AT BREAKPOINT", edited: "result" });
    } finally {
      await t.close();
    }
  }, 30_000);

  it("steps: after Step, it pauses again before the next model step; Stop ends the run", async () => {
    const t = await setup([{ id: "bp", on: "before-tool", tool: "moka-demo/get_time" }]);
    try {
      const first = await t.paused();
      t.sb.engine.interactions.respond(first.id, { action: "step" });
      await new Promise((r) => setTimeout(r, 50));
      const second = await t.paused();
      expect(second).toMatchObject({ phase: "model-step", step: 2 });
      expect(second.breakpointId).toBeUndefined();
      expect(second.messages.some((m: any) => m.role === "tool")).toBe(true);
      t.sb.engine.interactions.respond(second.id, { action: "stop" });
      await t.run;
      expect(t.chunks.at(-1)).toEqual({ type: "error", message: "Stopped at a breakpoint" });
    } finally {
      await t.close();
    }
  }, 30_000);

  it("switches model at a model-step breakpoint, and skips a tool", async () => {
    const t = await setup([{ id: "m", on: "model-step" }, { id: "s", on: "before-tool" }]);
    try {
      let p = await t.paused();
      expect(p).toMatchObject({ phase: "model-step", step: 1, model: "fake-a" });
      t.sb.engine.interactions.respond(p.id, { action: "continue", llmId: "b" });
      p = await t.paused();
      expect(p.phase).toBe("before-tool");
      expect(t.fake.requests.at(-1).model).toBe("fake-b");
      t.sb.engine.interactions.respond(p.id, { action: "skip" });
      p = await t.paused();
      expect(p).toMatchObject({ phase: "model-step", step: 2 });
      t.sb.engine.interactions.respond(p.id, { action: "continue" });
      await t.run;
      expect(t.chunks.find((c) => c.type === "tool-result").output).toMatch(/Skipped at a breakpoint/);
      expect(t.fake.requests.at(-1).model).toBe("fake-a");
    } finally {
      await t.close();
    }
  }, 30_000);

  it("never pauses tool tests", async () => {
    const t = await setup([{ id: "bp", on: "before-tool" }, { id: "m", on: "model-step" }]);
    try {
      const first = await t.paused();
      t.sb.engine.interactions.respond(first.id, { action: "continue" });
      const second = await t.paused();
      t.sb.engine.interactions.respond(second.id, { action: "continue" });
      const third = await t.paused();
      t.sb.engine.interactions.respond(third.id, { action: "continue" });
      await t.run;
      const results = [];
      for await (const r of t.sb.engine.runTests({ llmIds: ["a"], toolMode: "run" })) results.push(r);
      expect(results).toHaveLength(1);
      expect(t.sb.engine.interactions.pending()).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 30_000);
});
