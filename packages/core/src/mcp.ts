import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ErrorCode,
  McpError,
  type CreateMessageRequest,
  type CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { InteractionBroker } from "./interactions.js";
import { MokaOAuthProvider, oauthSettings, type OAuthStore } from "./oauth.js";
import { resolveRecord, resolveSecret, type McpServerConfig } from "./config.js";
import type { EventBus } from "./events.js";

/** "auth" = the server needs the user to sign in (OAuth); see `authUrl`. */
export type McpStatus = "idle" | "connecting" | "connected" | "error" | "auth";

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
  resources: Array<{ uri: string; name?: string; title?: string; description?: string; mimeType?: string }>;
  stderr: string[];
  connectedAt?: number;
  /** OAuth sign-in URL when status is "auth". */
  authUrl?: string;
  /** Present for OAuth-capable servers. */
  oauth?: { signedIn: boolean };
}

interface Connection {
  config: McpServerConfig;
  fingerprint: string;
  client?: Client;
  transport?: Transport;
  provider?: MokaOAuthProvider;
  state: McpServerState;
  pending?: Promise<McpServerState>;
}

/** Host hooks for server-initiated requests (elicitation, sampling). */
export interface McpClientHooks {
  interactions?: InteractionBroker;
  /** Run an approved `sampling/createMessage` request against a model. */
  sample?: (params: CreateMessageRequest["params"], server: McpServerConfig, signal?: AbortSignal) => Promise<CreateMessageResult>;
  /** OAuth for remote servers: where tokens live and the loopback redirect URL. */
  oauth?: { store: OAuthStore; redirectUrl: () => string | undefined };
}

/** Lets hosts map virtual commands (e.g. `moka:demo`) to real executables. */
export type CommandResolver = (command: string, args: string[]) => { command: string; args: string[] } | undefined;

const CLIENT_INFO = { name: "moka", version: "0.1.0" };

/**
 * Network settings stdio servers should inherit (the MCP SDK only passes a
 * minimal environment by default). Keeps `npx`/`uvx` servers working behind
 * corporate proxies, custom CAs and private registries.
 */
const PASSTHROUGH_ENV = [
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "npm_config_registry", "NPM_CONFIG_REGISTRY", "PIP_INDEX_URL", "UV_INDEX_URL", "UV_DEFAULT_INDEX",
];

export function networkEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(PASSTHROUGH_ENV.filter((k) => env[k]).map((k) => [k, env[k]!]));
}
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
    private readonly hooks: McpClientHooks = {},
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
        const client = this.createClient(config);
        client.onerror = (error) => {
          if (error instanceof UnauthorizedError) return; // surfaced as the "auth" status instead
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
        state.authUrl = undefined;
        if (conn.provider) state.oauth = { signedIn: Boolean(await conn.provider.tokens()) };
        state.connectedAt = Date.now();
        this.emitStatus(conn, Date.now() - started);
      } catch (error) {
        const authUrl = conn.provider?.authorizationUrl;
        if (authUrl && (error instanceof UnauthorizedError || /unauthori[sz]ed|401/i.test(errorMessage(error)))) {
          state.status = "auth";
          state.error = "Sign-in required";
          state.authUrl = authUrl.toString();
          state.oauth = { signedIn: false };
        } else {
          state.status = "error";
          state.error = errorMessage(error);
        }
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

  /** A client that can answer elicitation and sampling requests when the host supports them. */
  private createClient(config: McpServerConfig): Client {
    const { interactions, sample } = this.hooks;
    const capabilities: Record<string, object> = {};
    if (interactions) capabilities.elicitation = { form: {}, url: {} };
    if (interactions && sample && config.sampling !== "deny") capabilities.sampling = {};
    const client = new Client(CLIENT_INFO, { capabilities });
    if (capabilities.elicitation) {
      client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
        const params = request.params as any;
        const url = params.mode === "url";
        const answer = await interactions!.request(
          {
            kind: "elicitation",
            serverId: config.id,
            serverName: config.name,
            message: params.message,
            mode: url ? "url" : "form",
            requestedSchema: url ? undefined : params.requestedSchema,
            url: url ? params.url : undefined,
          },
          extra.signal,
        );
        if (answer.action !== "accept") return { action: answer.action };
        return url ? { action: "accept" } : { action: "accept", content: (answer.content ?? {}) as Record<string, string | number | boolean | string[]> };
      });
    }
    if (capabilities.sampling) {
      client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
        const params = request.params;
        if (config.sampling !== "auto") {
          const answer = await interactions!.request(
            {
              kind: "sampling",
              serverId: config.id,
              serverName: config.name,
              messages: params.messages,
              systemPrompt: params.systemPrompt,
              maxTokens: params.maxTokens,
              modelHint: params.modelPreferences?.hints?.[0]?.name,
            },
            extra.signal,
          );
          if (!answer.approved) throw new McpError(ErrorCode.InvalidRequest, "User rejected sampling request");
        }
        return sample!(params, config, extra.signal);
      });
    }
    return client;
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
          env: { ...getDefaultEnvironment(), ...networkEnv(this.env), ...resolveRecord(config.env, this.env) },
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
        const url = new URL(resolveSecret(config.url, this.env)!);
        return new StreamableHTTPClientTransport(url, {
          requestInit: { headers },
          authProvider: this.oauthProvider(conn, url),
        });
      }
      case "sse": {
        if (!config.url) throw new Error("A URL is required for SSE servers.");
        const url = new URL(resolveSecret(config.url, this.env)!);
        return new SSEClientTransport(url, {
          authProvider: this.oauthProvider(conn, url),
          requestInit: { headers },
          eventSourceInit: headers
            ? { fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as any), ...headers } }) }
            : undefined,
        });
      }
    }
  }

  private oauthProvider(conn: Connection, url: URL): MokaOAuthProvider | undefined {
    const settings = oauthSettings(conn.config);
    const redirect = this.hooks.oauth?.redirectUrl();
    if (!settings || !redirect || !this.hooks.oauth) return undefined;
    conn.provider = new MokaOAuthProvider(this.hooks.oauth.store, conn.config.id, url.toString(), redirect, resolveOAuth(settings, this.env));
    return conn.provider;
  }

  /** Complete sign-in from the OAuth redirect (`?code&state`), then reconnect. */
  async finishAuth(state: string, code: string): Promise<McpServerState> {
    const oauth = this.hooks.oauth;
    const redirect = oauth?.redirectUrl();
    if (!oauth || !redirect) throw new Error("OAuth is not available");
    const serverId = await oauth.store.byState(state);
    const conn = serverId ? this.connections.get(serverId) : undefined;
    if (!conn?.config.url) throw new Error("Unknown or expired sign-in request. Start again from Moka.");
    const url = new URL(resolveSecret(conn.config.url, this.env)!);
    const provider = new MokaOAuthProvider(oauth.store, conn.config.id, url.toString(), redirect, resolveOAuth(oauthSettings(conn.config) ?? {}, this.env));
    const result = await auth(provider, { serverUrl: url, authorizationCode: code });
    if (result !== "AUTHORIZED") throw new Error("Sign-in did not complete");
    await oauth.store.update(conn.config.id, url.toString(), { state: undefined, codeVerifier: undefined });
    this.bus.emit({ kind: "mcp.status", serverId: conn.config.id, title: `${conn.config.name}: signed in`, data: { status: "signed-in" } });
    return this.reconnect(conn.config);
  }

  /** Forget OAuth tokens for a server and reconnect (it will ask to sign in again). */
  async signOut(config: McpServerConfig): Promise<McpServerState> {
    await this.hooks.oauth?.store.clear(config.id);
    return this.reconnect(config);
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

function resolveOAuth(settings: { clientId?: string; clientSecret?: string; scopes?: string[] }, env: NodeJS.ProcessEnv) {
  return { ...settings, clientId: resolveSecret(settings.clientId, env), clientSecret: resolveSecret(settings.clientSecret, env) };
}
