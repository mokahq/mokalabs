#!/usr/bin/env node
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const HELP = `
  ☕ moka — any LLM, any MCP server, any skill. One command.

  Usage
    npx @mokalabs/sandbox [config.json] [options]
    moka [config.json] [options]
    moka init                 write a starter moka.json in this folder
    moka demo-server          run the bundled demo MCP server on stdio

  Options
    -p, --port <n>            port to listen on (default 4000, or $PORT)
    -H, --host <host>         interface to bind (default 127.0.0.1; use 0.0.0.0 in Docker)
    -c, --config <file>       config file (default ./moka.json, else ~/.moka/config.json)
        --token <token>       fixed access token (default: random, or $MOKA_TOKEN)
        --no-auth             disable the access token (only on trusted machines!)
        --no-open             don't open the browser
    -v, --version             print version
    -h, --help                show this help

  Environment
    OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY …
    are detected automatically on first run. Ollama on localhost is detected too.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

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
  if (!sandbox.token) console.log(`  ${c(31)("   Auth disabled — anyone who can reach this port can run commands.")}`);
  if (sandbox.host !== "127.0.0.1" && sandbox.host !== "localhost") {
    console.log(`  ${dim(`   Listening on ${sandbox.host}:${sandbox.port}`)}`);
  }
  console.log("");

  if (!values["no-open"] && !process.env.CI && process.env.MOKA_NO_OPEN !== "1") {
    try {
      const { default: open } = await import("open");
      await open(sandbox.url);
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
