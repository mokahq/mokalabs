import { generateText } from "ai";
import type { ChatChunk, ToolMode } from "./agent.js";
import type { LlmProfile, ToolTest } from "./config.js";
import type { McpTool } from "./mcp.js";
import { createModel } from "./providers.js";

/**
 * Tool tests: does a model call the right tools, with the right arguments, for
 * a prompt? Each test runs on several models (and several times, since models
 * aren't deterministic), and gets graded on what the model actually did.
 */

export interface TestCall {
  tool: string;
  server?: string;
  input: unknown;
}

export interface TestResult {
  testId: string;
  llmId: string;
  /** 1-based run number (tests can run several times per model). */
  run: number;
  passed: boolean;
  /** Why it failed, one line each (empty when it passed). */
  reasons: string[];
  calls: TestCall[];
  text: string;
  durationMs: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  error?: string;
  runId: string;
}

export interface RunTestsOptions {
  workspaceId?: string;
  llmIds: string[];
  /** Runs per test and model (default 1). */
  runs?: number;
  /** Which MCP tools really run (default: only read-only ones). */
  toolMode?: ToolMode;
  /** Only these tests (default all of the workspace's). */
  testIds?: string[];
  /** Models run in parallel with each other, each model's tests one at a time. */
  signal?: AbortSignal;
}

/** The engine features the runner needs (MokaEngine has them). */
export interface TestHost {
  workspace(id?: string): { id: string; tests?: ToolTest[] };
  chat(request: { messages: any[]; workspaceId?: string; llmId?: string; signal?: AbortSignal; runId?: string; toolMode?: ToolMode }): AsyncGenerator<ChatChunk>;
}

const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);

/** `actual` has everything in `expected` (objects partially, strings ignoring case and surrounding spaces). */
export function matches(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return lower(actual) === lower(expected) || (typeof expected === "number" && Number(actual) === expected);
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((e, i) => matches(actual[i], e));
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(([k, v]) => matches((actual as Record<string, unknown>)[k], v));
}

export function grade(test: ToolTest, calls: TestCall[], text: string, error?: string): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (error) reasons.push(`Error: ${error}`);
  const called = new Set(calls.map((c) => c.tool));
  for (const tool of test.expectTools ?? []) if (!called.has(tool)) reasons.push(`Didn't call ${tool}`);
  for (const tool of test.forbidTools ?? []) if (called.has(tool)) reasons.push(`Called ${tool}, which it shouldn't`);
  for (const [tool, args] of Object.entries(test.expectArgs ?? {})) {
    const attempts = calls.filter((c) => c.tool === tool);
    if (!attempts.length) {
      if (!(test.expectTools ?? []).includes(tool)) reasons.push(`Didn't call ${tool}`);
      continue;
    }
    if (!attempts.some((c) => matches(c.input, args))) {
      const got = JSON.stringify(attempts[attempts.length - 1]!.input);
      reasons.push(`${tool} got ${got.length > 160 ? `${got.slice(0, 160)}…` : got}, expected ${JSON.stringify(args)}`);
    }
  }
  for (const part of test.answerIncludes ?? []) if (!text.toLowerCase().includes(part.toLowerCase())) reasons.push(`Answer doesn't mention "${part}"`);
  return { passed: reasons.length === 0, reasons };
}

async function runOne(host: TestHost, test: ToolTest, llmId: string, run: number, options: RunTestsOptions): Promise<TestResult> {
  const runId = `test_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const started = Date.now();
  const calls: TestCall[] = [];
  let text = "";
  let error: string | undefined;
  let usage: TestResult["usage"];
  try {
    for await (const chunk of host.chat({ messages: [{ role: "user", content: test.prompt }], workspaceId: options.workspaceId, llmId, signal: options.signal, runId, toolMode: options.toolMode ?? "read-only" })) {
      if (chunk.type === "tool-call") calls.push({ tool: chunk.tool, server: chunk.source, input: chunk.input });
      else if (chunk.type === "text") text += chunk.text;
      else if (chunk.type === "finish") usage = chunk.usage as TestResult["usage"];
      else if (chunk.type === "error") error = chunk.message;
    }
  } catch (e: any) {
    error = e?.message ?? String(e);
  }
  const { passed, reasons } = grade(test, calls, text, error);
  return { testId: test.id, llmId, run, passed, reasons, calls, text, durationMs: Date.now() - started, ...(usage ? { usage } : {}), ...(error ? { error } : {}), runId };
}

/** Run a workspace's tool tests on several models; results arrive as each run finishes. */
export async function* runToolTests(host: TestHost, options: RunTestsOptions): AsyncGenerator<TestResult> {
  const workspace = host.workspace(options.workspaceId);
  const tests = (workspace.tests ?? []).filter((t) => !options.testIds || options.testIds.includes(t.id));
  const runs = Math.max(1, Math.min(20, options.runs ?? 1));
  const queue: TestResult[] = [];
  let wake: (() => void) | undefined;
  let pending = options.llmIds.length;
  // One worker per model: a model's tests run one after another (local models serve one request at a time).
  for (const llmId of options.llmIds) {
    void (async () => {
      try {
        for (const test of tests) {
          for (let run = 1; run <= runs; run++) {
            if (options.signal?.aborted) return;
            queue.push(await runOne(host, test, llmId, run, { ...options, workspaceId: workspace.id }));
            wake?.();
          }
        }
      } finally {
        pending--;
        wake?.();
      }
    })();
  }
  while (pending > 0 || queue.length) {
    if (queue.length) yield queue.shift()!;
    else await new Promise<void>((resolve) => (wake = resolve));
  }
}

export interface TestSummary {
  llmId: string;
  passed: number;
  total: number;
  avgMs: number;
  avgTokens?: number;
}

export function summarize(results: TestResult[]): TestSummary[] {
  const by = new Map<string, TestResult[]>();
  for (const r of results) by.set(r.llmId, [...(by.get(r.llmId) ?? []), r]);
  return [...by].map(([llmId, rs]) => {
    const tokens = rs.map((r) => r.usage?.totalTokens).filter((n): n is number => typeof n === "number");
    return {
      llmId,
      passed: rs.filter((r) => r.passed).length,
      total: rs.length,
      avgMs: Math.round(rs.reduce((n, r) => n + r.durationMs, 0) / rs.length),
      ...(tokens.length ? { avgTokens: Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) } : {}),
    };
  });
}

/** Ask a model to propose tests for a set of tools: typical requests, plus a few where no tool (or a specific one) shouldn't be used. */
export async function suggestTests(llm: LlmProfile, tools: Array<Pick<McpTool, "name" | "description" | "inputSchema">>, options: { count?: number; env?: NodeJS.ProcessEnv; existing?: string[] } = {}): Promise<Omit<ToolTest, "id">[]> {
  const count = options.count ?? 6;
  const list = tools.map((t) => `- ${t.name}: ${(t.description ?? "").slice(0, 300)}\n  parameters: ${JSON.stringify((t.inputSchema as any)?.properties ?? {}).slice(0, 400)}`).join("\n");
  const { text } = await generateText({
    model: createModel(llm, options.env),
    maxOutputTokens: 2000,
    prompt: `You write test cases for an AI assistant that can use these tools:

${list}

Write ${count} realistic user requests that test whether the assistant picks the right tool with the right arguments. Mix them:
- most need exactly one tool, with specific arguments,
- one or two need two tools,
- one or two should NOT use a particular tool (or any tool), e.g. a question the assistant can answer itself.
${options.existing?.length ? `\nDon't repeat these existing tests:\n${options.existing.map((p) => `- ${p}`).join("\n")}\n` : ""}
Reply with only a JSON array, no prose. Each item:
{"name": "short name", "prompt": "the user's request", "expectTools": ["tool_name"], "forbidTools": ["tool_name"], "expectArgs": {"tool_name": {"param": "value"}}}
Leave out fields that don't apply. Only use tool names from the list. Only put arguments in expectArgs that have exactly one right value.`,
  });
  const json = /\[[\s\S]*\]/.exec(text)?.[0];
  if (!json) throw new Error("The model didn't return a list of tests. Try again, or with another model.");
  const names = new Set(tools.map((t) => t.name));
  const parsed = JSON.parse(json) as any[];
  return parsed
    .filter((t) => t && typeof t.prompt === "string" && t.prompt.trim())
    .map((t) => {
      const known = (list: unknown) => (Array.isArray(list) ? list.filter((n): n is string => typeof n === "string" && names.has(n)) : []);
      const expectTools = known(t.expectTools);
      const forbidTools = known(t.forbidTools);
      const expectArgs = t.expectArgs && typeof t.expectArgs === "object" ? Object.fromEntries(Object.entries(t.expectArgs).filter(([k, v]) => names.has(k) && v && typeof v === "object")) : {};
      return {
        ...(typeof t.name === "string" && t.name.trim() ? { name: t.name.trim().slice(0, 80) } : {}),
        prompt: t.prompt.trim(),
        ...(expectTools.length ? { expectTools } : {}),
        ...(forbidTools.length ? { forbidTools } : {}),
        ...(Object.keys(expectArgs).length ? { expectArgs: expectArgs as Record<string, Record<string, unknown>> } : {}),
      };
    })
    // A test that checks nothing (its tools didn't exist) would always pass.
    .filter((t) => t.expectTools || t.forbidTools || t.expectArgs)
    .slice(0, count);
}
