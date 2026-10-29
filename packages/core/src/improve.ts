import { generateText } from "ai";
import { toolTokens } from "./budget.js";
import type { LlmProfile, McpServerConfig, ToolOverride, ToolTest } from "./config.js";
import type { McpTool } from "./mcp.js";
import { applyToolOverride, type ToolOverrides } from "./overrides.js";
import { createModel } from "./providers.js";
import { scanServer, type SecurityFinding } from "./security.js";
import { runToolTests, type TestHost, type TestResult } from "./tests.js";
import type { ToolMode } from "./agent.js";

/**
 * Improve: rewrite tool descriptions from tool-test failures, and keep only
 * rewrites that test better, model by model.
 *
 * 1. diagnose: failures grouped by tool and kind, in plain words.
 * 2. holdout: a few paraphrases of each test prompt, which the improver never
 *    sees, so a rewrite can't win by gaming the exact wording of the tests.
 * 3. propose: the improver model suggests 2–3 alternative sets of changes
 *    (descriptions, parameter descriptions and examples; never names or types).
 * 4. verify: each proposal runs on every test (and holdout) × model × run, with
 *    the new wording swapped in on Moka's side.
 * 5. score: pass rates before and after; rejected on regressions, new security
 *    findings, or a worse holdout score.
 */

/** Asks the improver model; returns its text. Swappable for tests. */
export type Ask = (prompt: string) => Promise<string>;

export function askModel(llm: LlmProfile, env?: NodeJS.ProcessEnv): Ask {
  return async (prompt) => (await generateText({ model: createModel(llm, env), maxOutputTokens: 4000, prompt })).text;
}

/** A tool as Improve sees it: which server it's on, and its current wording (with any saved override). */
export interface ImproveTool {
  serverId: string;
  serverName: string;
  tool: McpTool;
}

/* -------------------------------------------------------------- diagnose */

export type DiagnosisKind = "wrong-tool" | "missed-call" | "wrong-args" | "forbidden-call" | "answer" | "error";

export interface Diagnosis {
  kind: DiagnosisKind;
  /** The tool the failures are about (missing for answer and error failures). */
  tool?: string;
  testId: string;
  /** Models that failed this way, with failed / total runs. */
  models: Array<{ llmId: string; failed: number; runs: number }>;
  /** One line, e.g. `timezone got "Tokyo", expected "Asia/Tokyo"`. */
  detail: string;
}

/** Failures, grouped by test, kind and tool, most frequent first. */
export function diagnose(tests: ToolTest[], results: TestResult[]): Diagnosis[] {
  const byKey = new Map<string, Diagnosis>();
  const runs = new Map<string, number>();
  for (const r of results) runs.set(`${r.testId}\u0000${r.llmId}`, (runs.get(`${r.testId}\u0000${r.llmId}`) ?? 0) + 1);
  for (const r of results) {
    if (r.passed) continue;
    const test = tests.find((t) => t.id === r.testId);
    for (const reason of r.reasons) {
      const { kind, tool } = classify(reason, r, test);
      const key = `${r.testId}\u0000${kind}\u0000${tool ?? ""}`;
      const detail = kind === "error" ? reason.replace(/^(Error: )+/, "") : reason;
      const d = byKey.get(key) ?? { kind, ...(tool ? { tool } : {}), testId: r.testId, models: [], detail };
      const m = d.models.find((x) => x.llmId === r.llmId);
      if (m) m.failed++;
      else d.models.push({ llmId: r.llmId, failed: 1, runs: runs.get(`${r.testId}\u0000${r.llmId}`) ?? 1 });
      byKey.set(key, d);
    }
  }
  const weight = (d: Diagnosis) => d.models.reduce((n, m) => n + m.failed, 0);
  return [...byKey.values()].sort((a, b) => weight(b) - weight(a));
}

function classify(reason: string, result: TestResult, test?: ToolTest): { kind: DiagnosisKind; tool?: string } {
  let m: RegExpExecArray | null;
  if ((m = /^Didn't call (\S+)/.exec(reason))) {
    const called = result.calls.map((c) => c.tool).filter((t) => t !== m![1]);
    return { kind: called.length ? "wrong-tool" : "missed-call", tool: m[1] };
  }
  if ((m = /^Called (\S+), which it shouldn't/.exec(reason))) return { kind: "forbidden-call", tool: m[1] };
  if ((m = /^(\S+) got /.exec(reason))) return { kind: "wrong-args", tool: m[1] };
  if (/^Answer doesn't mention/.test(reason)) return { kind: "answer" };
  return { kind: "error", ...(test?.expectTools?.[0] ? { tool: test.expectTools[0] } : {}) };
}

/* --------------------------------------------------------------- holdout */

/**
 * Two (or `count`) paraphrases of each test: the same request and the same
 * expectations, worded differently. The improver never sees them.
 */
export async function holdoutTests(ask: Ask, tests: ToolTest[], count = 2): Promise<ToolTest[]> {
  if (!tests.length) return [];
  const text = await ask(`Rewrite each user request below ${count} different ways. Keep exactly the same meaning and every specific detail (names, places, numbers, dates), so the same tools and arguments are still right. Change the wording, order and tone, like different people asking.

${tests.map((t) => `${t.id}: ${t.prompt}`).join("\n")}

Reply with only a JSON object, no prose: {"<id>": ["rewrite 1", "rewrite 2"], ...}`);
  const parsed = parseJson<Record<string, unknown>>(text, "{");
  const out: ToolTest[] = [];
  for (const test of tests) {
    const rewrites = Array.isArray(parsed?.[test.id]) ? (parsed![test.id] as unknown[]) : [];
    rewrites
      .filter((p): p is string => typeof p === "string" && p.trim().length > 0 && p.trim() !== test.prompt)
      .slice(0, count)
      .forEach((prompt, i) => out.push({ ...test, id: `holdout:${test.id}:${i + 1}`, name: `${test.name ?? test.prompt} (reworded)`, prompt: prompt.trim() }));
  }
  return out;
}

/* --------------------------------------------------------------- propose */

export interface ProposedChange {
  serverId: string;
  tool: string;
  /** New description (the whole text), if it changes. */
  description?: string;
  /** New parameter descriptions and examples. */
  params?: Record<string, { description?: string; examples?: unknown[] }>;
  /** Why, in one sentence (from the improver). */
  reason: string;
}

export interface Proposal {
  id: string;
  summary: string;
  changes: ProposedChange[];
}

/** The overrides a proposal adds, on top of what's saved. */
export function proposalOverrides(proposal: Proposal, saved: ToolOverrides = {}): ToolOverrides {
  const out: ToolOverrides = structuredClone(saved);
  for (const c of proposal.changes) {
    const current = out[c.serverId]?.[c.tool] ?? {};
    const next: ToolOverride = {
      ...current,
      ...(c.description !== undefined ? { description: c.description } : {}),
      ...(c.params ? { params: { ...current.params, ...c.params } } : {}),
    };
    (out[c.serverId] ??= {})[c.tool] = next;
  }
  return out;
}

export async function propose(
  ask: Ask,
  input: { tools: ImproveTool[]; tests: ToolTest[]; results: TestResult[]; diagnosis: Diagnosis[]; count?: number },
): Promise<Proposal[]> {
  const count = input.count ?? 2;
  const failing = input.results.filter((r) => !r.passed).slice(0, 24);
  const passing = input.tests.filter((t) => input.results.some((r) => r.testId === t.id) && input.results.filter((r) => r.testId === t.id).every((r) => r.passed));
  const describeTool = ({ tool, serverName }: ImproveTool) => {
    const props = ((tool.inputSchema as any)?.properties ?? {}) as Record<string, any>;
    const params = Object.entries(props)
      .map(([name, p]) => `    - ${name} (${p?.type ?? "any"}${((tool.inputSchema as any)?.required ?? []).includes(name) ? ", required" : ""}): ${p?.description ?? "(no description)"}`)
      .join("\n");
    return `- ${tool.name} [server: ${serverName}]\n  description: ${tool.description ?? "(none)"}\n  parameters:\n${params || "    (none)"}`;
  };
  const failure = (r: TestResult) => {
    const test = input.tests.find((t) => t.id === r.testId);
    const calls = r.calls.length ? r.calls.map((c) => `${c.tool}(${JSON.stringify(c.input)})`).join(", ") : "no tool";
    return `- Request: "${test?.prompt}"\n  Model ${r.llmId} called: ${calls}\n  Problem: ${r.reasons.join("; ")}`;
  };
  const text = await ask(`You improve the descriptions of tools that an AI assistant uses (MCP tools), so that models pick the right tool and fill in the arguments correctly.

TOOLS
${input.tools.map(describeTool).join("\n")}

FAILURES (what models did wrong)
${failing.map(failure).join("\n") || "(none)"}

THESE ALREADY WORK, keep them working:
${passing.map((t) => `- "${t.prompt}" → ${[...(t.expectTools ?? [])].join(", ") || "no tool"}${t.forbidTools?.length ? ` (must not call ${t.forbidTools.join(", ")})` : ""}`).join("\n") || "(none)"}

Propose ${count} DIFFERENT sets of changes. Rules:
- Only change wording: tool descriptions, parameter descriptions, parameter examples. Never rename tools or parameters, change types, or change what's required.
- Write general guidance, not the test requests: say what the tool is for, what it is NOT for (point to the right tool), and what format each argument takes, with examples.
- Don't tell models to always or never use a tool, and don't mention other servers' tools except to say which tool to use instead.
- Keep each description under about 600 characters.

Reply with only JSON, no prose:
{"proposals": [{"summary": "one line: the idea of this set", "changes": [{"tool": "tool_name", "description": "the full new description (leave out to keep)", "params": {"param": {"description": "...", "examples": ["..."]}}, "reason": "one sentence: which failure this fixes"}]}]}`);
  const parsed = parseJson<{ proposals?: any[] }>(text, "{");
  const byName = new Map<string, ImproveTool[]>();
  for (const t of input.tools) byName.set(t.tool.name, [...(byName.get(t.tool.name) ?? []), t]);
  const proposals: Proposal[] = [];
  for (const [i, p] of (parsed?.proposals ?? []).entries()) {
    const changes: ProposedChange[] = [];
    for (const c of Array.isArray(p?.changes) ? p.changes : []) {
      const owners = byName.get(String(c?.tool ?? ""));
      if (owners?.length !== 1) continue; // unknown or ambiguous tool name
      const { serverId, tool } = owners[0]!;
      const props = ((tool.inputSchema as any)?.properties ?? {}) as Record<string, unknown>;
      const params = c.params && typeof c.params === "object"
        ? Object.fromEntries(
            Object.entries(c.params as Record<string, any>)
              .filter(([name, v]) => props[name] && v && typeof v === "object")
              .map(([name, v]) => [name, { ...(typeof v.description === "string" ? { description: v.description.trim() } : {}), ...(Array.isArray(v.examples) && v.examples.length ? { examples: v.examples.slice(0, 5) } : {}) }])
              .filter(([, v]) => Object.keys(v as object).length),
          )
        : undefined;
      const description = typeof c.description === "string" && c.description.trim() && c.description.trim() !== tool.description ? c.description.trim() : undefined;
      if (!description && !(params && Object.keys(params).length)) continue;
      changes.push({ serverId, tool: tool.name, ...(description ? { description } : {}), ...(params && Object.keys(params).length ? { params } : {}), reason: String(c.reason ?? "").trim() || "Clearer wording" });
    }
    if (changes.length) proposals.push({ id: `p${i + 1}`, summary: String(p?.summary ?? `Proposal ${i + 1}`).trim(), changes });
  }
  if (!proposals.length) throw new Error("The improver model didn't return usable changes. Try again, or pick a stronger model.");
  return proposals;
}

/* ---------------------------------------------------------------- verify */

/** One test run in Improve: the baseline (current wording) or a proposal. */
export interface ImproveResult extends TestResult {
  variant: string;
  holdout: boolean;
}

/**
 * Runs the holdout tests on the current wording, then every proposal on all
 * tests and holdout tests, streaming results as they finish. `baseline`:
 * results for the visible tests that are already known (from the Tests view).
 */
export async function* verify(
  host: TestHost,
  input: { workspaceId?: string; llmIds: string[]; runs: number; toolMode?: ToolMode; tests: ToolTest[]; holdout: ToolTest[]; proposals: Proposal[]; saved?: ToolOverrides; baseline?: TestResult[]; signal?: AbortSignal },
): AsyncGenerator<ImproveResult> {
  const common = { workspaceId: input.workspaceId, llmIds: input.llmIds, runs: input.runs, toolMode: input.toolMode, signal: input.signal };
  const isHoldout = (r: TestResult) => r.testId.startsWith("holdout:");
  const baselineTests = input.baseline?.length ? input.holdout : [...input.tests, ...input.holdout];
  if (baselineTests.length) for await (const r of runToolTests(host, { ...common, tests: baselineTests })) yield { ...r, variant: "baseline", holdout: isHoldout(r) };
  for (const proposal of input.proposals) {
    if (input.signal?.aborted) return;
    const toolOverrides = proposalOverrides(proposal, input.saved);
    for await (const r of runToolTests(host, { ...common, tests: [...input.tests, ...input.holdout], toolOverrides })) yield { ...r, variant: proposal.id, holdout: isHoldout(r) };
  }
}

/* ----------------------------------------------------------------- score */

export interface VariantScore {
  variant: string;
  passed: number;
  total: number;
  holdoutPassed: number;
  holdoutTotal: number;
  perModel: Array<{ llmId: string; passed: number; total: number }>;
}

export interface ProposalVerdict extends VariantScore {
  accepted: boolean;
  /** Why it was rejected (or warnings), one line each. */
  notes: string[];
  regressions: string[];
  findings: SecurityFinding[];
  /** Estimated tokens of the changed tools, before → after. */
  tokens: { before: number; after: number };
}

export function scoreVariant(variant: string, results: ImproveResult[]): VariantScore {
  const mine = results.filter((r) => r.variant === variant);
  const visible = mine.filter((r) => !r.holdout);
  const held = mine.filter((r) => r.holdout);
  const models = [...new Set(mine.map((r) => r.llmId))];
  return {
    variant,
    passed: visible.filter((r) => r.passed).length,
    total: visible.length,
    holdoutPassed: held.filter((r) => r.passed).length,
    holdoutTotal: held.length,
    perModel: models.map((llmId) => {
      const rs = mine.filter((r) => r.llmId === llmId);
      return { llmId, passed: rs.filter((r) => r.passed).length, total: rs.length };
    }),
  };
}

/**
 * Accept a proposal only if it passes more often overall, isn't worse on the
 * holdout prompts, breaks nothing that worked, and adds no security findings.
 */
export function judge(input: { results: ImproveResult[]; proposals: Proposal[]; tools: ImproveTool[]; tests: ToolTest[]; runs: number; servers: Pick<McpServerConfig, "id" | "name">[] }): { baseline: VariantScore; verdicts: ProposalVerdict[]; winner?: string } {
  const baselineResults = input.results.filter((r) => r.variant === "baseline");
  const baseline = scoreVariant("baseline", input.results);
  const rate = (p: number, t: number) => (t ? p / t : 0);
  const verdicts = input.proposals.map((proposal): ProposalVerdict => {
    const score = scoreVariant(proposal.id, input.results);
    const mine = input.results.filter((r) => r.variant === proposal.id);
    const notes: string[] = [];
    // Regressions: a test that passed every run on a model before, and now fails more than noise allows.
    const allowance = input.runs >= 3 ? 1 : 0;
    const regressions: string[] = [];
    const keys = new Set(baselineResults.filter((r) => !r.holdout).map((r) => `${r.testId}\u0000${r.llmId}`));
    for (const key of keys) {
      const [testId, llmId] = key.split("\u0000") as [string, string];
      const before = baselineResults.filter((r) => r.testId === testId && r.llmId === llmId);
      const after = mine.filter((r) => r.testId === testId && r.llmId === llmId);
      if (!after.length || !before.every((r) => r.passed)) continue;
      const failed = after.filter((r) => !r.passed).length;
      const test = input.tests.find((t) => t.id === testId);
      const strict = Boolean(test?.forbidTools?.length);
      if (failed > (strict ? 0 : allowance)) regressions.push(`${test?.name ?? test?.prompt ?? testId} now fails ${failed}/${after.length} on ${llmId}`);
    }
    // Security: the new wording must not trip the checks the server's own text passes.
    const findings: SecurityFinding[] = [];
    const overrides = proposalOverrides(proposal);
    for (const server of input.servers) {
      const tools = input.tools.filter((t) => t.serverId === server.id).map((t) => t.tool);
      if (!tools.length || !overrides[server.id]) continue;
      const before = new Set(scanServer({ name: server.name, tools }).map((f) => `${f.id}\u0000${f.where}`));
      const after = scanServer({ name: server.name, tools: tools.map((t) => applyToolOverride(t, overrides[server.id]![t.name])) });
      findings.push(...after.filter((f) => !before.has(`${f.id}\u0000${f.where}`) && (f.severity === "high" || f.severity === "medium")));
    }
    // Tokens for the tools it changes.
    const changed = input.tools.filter((t) => overrides[t.serverId]?.[t.tool.name]);
    const tokensOf = (tool: McpTool, key: string) => toolTokens(key, tool.description ?? tool.name, tool.inputSchema ?? {});
    const tokens = {
      before: changed.reduce((n, t) => n + tokensOf(t.tool, t.tool.name), 0),
      after: changed.reduce((n, t) => n + tokensOf(applyToolOverride(t.tool, overrides[t.serverId]![t.tool.name]), t.tool.name), 0),
    };
    const better = rate(score.passed + score.holdoutPassed, score.total + score.holdoutTotal) > rate(baseline.passed + baseline.holdoutPassed, baseline.total + baseline.holdoutTotal);
    const holdoutOk = rate(score.holdoutPassed, score.holdoutTotal) >= rate(baseline.holdoutPassed, baseline.holdoutTotal);
    if (!better) notes.push("Doesn't pass more often than the current wording.");
    if (!holdoutOk) notes.push("Worse on the reworded prompts: it may only fit the exact test wording.");
    if (regressions.length) notes.push(`Breaks ${regressions.length} test${regressions.length === 1 ? "" : "s"} that passed before.`);
    if (findings.length) notes.push(`The security check flags the new wording (${findings.map((f) => f.title).join(", ")}).`);
    if (tokens.before && tokens.after > tokens.before * 1.5) notes.push(`Makes these tools ${Math.round((tokens.after / tokens.before - 1) * 100)}% longer.`);
    const accepted = better && holdoutOk && !regressions.length && !findings.length;
    return { ...score, accepted, notes, regressions, findings, tokens };
  });
  const winner = verdicts
    .filter((v) => v.accepted)
    .sort((a, b) => rate(b.passed + b.holdoutPassed, b.total + b.holdoutTotal) - rate(a.passed + a.holdoutPassed, a.total + a.holdoutTotal))[0]?.variant;
  return { baseline, verdicts, ...(winner ? { winner } : {}) };
}

/* ------------------------------------------------------------ copy as code */

/** The accepted changes as code for the server, for the TypeScript SDK or Python (FastMCP). */
export function changesAsCode(changes: ProposedChange[], language: "ts" | "python"): string {
  const blocks = changes.map((c) => {
    const params = Object.entries(c.params ?? {});
    if (language === "ts") {
      return [
        `// ${c.tool}`,
        `server.registerTool(${JSON.stringify(c.tool)}, {`,
        ...(c.description ? [`  description: ${JSON.stringify(c.description)},`] : []),
        ...(params.length
          ? [`  inputSchema: {`, ...params.map(([name, p]) => `    ${name}: /* your type */.describe(${JSON.stringify(p.description ?? "")})${p.examples?.length ? ` // e.g. ${p.examples.map((e) => JSON.stringify(e)).join(", ")}` : ""},`), `  },`]
          : []),
        `}, handler);`,
      ].join("\n");
    }
    return [
      `# ${c.tool}`,
      `@mcp.tool()`,
      params.length
        ? [`def ${c.tool}(`, ...params.map(([name, p]) => `    ${name}: Annotated[..., Field(description=${JSON.stringify(p.description ?? "")}${p.examples?.length ? `, examples=${JSON.stringify(p.examples)}` : ""})],`), `):`].join("\n")
        : `def ${c.tool}():`,
      `    """${(c.description ?? "").replace(/"""/g, '\\"\\"\\"')}"""`,
    ].join("\n");
  });
  return blocks.join("\n\n");
}

/** The accepted changes as Markdown, for a pull request. */
export function changesAsMarkdown(changes: ProposedChange[], tools: ImproveTool[], before?: VariantScore, after?: VariantScore): string {
  const lines = ["## Tool wording (Moka Improve)", ""];
  if (before && after) {
    lines.push("| Model | Before | After |", "|---|---|---|");
    for (const m of after.perModel) {
      const b = before.perModel.find((x) => x.llmId === m.llmId);
      lines.push(`| ${m.llmId} | ${b ? `${b.passed}/${b.total}` : "–"} | ${m.passed}/${m.total} |`);
    }
    lines.push("");
  }
  for (const c of changes) {
    const old = tools.find((t) => t.serverId === c.serverId && t.tool.name === c.tool)?.tool;
    lines.push(`### \`${c.tool}\``, "", `_${c.reason}_`, "");
    if (c.description) lines.push("```diff", `- ${old?.description ?? ""}`, `+ ${c.description}`, "```", "");
    for (const [name, p] of Object.entries(c.params ?? {})) {
      const was = ((old?.inputSchema as any)?.properties?.[name]?.description as string | undefined) ?? "";
      lines.push(`- \`${name}\`: ${p.description ?? was}${p.examples?.length ? ` (e.g. ${p.examples.map((e) => `\`${JSON.stringify(e)}\``).join(", ")})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/* -------------------------------------------------------------- the flow */

export type ImproveEvent =
  | { type: "start"; improver: { id: string; name: string; model: string }; tests: number; models: string[]; runs: number; estimatedRuns: number }
  | { type: "phase"; phase: "baseline" | "diagnosis" | "holdout" | "proposals" | "verify" | "verdict" }
  | { type: "result"; result: ImproveResult }
  | { type: "diagnosis"; diagnosis: Diagnosis[] }
  | { type: "holdout"; tests: ToolTest[] }
  | { type: "proposals"; proposals: Proposal[] }
  | { type: "verdict"; baseline: VariantScore; verdicts: ProposalVerdict[]; winner?: string }
  | { type: "done"; message?: string };

export interface ImproveOptions {
  workspaceId?: string;
  llmIds: string[];
  runs?: number;
  toolMode?: ToolMode;
  /** Model that writes the proposals (default: the strongest one configured). */
  improverId?: string;
  /** How many alternative proposals (default 2). */
  proposals?: number;
  /** Paraphrases per test that the improver never sees (default 2; 0 turns the holdout off). */
  holdout?: number;
  testIds?: string[];
  /** Results for the visible tests already run on these models (the Tests view), so they aren't run again. */
  baseline?: TestResult[];
  signal?: AbortSignal;
}

/** What Improve needs from the engine. */
export interface ImproveHost extends TestHost {
  improveContext(workspaceId?: string): Promise<{ workspaceId: string; tests: ToolTest[]; tools: ImproveTool[]; servers: Pick<McpServerConfig, "id" | "name">[]; saved: ToolOverrides; llms: LlmProfile[]; workspaceLlmId?: string; env?: NodeJS.ProcessEnv }>;
}

export async function* runImprove(host: ImproveHost, options: ImproveOptions, ask?: Ask): AsyncGenerator<ImproveEvent> {
  const ctx = await host.improveContext(options.workspaceId);
  const tests = ctx.tests.filter((t) => !options.testIds || options.testIds.includes(t.id));
  if (!tests.length) throw new Error("This workspace has no tool tests yet. Write or suggest some in the Tests view first.");
  if (!ctx.tools.length) throw new Error("This workspace has no connected MCP tools.");
  const improver = (options.improverId ? ctx.llms.find((l) => l.id === options.improverId) : undefined) ?? pickImprover(ctx.llms, ctx.workspaceLlmId);
  if (!improver) throw new Error("No model configured to write proposals. Add one in Settings → Models.");
  const runs = Math.max(1, Math.min(20, options.runs ?? 1));
  const proposalsWanted = options.proposals ?? 2;
  const holdoutCount = options.holdout ?? 2;
  const llmIds = options.llmIds;
  const baselineKnown = options.baseline?.filter((r) => llmIds.includes(r.llmId) && tests.some((t) => t.id === r.testId)) ?? [];
  const perPass = tests.length * llmIds.length * runs;
  const holdoutPass = tests.length * holdoutCount * llmIds.length * runs;
  yield {
    type: "start",
    improver: { id: improver.id, name: improver.name, model: improver.model },
    tests: tests.length,
    models: llmIds,
    runs,
    estimatedRuns: (baselineKnown.length ? 0 : perPass) + holdoutPass + proposalsWanted * (perPass + holdoutPass),
  };
  const say = ask ?? askModel(improver, ctx.env);
  const common = { workspaceId: ctx.workspaceId, llmIds, runs, toolMode: options.toolMode, signal: options.signal };

  // 1. Baseline on the visible tests (unless the Tests view already has it).
  const results: ImproveResult[] = baselineKnown.map((r) => ({ ...r, variant: "baseline", holdout: false }));
  if (!baselineKnown.length) {
    yield { type: "phase", phase: "baseline" };
    for await (const r of runToolTests(host, { ...common, tests })) {
      const result = { ...r, variant: "baseline", holdout: false };
      results.push(result);
      yield { type: "result", result };
    }
  }

  // 2. What goes wrong.
  yield { type: "phase", phase: "diagnosis" };
  const diagnosis = diagnose(tests, results);
  yield { type: "diagnosis", diagnosis };
  if (!diagnosis.length) {
    yield { type: "done", message: "Every test passed on every model: nothing to improve. Add harder tests, more runs, or smaller models." };
    return;
  }

  // 3. Reworded prompts the improver never sees.
  yield { type: "phase", phase: "holdout" };
  const holdout = holdoutCount > 0 ? await holdoutTests(say, tests, holdoutCount).catch(() => []) : [];
  yield { type: "holdout", tests: holdout };

  // 4. Proposals.
  yield { type: "phase", phase: "proposals" };
  const proposals = await propose(say, { tools: ctx.tools, tests, results, diagnosis, count: proposalsWanted });
  yield { type: "proposals", proposals };

  // 5. Verify each one, with the wording swapped in.
  yield { type: "phase", phase: "verify" };
  for await (const result of verify(host, { ...common, tests, holdout, proposals, saved: ctx.saved, baseline: results })) {
    results.push(result);
    yield { type: "result", result };
  }

  // 6. The verdict.
  yield { type: "phase", phase: "verdict" };
  yield { type: "verdict", ...judge({ results, proposals, tools: ctx.tools, tests, runs, servers: ctx.servers }) };
  yield { type: "done" };
}

/* --------------------------------------------------------------- helpers */

/** The strongest configured model for rewriting: hosted frontier providers first, the workspace's model otherwise. */
export function pickImprover(llms: LlmProfile[], fallbackId?: string): LlmProfile | undefined {
  const rank = (l: LlmProfile) => (["anthropic", "openai", "google", "azure"].includes(l.provider) ? 0 : l.provider === "openai-compatible" && !/localhost|127\.0\.0\.1/.test(l.baseURL ?? "") ? 1 : 2);
  return [...llms].sort((a, b) => rank(a) - rank(b))[0] ?? llms.find((l) => l.id === fallbackId);
}

function parseJson<T>(text: string, open: "{" | "["): T | undefined {
  const close = open === "{" ? "}" : "]";
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}
