#!/usr/bin/env node
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { trustSystemCertificates } from "./system-ca.js";

const HELP = `
  ☕ moka — any LLM, any MCP server, any skill. One command.

  Usage
    npx @mokalabs/sandbox [config.json] [options]
    moka [config.json] [options]
    moka init                 write a starter moka.json in this folder
    moka demo-server          run the bundled demo MCP server on stdio
    moka demo-agent [--port]  run a demo A2A + AG-UI agent (default port 4100)
    moka test [config.json]   run the workspace's tool tests; exit code 1 if any fail (for CI)
    moka improve [config]     rewrite tool descriptions from test failures and prove them on the tests
    moka mock <recording>     serve a recording (.jsonl) as an MCP server on stdio

  moka test
    -m, --models <a,b>        model ids, names or model names (default: the workspace's model)
    -w, --workspace <id>      workspace (default: the active one)
        --runs <n>            runs per test and model, to catch flaky behaviour (default 1)
        --tools <mode>        read-only (default): only tools marked read-only really run;
                              run: every tool runs; none: no tool runs
        --json                print results as JSON
        --min-pass <0-1>      exit 1 only below this pass rate (default 1: any failure)
        --markdown <file>     write the scorecard as Markdown (for a PR comment or job summary)
        --baseline <file>     compare with a saved --json run and show the change per model

  moka improve                same -m, -w, --runs, --tools as moka test, plus
        --improver <id>       model that writes the proposals (default: the strongest configured)
        --proposals <n>       alternative proposals to try (default 2)
        --apply               save the winning wording as toolOverrides in the config
        --markdown <file>     write the accepted changes as Markdown
        --json                print the events as JSON lines

  Options
    -p, --port <n>            port to listen on (default 4000, or $PORT)
    -H, --host <host>         interface to bind (default 127.0.0.1; use 0.0.0.0 in Docker)
    -c, --config <file>       config file (default ./moka.json, else ~/.moka/config.json)
        --token <token>       fixed access token (default: random, or $MOKA_TOKEN)
        --no-auth             disable the access token (only on trusted machines!)
        --no-open             don't open the browser
        --proxy <url>         send model/MCP traffic through this HTTP(S) proxy
                              (default: $HTTPS_PROXY / $HTTP_PROXY; $NO_PROXY is honoured)
        --no-system-ca        don't trust the OS certificate store (keychain / Windows store)
    -v, --version             print version
    -h, --help                show this help

  Environment
    OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY …
    are detected automatically on first run. Ollama on localhost is detected too.
    HTTPS_PROXY / HTTP_PROXY / NO_PROXY and NODE_EXTRA_CA_CERTS work behind corporate networks.
    Certificates trusted by your OS (company CAs included) are trusted too, on Node 22.15+.
`;

function proxyFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || undefined;
}

/** Node can route fetch() through HTTP(S)_PROXY natively from 22.21 / 24. */
function nodeSupportsEnvProxy(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major >= 24 || (major === 22 && minor >= 21);
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * Restart this process with settings Node only reads at startup:
 * - proxy: NODE_USE_ENV_PROXY=1, so every fetch (LLM providers, HTTP MCP
 *   servers, catalogs) goes through it. Local addresses always bypass it so
 *   Ollama and the UI keep working.
 * - systemCa: --use-system-ca, on Node versions that can't load the OS
 *   certificate store at runtime.
 */
function relaunch(argv: string[], options: { proxy?: string; systemCa?: boolean }): void {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const flags = [...process.execArgv];
  if (options.proxy) {
    const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, "localhost", "127.0.0.1", "::1"].filter(Boolean).join(",");
    Object.assign(env, { NODE_USE_ENV_PROXY: "1", NO_PROXY: noProxy, no_proxy: noProxy });
    if (!proxyFromEnv(process.env)) Object.assign(env, { HTTPS_PROXY: options.proxy, HTTP_PROXY: options.proxy });
    flags.unshift("--disable-warning=UNDICI-EHPA");
  }
  if (options.systemCa) {
    flags.push("--use-system-ca");
    env.NODE_USE_SYSTEM_CA = "1";
  }
  const child = spawn(process.execPath, [...flags, process.argv[1]!, ...argv], { stdio: "inherit", env });
  // The terminal delivers Ctrl+C to the child too; just wait for it to exit.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

/** Open a URL in the default browser without extra dependencies. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // headless / no browser: the URL is printed anyway
    child.unref();
  } catch {
    // ignore
  }
}

/** `moka test`: run a workspace's tool tests on one or more models, for CI. Returns the exit code. */
type TestFlags = { models?: string; workspace?: string; runs?: string; tools?: string; json?: boolean; markdown?: string; "min-pass"?: string; baseline?: string; improver?: string; proposals?: string; apply?: boolean };

type Baseline = { summary: Array<{ llmId: string; passed: number; total: number }> };

const percent = (passed: number, total: number) => (total ? Math.round((passed / total) * 100) : 0);

/** The scorecard as Markdown: a headline, one row per model, failures folded away. */
function scorecardMarkdown(input: { workspace: string; summary: Array<{ llmId: string; passed: number; total: number; avgMs: number }>; label: Map<string, string>; failures: Array<{ model: string; test: string; reasons: string[] }>; baseline?: Baseline; ok: boolean }): string {
  const passed = input.summary.reduce((n, s) => n + s.passed, 0);
  const total = input.summary.reduce((n, s) => n + s.total, 0);
  const vs = (llmId: string, now: number, total: number) => {
    const b = input.baseline?.summary.find((s) => s.llmId === llmId);
    if (!b) return "–";
    const delta = percent(now, total) - percent(b.passed, b.total);
    return `${b.passed}/${b.total} → ${now}/${total} (${delta > 0 ? "+" : ""}${delta} pts)`;
  };
  const lines = [`### ${input.ok ? "✅" : "❌"} Moka tool tests: ${passed}/${total} passed (${percent(passed, total)}%)`, "", `Workspace: ${input.workspace}`, ""];
  lines.push(input.baseline ? "| Model | Passed | % | vs baseline | Avg time |" : "| Model | Passed | % | Avg time |", input.baseline ? "|---|---|---|---|---|" : "|---|---|---|---|");
  for (const s of input.summary) {
    const cells = [input.label.get(s.llmId) ?? s.llmId, `${s.passed}/${s.total}`, `${percent(s.passed, s.total)}%`, ...(input.baseline ? [vs(s.llmId, s.passed, s.total)] : []), `${(s.avgMs / 1000).toFixed(1)}s`];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  if (input.failures.length) {
    lines.push("", `<details><summary>${input.failures.length} failed run${input.failures.length === 1 ? "" : "s"}</summary>`, "");
    for (const f of input.failures) lines.push(`- **${f.model}** · ${f.test}${f.reasons.length ? `: ${f.reasons.join("; ")}` : ""}`);
    lines.push("", "</details>");
  }
  return lines.join("\n") + "\n";
}

async function runTests(configPath: string | undefined, values: TestFlags): Promise<number> {
  const { startSandbox } = await import("./index.js");
  const { summarize } = await import("@mokalabs/core");
  const toolMode = (values.tools ?? "read-only") as "run" | "read-only" | "none";
  if (!["run", "read-only", "none"].includes(toolMode)) {
    console.error(`✗ --tools must be run, read-only or none`);
    return 2;
  }
  const runs = values.runs ? Number(values.runs) : 1;
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) {
    console.error(`✗ --runs must be a whole number from 1 to 20`);
    return 2;
  }
  const minPass = values["min-pass"] !== undefined ? Number(values["min-pass"]) : 1;
  if (!Number.isFinite(minPass) || minPass < 0 || minPass > 1) {
    console.error(`✗ --min-pass must be a number from 0 to 1 (e.g. 0.9)`);
    return 2;
  }
  let baseline: Baseline | undefined;
  if (values.baseline) {
    try {
      baseline = JSON.parse(await readFile(values.baseline, "utf8")) as Baseline;
      if (!Array.isArray(baseline.summary)) throw new Error("no summary");
    } catch (error) {
      console.error(`✗ Can't read the baseline ${values.baseline}: ${error instanceof Error ? error.message : String(error)}. Save one with \`moka test --json > baseline.json\`.`);
      return 2;
    }
  }
  const sandbox = await startSandbox({ port: 0, host: "127.0.0.1", configPath, token: false, ui: false });
  try {
    const engine = sandbox.engine;
    const config = engine.getConfig();
    const workspace = engine.workspace(values.workspace);
    if (values.workspace && workspace.id !== values.workspace) {
      console.error(`✗ No workspace "${values.workspace}". Workspaces: ${config.workspaces.map((w) => w.id).join(", ")}`);
      return 2;
    }
    const tests = workspace.tests ?? [];
    if (!tests.length) {
      console.error(`✗ Workspace "${workspace.name}" has no tests. Add some in Moka's Tests view, or under "tests" in ${sandbox.configPath}.`);
      return 2;
    }
    const wanted = values.models ? values.models.split(",").map((m) => m.trim()).filter(Boolean) : [workspace.llmId ?? config.llms[0]?.id].filter((m): m is string => !!m);
    const llms = wanted.map((m) => config.llms.find((l) => l.id === m || l.name === m || l.model === m));
    const missing = wanted.filter((_, i) => !llms[i]);
    if (missing.length || !llms.length) {
      console.error(`✗ Unknown model${missing.length === 1 ? "" : "s"}: ${missing.join(", ") || "(none configured)"}. Models: ${config.llms.map((l) => l.id).join(", ")}`);
      return 2;
    }
    const label = new Map(llms.map((l) => [l!.id, `${l!.name} (${l!.model})`]));
    const name = new Map(tests.map((t) => [t.id, t.name ?? t.prompt.slice(0, 60)]));
    const tty = process.stdout.isTTY && !values.json;
    const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
    const [green, red, dim] = [paint(32), paint(31), paint(2)];
    if (!values.json) console.log(`\n  Testing ${tests.length} test${tests.length === 1 ? "" : "s"} × ${llms.length} model${llms.length === 1 ? "" : "s"}${runs > 1 ? ` × ${runs} runs` : ""} in ${workspace.name} ${dim(`(tools: ${toolMode})`)}\n`);
    const results = [];
    for await (const r of engine.runTests({ workspaceId: workspace.id, llmIds: llms.map((l) => l!.id), runs, toolMode })) {
      results.push(r);
      if (values.json) continue;
      const head = `  ${r.passed ? green("✓") : red("✗")} ${label.get(r.llmId)}  ${name.get(r.testId)}${runs > 1 ? dim(` #${r.run}`) : ""} ${dim(`${(r.durationMs / 1000).toFixed(1)}s`)}`;
      console.log(head);
      for (const reason of r.reasons) console.log(`      ${red(reason)}`);
    }
    const summary = summarize(results);
    const passRate = results.length ? results.filter((r) => r.passed).length / results.length : 0;
    const ok = minPass >= 1 ? results.every((r) => r.passed) : passRate >= minPass;
    if (values.markdown) {
      const failures = results.filter((r) => !r.passed).map((r) => ({ model: label.get(r.llmId) ?? r.llmId, test: `${name.get(r.testId)}${runs > 1 ? ` #${r.run}` : ""}`, reasons: r.reasons }));
      await writeFile(values.markdown, scorecardMarkdown({ workspace: workspace.name, summary, label, failures, baseline, ok }));
    }
    if (values.json) {
      console.log(JSON.stringify({ workspace: workspace.id, toolMode, runs, passRate, summary, results }, null, 2));
    } else {
      console.log("");
      for (const s of summary) {
        const b = baseline?.summary.find((x) => x.llmId === s.llmId);
        const delta = b ? percent(s.passed, s.total) - percent(b.passed, b.total) : undefined;
        const change = delta === undefined ? "" : `  ${(delta < 0 ? red : delta > 0 ? green : dim)(`${delta > 0 ? "+" : ""}${delta} pts vs baseline`)}`;
        console.log(`  ${(s.passed === s.total ? green : red)(`${s.passed}/${s.total}`.padStart(7))}  ${String(percent(s.passed, s.total)).padStart(3)}%  ${label.get(s.llmId)}  ${dim(`avg ${(s.avgMs / 1000).toFixed(1)}s${s.avgTokens ? ` · ${s.avgTokens} tokens` : ""}`)}${change}`);
      }
      if (minPass < 1) console.log(`\n  ${(ok ? green : red)(`${Math.round(passRate * 100)}% passed`)} ${dim(`(minimum ${Math.round(minPass * 100)}%)`)}`);
      if (values.markdown) console.log(dim(`\n  Scorecard: ${values.markdown}`));
      console.log("");
    }
    return ok ? 0 : 1;
  } finally {
    await sandbox.close();
  }
}

const KIND_LABEL: Record<import("@mokalabs/core").DiagnosisKind, string> = {
  "wrong-tool": "Wrong tool",
  "missed-call": "Missed call",
  "wrong-args": "Wrong argument",
  "forbidden-call": "Called when it shouldn't",
  answer: "Answer",
  error: "Error",
};

/** `moka improve`: propose better tool wording from test failures, verify it, optionally save it. */
async function runImproveCommand(configPath: string | undefined, values: TestFlags): Promise<number> {
  const { startSandbox } = await import("./index.js");
  const { changesAsMarkdown, proposalOverrides } = await import("@mokalabs/core");
  const toolMode = (values.tools ?? "read-only") as "run" | "read-only" | "none";
  if (!["run", "read-only", "none"].includes(toolMode)) {
    console.error(`✗ --tools must be run, read-only or none`);
    return 2;
  }
  const runs = values.runs ? Number(values.runs) : 1;
  const proposals = values.proposals ? Number(values.proposals) : 2;
  if (!Number.isInteger(runs) || runs < 1 || runs > 20 || !Number.isInteger(proposals) || proposals < 1 || proposals > 5) {
    console.error(`✗ --runs must be 1 to 20 and --proposals 1 to 5`);
    return 2;
  }
  const sandbox = await startSandbox({ port: 0, host: "127.0.0.1", configPath, token: false, ui: false });
  try {
    const engine = sandbox.engine;
    const config = engine.getConfig();
    const workspace = engine.workspace(values.workspace);
    if (values.workspace && workspace.id !== values.workspace) {
      console.error(`✗ No workspace "${values.workspace}". Workspaces: ${config.workspaces.map((w) => w.id).join(", ")}`);
      return 2;
    }
    const find = (m: string) => config.llms.find((l) => l.id === m || l.name === m || l.model === m);
    const wanted = values.models ? values.models.split(",").map((m) => m.trim()).filter(Boolean) : [workspace.llmId ?? config.llms[0]?.id].filter((m): m is string => !!m);
    const llms = wanted.map(find);
    const missing = wanted.filter((_, i) => !llms[i]);
    if (missing.length || !llms.length) {
      console.error(`✗ Unknown model${missing.length === 1 ? "" : "s"}: ${missing.join(", ") || "(none configured)"}. Models: ${config.llms.map((l) => l.id).join(", ")}`);
      return 2;
    }
    const improver = values.improver ? find(values.improver) : undefined;
    if (values.improver && !improver) {
      console.error(`✗ Unknown improver model: ${values.improver}. Models: ${config.llms.map((l) => l.id).join(", ")}`);
      return 2;
    }
    const label = new Map(config.llms.map((l) => [l.id, `${l.name} (${l.model})`]));
    const tty = process.stdout.isTTY && !values.json;
    const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
    const [green, red, dim, bold] = [paint(32), paint(31), paint(2), paint(1)];
    const titles = { baseline: "Baseline", diagnosis: "Diagnosis", holdout: "Holdout prompts", proposals: "Proposals", verify: "Verify", verdict: "Review" } as const;
    let expected = 0;
    let done = 0;
    let proposalList: import("@mokalabs/core").Proposal[] = [];
    let verdict: Extract<import("@mokalabs/core").ImproveEvent, { type: "verdict" }> | undefined;
    for await (const event of engine.improve({ workspaceId: workspace.id, llmIds: llms.map((l) => l!.id), runs, toolMode, improverId: improver?.id, proposals })) {
      if (values.json) {
        console.log(JSON.stringify(event));
        if (event.type === "proposals") proposalList = event.proposals;
        if (event.type === "verdict") verdict = event;
        continue;
      }
      switch (event.type) {
        case "start":
          expected = event.estimatedRuns;
          console.log(`\n  ${bold("Improve")} ${workspace.name}: ${event.tests} test${event.tests === 1 ? "" : "s"} × ${event.models.length} model${event.models.length === 1 ? "" : "s"}${runs > 1 ? ` × ${runs} runs` : ""}`);
          console.log(dim(`  Proposals by ${event.improver.name} (${event.improver.model}) · up to ≈${event.estimatedRuns} test runs`));
          break;
        case "phase":
          console.log(`\n  ${bold(titles[event.phase])}`);
          break;
        case "result":
          done++;
          if (tty) process.stdout.write(`\r  ${dim(`${done}/${expected} runs`)}  ${event.result.passed ? green("✓") : red("✗")} ${dim(event.result.variant)}   `);
          break;
        case "diagnosis":
          if (tty) process.stdout.write("\r\x1b[K");
          for (const d of event.diagnosis) {
            const failed = d.models.reduce((n, m) => n + m.failed, 0);
            const of = d.models.reduce((n, m) => n + m.runs, 0);
            console.log(`  ${red("•")} ${KIND_LABEL[d.kind]}: ${d.detail} ${dim(`(${failed} of ${of} runs, ${d.models.map((m) => label.get(m.llmId) ?? m.llmId).join(", ")})`)}`);
          }
          if (!event.diagnosis.length) console.log(dim("  No failures."));
          break;
        case "holdout":
          console.log(dim(`  ${event.tests.length} paraphrased prompts the improver never sees`));
          break;
        case "proposals":
          proposalList = event.proposals;
          for (const p of event.proposals) console.log(`  ${bold(p.id)} ${p.summary} ${dim(`(${p.changes.length} change${p.changes.length === 1 ? "" : "s"})`)}`);
          break;
        case "verdict": {
          if (tty) process.stdout.write("\r\x1b[K");
          verdict = event;
          const row = (name: string, v: import("@mokalabs/core").VariantScore) => `  ${name.padEnd(10)} ${`${v.passed}/${v.total}`.padStart(7)}  ${v.holdoutTotal ? dim(`holdout ${v.holdoutPassed}/${v.holdoutTotal}`) : ""}`;
          console.log(row("before", event.baseline));
          for (const v of event.verdicts) {
            console.log(`${row(v.variant, v)}  ${v.accepted ? green(v.variant === event.winner ? "✓ winner" : "✓ accepted") : red("✗ rejected")}`);
            for (const note of v.notes) console.log(dim(`               ${note}`));
          }
          break;
        }
        case "done":
          if (tty) process.stdout.write("\r\x1b[K");
          if (event.message) console.log(`\n  ${event.message}`);
          break;
      }
    }
    const winner = verdict?.winner ? proposalList.find((p) => p.id === verdict!.winner) : undefined;
    if (!winner) {
      if (!values.json) console.log(verdict ? `\n  ${red("No proposal beat the current wording.")} Nothing changed.\n` : "");
      return verdict ? 1 : 0;
    }
    const ctx = await engine.improveContext(workspace.id);
    const after = verdict!.verdicts.find((v) => v.variant === winner.id);
    if (!values.json) {
      console.log(`\n  ${bold(`Changes in ${winner.id}`)}`);
      for (const c of winner.changes) {
        const old = ctx.tools.find((t) => t.serverId === c.serverId && t.tool.name === c.tool)?.tool;
        console.log(`\n  ${bold(c.tool)} ${dim(c.reason)}`);
        if (c.description) console.log(`  ${red(`- ${old?.description ?? ""}`)}\n  ${green(`+ ${c.description}`)}`);
        for (const [param, p] of Object.entries(c.params ?? {})) console.log(`  ${green("+")} ${param}: ${p.description ?? ""}${p.examples?.length ? dim(` e.g. ${p.examples.map((e) => JSON.stringify(e)).join(", ")}`) : ""}`);
      }
    }
    if (values.markdown) await writeFile(values.markdown, changesAsMarkdown(winner.changes, ctx.tools, verdict!.baseline, after));
    if (values.apply) {
      const next = structuredClone(engine.getConfig());
      const merged = proposalOverrides(winner, ctx.saved);
      for (const server of next.mcpServers) if (merged[server.id]) server.toolOverrides = merged[server.id];
      await engine.setConfig(next);
      if (!values.json) console.log(`\n  ${green("✓")} Saved as toolOverrides in ${sandbox.configPath}. Moka's chats and tests use the new wording; the server is unchanged.`);
    } else if (!values.json) {
      console.log(dim(`\n  Run again with --apply to save this wording in ${sandbox.configPath}.`));
    }
    if (!values.json) console.log("");
    return 0;
  } finally {
    await sandbox.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "demo-agent") {
    const { values } = parseArgs({ args: argv.slice(1), options: { port: { type: "string", short: "p" }, host: { type: "string", short: "H" } } });
    const { startDemoAgent } = await import("./demo-agent.js");
    const agent = await startDemoAgent(Number(values.port ?? 4100), values.host ?? "127.0.0.1");
    console.log(`\n  ☕ Moka demo agent\n\n  A2A card:   ${agent.a2aUrl}\n  AG-UI:      ${agent.aguiUrl}\n\n  Add it in Moka under Settings → Agents.\n`);
    return;
  }

  if (command === "mock") {
    const { values, positionals } = parseArgs({ args: argv.slice(1), allowPositionals: true, options: { fallback: { type: "string" }, help: { type: "boolean", short: "h" } } });
    const file = positionals[0];
    if (!file || values.help || (values.fallback && !["error", "last"].includes(values.fallback))) {
      console.error("Usage: moka mock <recording.jsonl> [--fallback error|last]\n  Serves a recording as an MCP server on stdio. Unrecorded calls fail (default) or get the tool's last recorded result.");
      process.exitCode = values.help ? 0 : 2;
      return;
    }
    const { runMockServer } = await import("./mock.js");
    await runMockServer(file, { fallback: values.fallback as "error" | "last" | undefined });
    return;
  }

  if (command === "demo-server") {
    const { runDemoServer, VERSION } = await import("./index.js");
    await runDemoServer(VERSION);
    return;
  }

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string", short: "H" },
      config: { type: "string", short: "c" },
      token: { type: "string" },
      "no-auth": { type: "boolean", default: false },
      "no-open": { type: "boolean", default: false },
      "no-system-ca": { type: "boolean", default: false },
      proxy: { type: "string" },
      // moka test
      models: { type: "string", short: "m" },
      workspace: { type: "string", short: "w" },
      runs: { type: "string" },
      tools: { type: "string" },
      json: { type: "boolean", default: false },
      "min-pass": { type: "string" },
      markdown: { type: "string" },
      baseline: { type: "string" },
      // moka improve
      improver: { type: "string" },
      proposals: { type: "string" },
      apply: { type: "boolean", default: false },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }
  const { startSandbox, VERSION, seedConfig } = await import("./index.js");
  if (values.version) {
    console.log(VERSION);
    return;
  }

  if (positionals[0] === "init") {
    const target = path.resolve(positionals[1] ?? "moka.json");
    if (existsSync(target)) {
      console.error(`✗ ${path.relative(process.cwd(), target)} already exists`);
      process.exitCode = 1;
      return;
    }
    const { emptyConfig } = await import("@mokalabs/core");
    const config = await seedConfig(emptyConfig(), process.env);
    await writeFile(target, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`✓ Wrote ${path.relative(process.cwd(), target)} — run \`moka\` in this folder to use it.`);
    return;
  }

  const proxy = values.proxy ?? proxyFromEnv(process.env);
  const needsProxy = !!proxy && process.env.NODE_USE_ENV_PROXY !== "1" && nodeSupportsEnvProxy();
  const systemCa = trustSystemCertificates(process.env, !values["no-system-ca"]);
  if (needsProxy || systemCa.mode === "relaunch") {
    relaunch(argv, { proxy: needsProxy ? proxy : undefined, systemCa: systemCa.mode === "relaunch" });
    return;
  }

  if (positionals[0] === "test") {
    process.exitCode = await runTests(positionals[1] ?? values.config, values);
    return;
  }

  if (positionals[0] === "improve") {
    process.exitCode = await runImproveCommand(positionals[1] ?? values.config, values);
    return;
  }

  const port = values.port ? Number(values.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    console.error(`✗ Invalid port: ${values.port}`);
    process.exitCode = 1;
    return;
  }

  const sandbox = await startSandbox({
    port,
    host: values.host,
    configPath: values.config ?? positionals[0],
    token: values["no-auth"] ? false : values.token,
  });

  const c = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = c(1);
  const dim = c(2);
  const accent = c(33);
  const llms = sandbox.engine.getConfig().llms;
  console.log("");
  console.log(`  ${accent("☕ moka")} ${dim(`v${VERSION}`)}`);
  console.log("");
  console.log(`  ${bold("➜  Open:")}    ${accent(sandbox.url)}`);
  console.log(`  ${dim("   Config:")}  ${sandbox.configPath}${sandbox.seeded ? dim("  (created)") : ""}`);
  console.log(
    `  ${dim("   Models:")}  ${llms.length ? llms.map((l) => `${l.name}`).join(", ") : "none yet — add one in Settings"}`,
  );
  if (proxy) {
    console.log(
      process.env.NODE_USE_ENV_PROXY === "1"
        ? `  ${dim("   Proxy:")}   ${redactUrl(proxy)}${dim(" (NO_PROXY honoured)")}`
        : `  ${c(33)("   Proxy is set but Node " + process.versions.node + " can't use it. Upgrade to Node 22.21+ or 24.")}`,
    );
  }
  if (systemCa.mode === "loaded" || systemCa.mode === "flag") {
    console.log(`  ${dim("   Certs:")}   ${dim("Node's + your system's (company CAs included)")}`);
  }
  if (!sandbox.token) console.log(`  ${c(31)("   Auth disabled — anyone who can reach this port can run commands.")}`);
  if (sandbox.host !== "127.0.0.1" && sandbox.host !== "localhost") {
    console.log(`  ${dim(`   Listening on ${sandbox.host}:${sandbox.port}`)}`);
  }
  console.log("");
  const ui = sandbox.engine.getConfig().ui;
  if (ui?.starLink !== false && ui?.branding !== false) {
    console.log(`  ${dim("⭐ Enjoying Moka? Star it: https://github.com/mokahq/mokalabs")}`);
    console.log("");
  }

  if (!values["no-open"] && !process.env.CI && process.env.MOKA_NO_OPEN !== "1") {
    try {
      openBrowser(sandbox.url);
    } catch {
      // headless environment — the URL is printed above
    }
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) process.exit(0);
    closing = true;
    console.log(dim("\n  Shutting down…"));
    await sandbox.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
