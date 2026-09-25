#!/usr/bin/env node
import { spawn } from "node:child_process";
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
    moka demo-agent [--port]  run a demo A2A + AG-UI agent (default port 4100)

  Options
    -p, --port <n>            port to listen on (default 4000, or $PORT)
    -H, --host <host>         interface to bind (default 127.0.0.1; use 0.0.0.0 in Docker)
    -c, --config <file>       config file (default ./moka.json, else ~/.moka/config.json)
        --token <token>       fixed access token (default: random, or $MOKA_TOKEN)
        --no-auth             disable the access token (only on trusted machines!)
        --no-open             don't open the browser
        --proxy <url>         send model/MCP traffic through this HTTP(S) proxy
                              (default: $HTTPS_PROXY / $HTTP_PROXY; $NO_PROXY is honoured)
    -v, --version             print version
    -h, --help                show this help

  Environment
    OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY …
    are detected automatically on first run. Ollama on localhost is detected too.
    HTTPS_PROXY / HTTP_PROXY / NO_PROXY and NODE_EXTRA_CA_CERTS work behind corporate networks.
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
 * Restart this process with NODE_USE_ENV_PROXY=1 so every fetch (LLM
 * providers, HTTP MCP servers, catalogs) goes through the proxy. Local
 * addresses always bypass it so Ollama and the UI keep working.
 */
function relaunchWithProxy(argv: string[], proxy: string): void {
  const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, "localhost", "127.0.0.1", "::1"].filter(Boolean).join(",");
  const env = { ...process.env, NODE_USE_ENV_PROXY: "1", NO_PROXY: noProxy, no_proxy: noProxy };
  if (!proxyFromEnv(process.env)) Object.assign(env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy });
  const child = spawn(process.execPath, ["--disable-warning=UNDICI-EHPA", ...process.execArgv, process.argv[1]!, ...argv], { stdio: "inherit", env });
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
      proxy: { type: "string" },
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
  if (proxy && process.env.NODE_USE_ENV_PROXY !== "1" && nodeSupportsEnvProxy()) {
    relaunchWithProxy(argv, proxy);
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
  if (!sandbox.token) console.log(`  ${c(31)("   Auth disabled — anyone who can reach this port can run commands.")}`);
  if (sandbox.host !== "127.0.0.1" && sandbox.host !== "localhost") {
    console.log(`  ${dim(`   Listening on ${sandbox.host}:${sandbox.port}`)}`);
  }
  console.log("");

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
