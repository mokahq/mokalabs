import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { RpcTracker, stableJson, type EventBus } from "@mokalabs/core";
import type { SessionRecord } from "@mokalabs/proxy";

/** A server session recorded by `@mokalabs/proxy` (one editor ↔ one server). */
export interface ProxySession {
  id: string;
  /** `serverId` of this session's events. */
  serverId: string;
  /** What the client is: the --client label, else its name from `initialize`. */
  client: string;
  clientInfo?: { name?: string; version?: string };
  name: string;
  command: string;
  args: string[];
  cwd: string;
  pid: number;
  startedAt: number;
  lastAt: number;
  endedAt?: number;
  exitCode?: number | null;
  live: boolean;
  requests: number;
  errors: number;
  timeouts: number;
}

interface Tail {
  file: string;
  offset: number;
  pending: string;
  session?: ProxySession;
  tracker?: RpcTracker;
  /** How the last tools/call with the same tool and arguments ended, to spot retries. */
  calls: Map<string, string>;
}

const CLIENT_LABELS: Record<string, string> = {
  vscode: "VS Code",
  cursor: "Cursor",
  "claude-desktop": "Claude Desktop",
  "claude-code": "Claude Code",
  windsurf: "Windsurf",
  gemini: "Gemini",
};

/**
 * Follows the session logs that `@mokalabs/proxy` writes and replays them onto
 * the event bus as `mcp.rpc` events (paired, with timeouts and late replies),
 * so traffic between another client and its servers shows up in the inspector.
 */
export class ProxySessions {
  private readonly tails = new Map<string, Tail>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly bus: EventBus,
    readonly dir: string,
    private readonly options: { maxAgeMs?: number; intervalMs?: number } = {},
  ) {}

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.options.intervalMs ?? 300);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  list(): ProxySession[] {
    for (const tail of this.tails.values()) this.checkAlive(tail);
    return [...this.tails.values()]
      .flatMap((t) => (t.session ? [t.session] : []))
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  /** Read whatever was appended to the logs since the last poll. */
  poll(): void {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return; // no proxy has run yet
    }
    const oldest = Date.now() - (this.options.maxAgeMs ?? 24 * 3600_000);
    for (const name of files) {
      const file = path.join(this.dir, name);
      let size: number;
      let mtime: number;
      try {
        ({ size, mtimeMs: mtime } = statSync(file));
      } catch {
        continue;
      }
      let tail = this.tails.get(file);
      if (!tail) {
        if (mtime < oldest) continue;
        tail = { file, offset: 0, pending: "", calls: new Map() };
        this.tails.set(file, tail);
      }
      if (size > tail.offset) this.read(tail, size);
    }
  }

  private read(tail: Tail, size: number): void {
    const fd = openSync(tail.file, "r");
    try {
      const buffer = Buffer.alloc(size - tail.offset);
      readSync(fd, buffer, 0, buffer.length, tail.offset);
      tail.offset = size;
      tail.pending += buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
    let index: number;
    while ((index = tail.pending.indexOf("\n")) >= 0) {
      const line = tail.pending.slice(0, index);
      tail.pending = tail.pending.slice(index + 1);
      if (!line.trim()) continue;
      try {
        this.apply(tail, JSON.parse(line) as SessionRecord);
      } catch {
        // a torn or foreign line: skip it
      }
    }
  }

  private apply(tail: Tail, record: SessionRecord): void {
    if (record.type === "start") {
      const session: ProxySession = {
        id: record.id,
        serverId: `proxy:${record.id}`,
        client: CLIENT_LABELS[record.client ?? ""] ?? record.client ?? "Unknown client",
        name: record.name,
        command: record.command,
        args: record.args,
        cwd: record.cwd,
        pid: record.pid,
        startedAt: record.t,
        lastAt: record.t,
        live: true,
        requests: 0,
        errors: 0,
        timeouts: 0,
      };
      tail.session = session;
      tail.tracker = new RpcTracker(this.bus, {
        serverId: session.serverId,
        clientLabel: () => session.client,
        onSettled: (settled) => {
          if (settled.outcome === "error") session.errors++;
          if (settled.reason === "timeout") session.timeouts++;
          if (settled.method === "tools/call") tail.calls.set(callKey(settled.request), settled.reason === "timeout" ? "timeout" : settled.outcome);
        },
      });
      this.bus.emit({ kind: "mcp.status", serverId: session.serverId, ts: record.t, title: `${session.client} → ${session.name}: started through the proxy`, data: { status: "connected", command: record.command, args: record.args, via: "proxy" } });
      return;
    }
    const session = tail.session;
    const tracker = tail.tracker;
    if (!session || !tracker) return;
    session.lastAt = record.t;
    if (record.type === "msg") {
      const msg = record.msg as any;
      const extra: { title?: string; level?: "warn" } = {};
      if (record.dir === "out" && msg?.method === "initialize" && msg.params?.clientInfo) {
        session.clientInfo = msg.params.clientInfo;
        if (session.client === "Unknown client" && msg.params.clientInfo.name) session.client = msg.params.clientInfo.name;
      }
      if (record.dir === "out" && msg?.method && msg.id != null) session.requests++;
      if (record.dir === "out" && msg?.method === "tools/call" && msg.id != null) {
        const tool = msg.params?.name ?? "?";
        extra.title = `tools/call #${msg.id} · ${tool}`;
        // The same call again after one that may have run: the client is retrying a call with an unknown outcome.
        const before = tail.calls.get(callKey(msg));
        if (before === "timeout" || before === "cancelled" || before === "unanswered" || before === "late") {
          extra.title += ` · retry after ${before === "timeout" ? "a timeout" : before === "late" ? "a late reply" : before === "unanswered" ? "no response" : "a cancellation"}: the first call may have run`;
          extra.level = "warn";
        }
        tail.calls.set(callKey(msg), "pending");
      }
      tracker.record(record.dir, msg, record.t, extra);
    } else if (record.type === "raw") {
      this.bus.emit({ kind: "mcp.log", level: "warn", serverId: session.serverId, ts: record.t, title: `${session.name}: not JSON (${record.dir === "out" ? "from the client" : "from the server"}): ${record.text.slice(0, 120)}`, data: record });
    } else if (record.type === "stderr") {
      this.bus.emit({ kind: "mcp.log", serverId: session.serverId, ts: record.t, title: `${session.name}: ${record.text}`, data: record });
    } else if (record.type === "error") {
      this.bus.emit({ kind: "mcp.log", level: "error", serverId: session.serverId, ts: record.t, title: `${session.name}: ${record.message}`, data: record });
    } else if (record.type === "exit") {
      this.end(tail, record.t, record.code, "server exited");
    }
  }

  private end(tail: Tail, at: number, code: number | null | undefined, reason: string): void {
    const session = tail.session;
    if (!session || session.endedAt) return;
    session.endedAt = at;
    session.exitCode = code;
    session.live = false;
    tail.tracker?.close(at, reason);
    this.bus.emit({ kind: "mcp.status", serverId: session.serverId, ts: at, title: `${session.client} → ${session.name}: ${reason}${code ? ` (code ${code})` : ""}`, data: { status: "disconnected", code } });
  }

  /** A proxy that died without writing an exit record (killed with the editor). */
  private checkAlive(tail: Tail): void {
    const session = tail.session;
    if (!session?.live) return;
    try {
      process.kill(session.pid, 0);
    } catch (error: any) {
      if (error?.code === "ESRCH") this.end(tail, session.lastAt, undefined, "proxy stopped");
    }
  }
}

function callKey(message: any): string {
  return `${message?.params?.name}\u0000${stableJson(message?.params?.arguments ?? {})}`;
}
