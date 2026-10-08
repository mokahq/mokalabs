#!/usr/bin/env node
import { readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { applyPlan, knownLocations, locationForFile, planConfig, type ConfigPlan } from "./configs.js";
import { exportFileName, exportSessions } from "./export.js";
import { runProxy } from "./run.js";
import { sessionsDir } from "./session.js";
import { VERSION } from "./version.js";

const HELP = `moka proxy ${VERSION}: see what your AI editor sends to your MCP server

Wrap your servers (VS Code / GitHub Copilot, Cursor, Claude Desktop, Claude Code, Windsurf, Gemini):
  npx @mokalabs/proxy wrap [config files…] [--only a,b] [--yes] [--dry-run] [--local]
  npx @mokalabs/proxy unwrap [config files…] [--only a,b] [--yes]
  npx @mokalabs/proxy status
  npx @mokalabs/proxy export [--client vscode] [--name github] [--since 24h] [--raw] [-o file.json|-]

  --local  use this copy of the proxy (node …/cli.js) instead of npx, e.g. a build from source
  export   everything recorded, as one JSON file (secrets redacted; --raw keeps them)

Then open the inspector:
  npx @mokalabs/sandbox            → Proxy tab

Run one server through the proxy (what wrap puts in your config):
  npx @mokalabs/proxy [--client <label>] [--name <server>] -- <command> [args…]

Messages pass through untouched. Each session is recorded to
${sessionsDir()}
`;

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (first === "wrap" || first === "unwrap") return wrapCommand(first, rest);
  if (first === "status") return statusCommand();
  if (first === "export") return exportCommand(rest);
  if (!first || first === "help" || first === "--help" || first === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  return proxyCommand(argv);
}

/** `-- command args…`, with --client / --name before it. Nothing may go to stdout: it belongs to the protocol. */
async function proxyCommand(argv: string[]): Promise<number> {
  let client: string | undefined;
  let name: string | undefined;
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "--client") client = argv[++i];
    else if (arg === "--name") name = argv[++i];
    else break; // the server command itself, without a "--"
  }
  const [command, ...args] = argv.slice(i);
  if (!command) {
    process.stderr.write(`[moka proxy] no server command given.\n\n${HELP}`);
    return 2;
  }
  return runProxy({ command, args, client, name });
}

async function wrapCommand(mode: "wrap" | "unwrap", argv: string[]): Promise<number> {
  const files: string[] = [];
  let only: string[] | undefined;
  let yes = false;
  let dryRun = false;
  // --local: run this copy of the proxy (`node …/cli.js`) instead of `npx @mokalabs/proxy`.
  let local: { node: string; script: string } | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--only") only = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--local") local = { node: process.execPath, script: fileURLToPath(new URL("./cli.js", import.meta.url)) };
    else files.push(arg);
  }
  const locations = files.length ? files.map((f) => locationForFile(f)) : knownLocations();
  const plans = locations.map((l) => planConfig(l, only));
  // Without named files, only report the configs that exist.
  const shown = files.length ? plans : plans.filter((p) => p.error !== "not found");
  const out = process.stdout;
  if (!shown.length) {
    out.write(`No MCP client configs found here or in your global settings.\nName one: npx @mokalabs/proxy ${mode} path/to/mcp.json\n`);
    return 1;
  }
  const wanted = mode === "wrap" ? "wrap" : "wrapped";
  out.write(`\n${mode === "wrap" ? "Found" : "Wrapped servers in"}:\n`);
  for (const plan of shown) out.write(describe(plan, mode));
  const todo = shown.filter((p) => p.servers.some((s) => s.state === wanted));
  const count = todo.reduce((n, p) => n + p.servers.filter((s) => s.state === wanted).length, 0);
  if (!count) {
    out.write(`\nNothing to ${mode}.\n`);
    return 0;
  }
  const question = `\n${mode === "wrap" ? "Wrap" : "Unwrap"} ${count} server${count === 1 ? "" : "s"} in ${todo.length} file${todo.length === 1 ? "" : "s"}?${mode === "wrap" ? " (a backup of each file is kept)" : ""}`;
  if (dryRun) {
    out.write(`${question} Dry run: nothing changed.\n`);
    return 0;
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      out.write(`${question} Run again with --yes to confirm.\n`);
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: out });
    const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
    rl.close();
    if (answer && answer !== "y" && answer !== "yes") return 1;
  }
  for (const plan of todo) {
    const changed = applyPlan(plan, mode, local);
    out.write(`  ${mode === "wrap" ? "wrapped" : "unwrapped"} ${changed.join(", ")} in ${plan.path}\n`);
  }
  out.write(
    mode === "wrap"
      ? "\nDone. Restart the MCP servers in your editor (or reload its window), then open the inspector:\n  npx @mokalabs/sandbox   → Proxy tab\nUndo any time: npx @mokalabs/proxy unwrap\n"
      : "\nDone. Restart the MCP servers in your editor to use them directly again.\n",
  );
  return 0;
}

function describe(plan: ConfigPlan, mode: "wrap" | "unwrap"): string {
  const head = `  ${plan.label.padEnd(28)} ${plan.path}\n`;
  if (plan.error) return `${head}      (${plan.error})\n`;
  if (!plan.servers.length) return `${head}      (no servers)\n`;
  return (
    head +
    plan.servers
      .map((s) => {
        const note =
          s.state === "skip" ? `skipped: ${s.reason}` : s.state === "wrapped" ? (mode === "wrap" ? "already wrapped" : "will be unwrapped") : mode === "wrap" ? "will be wrapped" : "not wrapped";
        return `      ${s.name.padEnd(24)} ${note}\n`;
      })
      .join("")
  );
}

/** Write recorded sessions to one JSON file (or stdout with `-o -`). */
function exportCommand(argv: string[]): number {
  let client: string | undefined;
  let name: string | undefined;
  let since: number | undefined;
  let raw = false;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--client") client = argv[++i];
    else if (arg === "--name") name = argv[++i];
    else if (arg === "--raw") raw = true;
    else if (arg === "-o" || arg === "--out") out = argv[++i];
    else if (arg === "--since") {
      const m = /^(\d+)(m|h|d)$/.exec(argv[++i] ?? "");
      if (!m) {
        process.stderr.write("--since takes a duration like 30m, 24h or 7d\n");
        return 2;
      }
      since = Date.now() - Number(m[1]) * { m: 60_000, h: 3600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
    } else {
      process.stderr.write(`Unknown option ${arg}. Options: --client <label>  --name <server>  --since 24h  --raw  -o <file|->\n`);
      return 2;
    }
  }
  const data = exportSessions(sessionsDir(), { client, name, since, redact: !raw });
  const json = `${JSON.stringify(data, null, 2)}\n`;
  if (out === "-") {
    process.stdout.write(json);
    return 0;
  }
  if (!data.sessions.length) {
    process.stderr.write(`No recorded sessions${client || name || since ? " match" : " yet"} (${sessionsDir()}).\n`);
    return 1;
  }
  const file = out ?? exportFileName([client, name]);
  writeFileSync(file, json);
  const records = data.sessions.reduce((n, s) => n + s.records.length, 0);
  process.stdout.write(`Exported ${data.sessions.length} session${data.sessions.length === 1 ? "" : "s"} (${records} records) to ${file}${raw ? "" : " (secrets redacted; --raw keeps them)"}\n`);
  return 0;
}

function statusCommand(): number {
  const out = process.stdout;
  const plans = knownLocations().map((l) => planConfig(l)).filter((p) => p.error !== "not found");
  out.write("\nMCP client configs:\n");
  if (!plans.length) out.write("  none found here or in your global settings\n");
  for (const plan of plans) {
    const wrapped = plan.servers.filter((s) => s.state === "wrapped").map((s) => s.name);
    const direct = plan.servers.filter((s) => s.state !== "wrapped").map((s) => s.name);
    out.write(`  ${plan.label.padEnd(28)} ${plan.error ? `(${plan.error})` : `wrapped: ${wrapped.join(", ") || "none"}${direct.length ? `; direct: ${direct.join(", ")}` : ""}`}\n`);
  }
  const dir = sessionsDir();
  let recent = 0;
  try {
    const dayAgo = Date.now() - 24 * 3600_000;
    recent = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && statSync(path.join(dir, f)).mtimeMs > dayAgo).length;
  } catch {
    // no sessions yet
  }
  out.write(`\nSessions recorded in the last 24 h: ${recent}  (${dir})\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    // Let pending output flush instead of process.exit(); stdin would keep the process alive.
    process.exitCode = code;
    process.stdin.destroy();
  },
  (error) => {
    process.stderr.write(`[moka proxy] ${error?.stack ?? error}\n`);
    process.exit(1);
  },
);
