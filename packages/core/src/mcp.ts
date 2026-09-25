import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolveRecord, resolveSecret, type McpServerConfig } from "./config.js";
import type { EventBus } from "./events.js";

export type McpStatus = "idle" | "connecting" | "connected" | "error";

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** MCP Apps: `_meta.ui.resourceUri`, `_meta.ui.visibility`. */
  _meta?: Record<string, any>;
}

export interface McpServerState {
  id: string;
  name: string;
  status: McpStatus;
  error?: string;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  tools: McpTool[];
  prompts: Array<{ name: string; description?: string; arguments?: unknown[] }>;
  resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>;
  stderr: string[];
  connectedAt?: number;
}

interface Connection {
  config: McpServerConfig;
  fingerprint: string;
  client?: Client;
  transport?: Transport;
  state: McpServerState;
  pending?: Promise<McpServerState>;
}

/** Lets hosts map virtual commands (e.g. `moka:demo`) to real executables. */
export type CommandResolver = (command: string, args: string[]) => { command: string; args: string[] } | undefined;

const CLIENT_INFO = { name: "moka", version: "0.1.0" };
const STDERR_LINES = 200;

function fingerprint(config: McpServerConfig): string {
  const { disabledTools: _ignored, name: _name, ...rest } = config;
  return JSON.stringify(rest);
}

/**
 * Owns live connections to MCP servers. Connections are lazy, keyed by server
 * id, and re-created automatically when the server config changes.
 */
export class McpManager {
  private connections = new Map<string, Connection>();

  constructor(
    private readonly bus: EventBus,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly resolveCommand?: CommandResolver,
  ) {}

  states(): McpServerState[] {
    return [...this.connections.values()].map((c) => c.state);
  }

  state(id: string): McpServerState | undefined {
    return this.connections.get(id)?.state;
  }

  /** Drop connections for servers that no longer exist in config. */
  async prune(keepIds: Iterable<string>): Promise<void> {
    const keep = new Set(keepIds);
    await Promise.all(
      [...this.connections.keys()].filter((id) => !keep.has(id)).map((id) => this.disconnect(id)),
    );
  }

  /** Connect (or reuse an existing connection) and return the server state. */
  async ensure(config: McpServerConfig): Promise<McpServerState> {
    const existing = this.connections.get(config.id);
    const fp = fingerprint(config);
    if (existing && existing.fingerprint === fp) {
      existing.config = config;
      existing.state.name = config.name;
      if (existing.pending) return existing.pending;
      if (existing.state.status === "connected") return existing.state;
    }
    if (existing) await this.disconnect(config.id);
    return this.connect(config);
  }

  async reconnect(config: McpServerConfig): Promise<McpServerState> {
    await this.disconnect(config.id);
    return this.connect(config);
  }

  private connect(config: McpServerConfig): Promise<McpServerState> {
    const state: McpServerState = {
      id: config.id,
      name: config.name,
      status: "connecting",
      tools: [],
      prompts: [],
      resources: [],
      stderr: [],
    };
    const conn: Connection = { config, fingerprint: fingerprint(config), state };
    this.connections.set(config.id, conn);
    this.emitStatus(conn);

    conn.pending = (async () => {
      const started = Date.now();
      try {
        const transport = this.createTransport(conn);
        const client = new Client(CLIENT_INFO, { capabilities: {} });
        client.onerror = (error) => {
          this.bus.emit({ kind: "mcp.log", level: "error", title: `${config.name}: ${error.message}`, serverId: config.id });
        };
        client.onclose = () => {
          if (this.connections.get(config.id) !== conn || state.status !== "connected") return;
          state.status = "error";
          state.error = "Connection closed";
          this.emitStatus(conn);
        };
        const timeout = config.timeoutMs ?? 30_000;
        this.tap(conn, transport);
        conn.client = client;
        conn.transport = transport;
        await withTimeout(client.connect(transport, { timeout }), timeout, `Timed out connecting to ${config.name}`);

        const caps = client.getServerCapabilities() ?? {};
        const info = client.getServerVersion();
        state.serverInfo = info ? { name: info.name, version: info.version } : undefined;
        state.instructions = client.getInstructions();
        state.tools = caps.tools ? await this.listAllTools(client) : [];
        state.prompts = caps.prompts ? ((await client.listPrompts().catch(() => ({ prompts: [] }))).prompts as any) : [];
        state.resources = caps.resources
          ? ((await client.listResources().catch(() => ({ resources: [] }))).resources as any)
          : [];
        state.status = "connected";
        state.error = undefined;
        state.connectedAt = Date.now();
        this.emitStatus(conn, Date.now() - started);
      } catch (error) {
        state.status = "error";
        state.error = errorMessage(error);
        this.emitStatus(conn, Date.now() - started);
        await conn.client?.close().catch(() => {});
        await conn.transport?.close().catch(() => {});
      } finally {
        conn.pending = undefined;
      }
      return state;
    })();
    return conn.pending;
  }

  private async listAllTools(client: Client): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...(page.tools as McpTool[]));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  private createTransport(conn: Connection): Transport {
    const { config } = conn;
    const headers = resolveRecord(config.headers, this.env);
    switch (config.transport) {
      case "stdio": {
        if (!config.command) throw new Error("A command is required for stdio servers.");
        let command = resolveSecret(config.command, this.env)!;
        let args = (config.args ?? []).map((a) => resolveSecret(a, this.env) ?? a);
        const override = this.resolveCommand?.(command, args);
        if (override) ({ command, args } = override);
        const transport = new StdioClientTransport({
          command,
          args,
          env: { ...getDefaultEnvironment(), ...resolveRecord(config.env, this.env) },
          cwd: config.cwd || undefined,
          stderr: "pipe",
        });
        transport.stderr?.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString().split(/\r?\n/)) {
            if (!line.trim()) continue;
            conn.state.stderr.push(line);
            if (conn.state.stderr.length > STDERR_LINES) conn.state.stderr.shift();
            this.bus.emit({ kind: "mcp.log", level: "info", title: `${config.name} stderr`, serverId: config.id, data: line });
          }
        });
        return transport;
      }
      case "http": {
        if (!config.url) throw new Error("A URL is required for HTTP servers.");
        return new StreamableHTTPClientTransport(new URL(resolveSecret(config.url, this.env)!), {
          requestInit: { headers },
        });
      }
      case "sse": {
        if (!config.url) throw new Error("A URL is required for SSE servers.");
        return new SSEClientTransport(new URL(resolveSecret(config.url, this.env)!), {
          requestInit: { headers },
          eventSourceInit: headers
            ? { fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as any), ...headers } }) }
            : undefined,
        });
      }
    }
  }

  /**
   * Mirror raw JSON-RPC traffic onto the event bus for the inspector. Installed
   * before `connect()` so the initialize handshake is captured too; the SDK
   * assigns `onmessage` during connect, so we intercept the assignment.
   */
  private tap(conn: Connection, transport: Transport): void {
    const { id } = conn.config;
    const bus = this.bus;
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      bus.emit({ kind: "mcp.rpc", direction: "out", title: rpcTitle(message), serverId: id, data: message });
      return send(message, options);
    };
    let handler: Transport["onmessage"];
    Object.defineProperty(transport, "onmessage", {
      configurable: true,
      get: () => handler,
      set: (fn: Transport["onmessage"]) => {
        handler = fn
          ? (message, extra) => {
              bus.emit({ kind: "mcp.rpc", direction: "in", title: rpcTitle(message), serverId: id, data: message });
              fn(message, extra);
            }
          : fn;
      },
    });
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ content: unknown[]; isError?: boolean; structuredContent?: unknown }> {
    const conn = this.connections.get(serverId);
    if (!conn?.client || conn.state.status !== "connected") {
      throw new Error(`MCP server "${conn?.config.name ?? serverId}" is not connected.`);
    }
    const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, {
      signal: options.signal,
      timeout: conn.config.timeoutMs ?? 120_000,
    });
    return result as any;
  }

  async readResource(serverId: string, uri: string): Promise<unknown> {
    const conn = this.connections.get(serverId);
    if (!conn?.client) throw new Error("Server not connected");
    return conn.client.readResource({ uri });
  }

  async getPrompt(serverId: string, name: string, args: Record<string, string> = {}): Promise<unknown> {
    const conn = this.connections.get(serverId);
    if (!conn?.client) throw new Error("Server not connected");
    return conn.client.getPrompt({ name, arguments: args });
  }

  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;
    this.connections.delete(id);
    await conn.pending?.catch(() => {});
    await conn.client?.close().catch(() => {});
    await conn.transport?.close().catch(() => {});
    conn.state.status = "idle";
    this.emitStatus(conn);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }

  private emitStatus(conn: Connection, durationMs?: number): void {
    const { state } = conn;
    const suffix =
      state.status === "connected" ? ` · ${state.tools.length} tools` : state.error ? ` · ${state.error}` : "";
    this.bus.emit({
      kind: "mcp.status",
      title: `${state.name}: ${state.status}${suffix}`,
      serverId: state.id,
      level: state.status === "error" ? "error" : "info",
      durationMs,
      data: { status: state.status, error: state.error, serverInfo: state.serverInfo, tools: state.tools.length },
    });
  }
}

function rpcTitle(message: any): string {
  if (message?.method) return message.id != null ? `${message.method} #${message.id}` : message.method;
  if (message?.error) return `error #${message.id}`;
  return `result #${message?.id}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
