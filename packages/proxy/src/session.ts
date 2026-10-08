import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One line of a session log (JSON Lines). `dir` is the message's direction:
 * "out" goes from the client (the editor) to the server, "in" comes back.
 */
export type SessionRecord =
  | {
      type: "start";
      v: 1;
      t: number;
      id: string;
      /** Label given with --client, e.g. "vscode" or "cursor". */
      client?: string;
      /** Server name given with --name (the key in the client's config). */
      name: string;
      command: string;
      args: string[];
      cwd: string;
      pid: number;
      proxy: string;
    }
  | { type: "msg"; t: number; dir: "in" | "out"; msg: unknown }
  | { type: "raw"; t: number; dir: "in" | "out"; text: string }
  | { type: "stderr"; t: number; text: string }
  | { type: "error"; t: number; message: string }
  | { type: "exit"; t: number; code: number | null; signal: string | null };

/** Where Moka keeps its files: $MOKA_HOME, else ~/.moka. */
export function mokaHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MOKA_HOME ? path.resolve(env.MOKA_HOME) : path.join(os.homedir(), ".moka");
}

/** Folder of session logs that the Moka inspector reads. */
export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(mokaHome(env), "proxy", "sessions");
}

/**
 * Appends records to a session log. Never throws: if the log can't be written,
 * the proxy keeps passing messages through and just stops recording.
 */
export class SessionLog {
  readonly file: string | undefined;
  private stream: WriteStream | undefined;

  constructor(dir: string, id: string) {
    try {
      mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, `${id}.jsonl`);
      this.stream = createWriteStream(this.file, { flags: "a" });
      this.stream.on("error", () => (this.stream = undefined));
    } catch {
      this.stream = undefined;
    }
  }

  write(record: SessionRecord): void {
    if (!this.stream) return;
    try {
      this.stream.write(`${JSON.stringify(record)}\n`);
    } catch {
      this.stream = undefined;
    }
  }

  close(): Promise<void> {
    const stream = this.stream;
    this.stream = undefined;
    return new Promise((resolve) => (stream ? stream.end(resolve) : resolve()));
  }
}
