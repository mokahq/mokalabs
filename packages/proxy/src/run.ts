import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { SessionLog, sessionsDir } from "./session.js";
import { VERSION } from "./version.js";

export interface RunProxyOptions {
  /** The real server: command and arguments, exactly as the client would start it. */
  command: string;
  args: string[];
  /** Label for the client, e.g. "vscode" (wrap sets it). */
  client?: string;
  /** Server name (wrap sets it to the key in the client's config). */
  name?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Streams to the client; default this process's stdio. */
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
}

/**
 * Start the real server and pass every byte through untouched in both
 * directions, recording each JSON-RPC message to a session log for the Moka
 * inspector. Resolves with the server's exit code.
 */
export function runProxy(options: RunProxyOptions): Promise<number> {
  const env = options.env ?? process.env;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const id = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const log = new SessionLog(sessionsDir(env), id);
  const name = options.name ?? guessName(options.command, options.args);
  log.write({
    type: "start",
    v: 1,
    t: Date.now(),
    id,
    ...(options.client ? { client: options.client } : {}),
    name,
    command: options.command,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    pid: process.pid,
    proxy: VERSION,
  });

  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: options.cwd,
      // On Windows, commands like `npx` are .cmd scripts that need a shell.
      shell: process.platform === "win32",
    });

    const recordLines = lineSplitter((line, dir) => {
      try {
        log.write({ type: "msg", t: Date.now(), dir, msg: JSON.parse(line) });
      } catch {
        log.write({ type: "raw", t: Date.now(), dir, text: line });
      }
    });

    // Client → server.
    const fromClient = (chunk: Buffer) => {
      child.stdin.write(chunk);
      recordLines(chunk, "out");
    };
    stdin.on("data", fromClient);
    stdin.on("end", () => child.stdin.end());
    child.stdin.on("error", () => undefined); // the server exited; its exit is reported below

    // Server → client.
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.write(chunk);
      recordLines(chunk, "in");
    });
    stdout.on("error", () => undefined); // the client went away

    // The server's own logging goes to stderr: pass it on, and keep it for the inspector.
    const stderrText = new StringDecoder("utf8");
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.write(chunk);
      for (const text of stderrText.write(chunk).split(/\r?\n/)) if (text.trim()) log.write({ type: "stderr", t: Date.now(), text });
    });

    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = signals.map((signal) => [signal, forward(signal)] as const);
    if (!options.stdin) for (const [signal, handler] of handlers) process.on(signal, handler);

    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      stdin.off("data", fromClient);
      if (!options.stdin) for (const [signal, handler] of handlers) process.off(signal, handler);
      void log.close().then(() => resolve(code));
    };
    child.on("error", (error) => {
      const message = `could not start ${options.command}: ${error.message}`;
      stderr.write(`[moka proxy] ${message}\n`);
      log.write({ type: "error", t: Date.now(), message });
      finish(1);
    });
    child.on("close", (code, signal) => {
      log.write({ type: "exit", t: Date.now(), code, signal });
      finish(code ?? 1);
    });
  });
}

/** Splits each direction's byte stream into lines (MCP over stdio is one JSON message per line). */
function lineSplitter(onLine: (line: string, dir: "in" | "out") => void) {
  const state = { in: { decoder: new StringDecoder("utf8"), pending: "" }, out: { decoder: new StringDecoder("utf8"), pending: "" } };
  return (chunk: Buffer, dir: "in" | "out") => {
    const s = state[dir];
    s.pending += s.decoder.write(chunk);
    let index: number;
    while ((index = s.pending.indexOf("\n")) >= 0) {
      const line = s.pending.slice(0, index).replace(/\r$/, "");
      s.pending = s.pending.slice(index + 1);
      if (line.trim()) onLine(line, dir);
    }
  };
}

/** A readable server name from its command, e.g. `npx -y @modelcontextprotocol/server-github` → server-github. */
export function guessName(command: string, args: string[]): string {
  const words = [command, ...args].filter((a) => !a.startsWith("-"));
  const word = (words.find((w) => /server|mcp/i.test(w)) ?? words.at(-1) ?? command).replace(/(.)@[^/@]+$/, "$1"); // drop @version
  const scoped = /^@([^/]+)\/(.+)$/.exec(word);
  // A generic package name (@playwright/mcp) says less than its scope.
  if (scoped && /^(mcp|server|mcp-server)$/i.test(scoped[2]!)) return scoped[1]!;
  return (word.split(/[\\/]/).pop() ?? word).replace(/\.(m?js|ts|py)$/, "") || command;
}
