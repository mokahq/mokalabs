import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { auth, Client, ProtocolError, ProtocolErrorCode, SdkError, SdkErrorCode, SSEClientTransport, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import type { Transport, CreateMessageRequest, CreateMessageResult, McpSubscription, VersionNegotiationOptions } from "@modelcontextprotocol/client";
import type { InteractionBroker } from "./interactions.js";
import { MokaOAuthProvider, oauthSettings, type OAuthStore } from "./oauth.js";
import { resolveRecord, resolveSecret, type McpServerConfig } from "./config.js";
import type { EventBus } from "./events.js";
import { tracingFetch, type HttpExchange } from "./http-trace.js";
import { stableJson, withErrorClass } from "./lineage.js";
import { formatWait, RpcTracker } from "./rpc-tracker.js";

/** "auth" = the server needs the user to sign in (OAuth); see `authUrl`. */
/** `disconnected`: it was connected, then the server closed the connection (exited or crashed). */
export type McpStatus = "idle" | "connecting" | "connected" | "disconnected" | "error" | "auth";

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
  /** Parameterised resources (`resources/templates/list`), e.g. `file:///{path}`. */
  resourceTemplates: Array<{ uriTemplate: string; name?: string; title?: string; description?: string; mimeType?: string }>;
  /** The server supports `resources/subscribe`. */
  canSubscribe?: boolean;
  /** Resource URIs Moka is subscribed to. */
  subscriptions: string[];
  stderr: string[];
  connectedAt?: number;
  /** OAuth sign-in URL when status is "auth". */
  authUrl?: string;
  /** Present for OAuth-capable servers. */
  oauth?: { signedIn: boolean };
  /** HTTP/SSE servers: the latest exchange with the endpoint, secret values masked. */
  http?: HttpExchange;
  /** The negotiated MCP revision: `modern` is 2026-07-28 and later (no handshake, `server/discover`). */
  protocol?: { version?: string; era: "modern" | "legacy" };
}

interface Connection {
  config: McpServerConfig;
  fingerprint: string;
  client?: Client;
  transport?: Transport;
  provider?: MokaOAuthProvider;
  state: McpServerState;
  pending?: Promise<McpServerState>;
  /** Tool calls about to be sent, so the RPC log can name the tool call each `tools/call` belongs to. */
  calls?: { tool: string; args: string; callId: string }[];
  /** Ids of recent late replies (answers to requests Moka had cancelled). */
  late?: Set<string>;
  /** 2026-07-28 servers: the open `subscriptions/listen` stream. */
  listening?: McpSubscription;
  tracker?: RpcTracker;
  /** A `server/discover` went over this connection's transport. */
  discovered?: boolean;
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
  "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA", "NODE_USE_ENV_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
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
  /** serverId → subscribed resource URIs; survives reconnects. */
  private subscriptions = new Map<string, Set<string>>();

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
    for (const id of [...this.subscriptions.keys()]) if (!keep.has(id)) this.subscriptions.delete(id);
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
      resourceTemplates: [],
      subscriptions: [],
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
          // The SDK handles a response before a notification queued just ahead of it, so a final
          // progress update that arrives with the result finds its handler gone. Harmless: the
          // update is still in the RPC log, and the call is done.
          if (/progress notification for an unknown token/i.test(error.message)) return;
          // A reply to a request Moka already gave up on: the RPC log shows it as a "late" reply.
          const late = /response for an unknown message ID: (.*)$/s.exec(error.message);
          if (late && conn.late?.has(String(safeJson(late[1])?.id))) return;
          this.bus.emit({ kind: "mcp.log", level: "error", title: `${config.name}: ${error.message}`, serverId: config.id });
        };
        client.onclose = () => {
          if (this.connections.get(config.id) !== conn || state.status !== "connected") return;
          state.status = "disconnected";
          state.error = "The server closed the connection (it exited or crashed). Moka reconnects on the next call.";
          this.emitStatus(conn);
        };
        this.listen(conn, client);
        const timeout = config.timeoutMs ?? 30_000;
        this.tap(conn, transport);
        conn.client = client;
        conn.transport = transport;
        await withTimeout(client.connect(transport, { timeout }), timeout, `Timed out connecting to ${config.name}`);
        state.protocol = { version: client.getNegotiatedProtocolVersion(), era: client.getProtocolEra() ?? "legacy" };
        this.showProbe(conn, client, started);

        const caps = client.getServerCapabilities() ?? {};
        const info = client.getServerVersion();
        state.serverInfo = info ? { name: info.name, version: info.version } : undefined;
        state.instructions = client.getInstructions();
        state.tools = caps.tools ? await this.listAllTools(client) : [];
        state.prompts = caps.prompts ? ((await client.listPrompts().catch(() => ({ prompts: [] }))).prompts as any) : [];
        if (caps.resources) {
          state.resources = await this.listAllResources(client);
          state.resourceTemplates = await this.listAllTemplates(client);
          state.canSubscribe = Boolean((caps.resources as { subscribe?: boolean }).subscribe);
        }
        // Keep subscriptions across reconnects.
        const wanted = [...(this.subscriptions.get(config.id) ?? [])];
        if (state.protocol.era === "modern") {
          await this.relisten(conn).catch(() => undefined);
        } else if (state.canSubscribe) {
          await Promise.all(wanted.map((uri) => client.subscribeResource({ uri }).catch(() => undefined)));
          state.subscriptions = wanted;
        }
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
          // The SDK's message is often empty ("Error POSTing to endpoint: "); say what the server answered.
          const http = state.http;
          if (http?.status && http.status >= 400 && !state.error.includes(String(http.status))) state.error += ` (HTTP ${http.status})`;
          else if (http?.error && !state.error.includes(http.error)) state.error += ` (${http.error})`;
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

  /**
   * On stdio the SDK asks `server/discover` on a short-lived copy of the
   * server, so the exchange never crosses the session's pipe. Show it in the
   * RPC log anyway, marked as such, so the negotiation isn't invisible.
   */
  private showProbe(conn: Connection, client: Client, started: number): void {
    const { config, state, tracker } = conn;
    if (conn.discovered || !tracker || protocolSetting(config) === "2025") return;
    const discover = client.getDiscoverResult();
    if (state.protocol?.era === "modern" && discover) {
      const request = { jsonrpc: "2.0", id: "discover", method: "server/discover", params: {} };
      tracker.record("out", request, started, { title: "server/discover · asked on a separate copy of the server" });
      tracker.record("in", { jsonrpc: "2.0", id: "discover", result: discover }, Date.now(), { title: `result · server/discover: ${state.protocol.version}` });
    } else if (state.protocol?.era === "legacy") {
      this.bus.emit({ kind: "mcp.log", level: "info", serverId: config.id, title: `${config.name}: doesn't support server/discover, using MCP 2025 (initialize)` });
    }
  }

  /** A client that can answer elicitation and sampling requests when the host supports them. */
  private createClient(config: McpServerConfig): Client {
    const { interactions, sample } = this.hooks;
    const capabilities: Record<string, object> = {};
    if (interactions) capabilities.elicitation = { form: {}, url: {} };
    if (interactions && sample && config.sampling !== "deny") capabilities.sampling = {};
    const client = new Client(CLIENT_INFO, { capabilities, versionNegotiation: versionNegotiation(config) });
    if (capabilities.elicitation) {
      client.setRequestHandler("elicitation/create", async (request, ctx) => {
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
          ctx.mcpReq.signal,
        );
        if (answer.action !== "accept") return { action: answer.action };
        return url ? { action: "accept" } : { action: "accept", content: (answer.content ?? {}) as Record<string, string | number | boolean | string[]> };
      });
    }
    if (capabilities.sampling) {
      client.setRequestHandler("sampling/createMessage", async (request, ctx) => {
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
            ctx.mcpReq.signal,
          );
          if (!answer.approved) throw new ProtocolError(ProtocolErrorCode.InvalidRequest, "User rejected sampling request");
        }
        return sample!(params, config, ctx.mcpReq.signal);
      });
    }
    return client;
  }

  /** React to server-pushed notifications: resource updates and list changes. */
  private listen(conn: Connection, client: Client): void {
    const { config, state } = conn;
    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      const uri = notification.params.uri;
      this.bus.emit({ kind: "resource.updated", serverId: config.id, title: `${config.name}: ${uri} updated`, data: { uri } });
    });
    const refresh = async (what: string, load: () => Promise<void>) => {
      try {
        await load();
        this.bus.emit({ kind: "mcp.status", serverId: config.id, title: `${config.name}: ${what} changed`, data: { status: state.status, changed: what } });
      } catch {
        // the next reconnect will pick it up
      }
    };
    client.setNotificationHandler("notifications/resources/list_changed", () =>
      refresh("resources", async () => {
        state.resources = await this.listAllResources(client);
        state.resourceTemplates = await this.listAllTemplates(client);
      }),
    );
    client.setNotificationHandler("notifications/tools/list_changed", () =>
      refresh("tools", async () => {
        state.tools = await this.listAllTools(client);
      }),
    );
    client.setNotificationHandler("notifications/prompts/list_changed", () =>
      refresh("prompts", async () => {
        state.prompts = (await client.listPrompts()).prompts as any;
      }),
    );
  }

  private async listAllResources(client: Client): Promise<McpServerState["resources"]> {
    const out: McpServerState["resources"] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listResources(cursor ? { cursor } : undefined).catch(() => ({ resources: [], nextCursor: undefined }));
      out.push(...(page.resources as any));
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  private async listAllTemplates(client: Client): Promise<McpServerState["resourceTemplates"]> {
    const out: McpServerState["resourceTemplates"] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listResourceTemplates(cursor ? { cursor } : undefined).catch(() => ({ resourceTemplates: [], nextCursor: undefined }));
      out.push(...(page.resourceTemplates as any));
      cursor = page.nextCursor;
    } while (cursor);
    return out;
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

  /** Record what each HTTP request to the server actually carried. */
  private traceFetch(conn: Connection, endpoint: URL, headers: Record<string, string> | undefined, sameOrigin = false) {
    const { config, state } = conn;
    return tracingFetch({
      endpoint,
      sameOrigin,
      configured: headers,
      onExchange: (exchange) => {
        if (this.connections.get(config.id) !== conn) return;
        state.http = exchange;
        if (exchange.error || (exchange.status ?? 0) >= 400) {
          const path = new URL(exchange.url).pathname;
          this.bus.emit({
            kind: "mcp.http",
            level: "error",
            title: `${config.name}: ${exchange.error ? `${exchange.method} ${path} failed` : `HTTP ${exchange.status} on ${exchange.method} ${path}`}`,
            serverId: config.id,
            durationMs: exchange.durationMs,
            data: exchange,
          });
        }
      },
    });
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
          fetch: this.traceFetch(conn, url, headers),
        });
      }
      case "sse": {
        if (!config.url) throw new Error("A URL is required for SSE servers.");
        const url = new URL(resolveSecret(config.url, this.env)!);
        const traced = this.traceFetch(conn, url, headers, true);
        return new SSEClientTransport(url, {
          authProvider: this.oauthProvider(conn, url),
          requestInit: { headers },
          fetch: traced,
          eventSourceInit: headers
            ? { fetch: (url, init) => traced(url, { ...init, headers: { ...(init?.headers as any), ...headers } }) }
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
    const tracker = new RpcTracker(this.bus, {
      serverId: conn.config.id,
      linkCall: (message) => {
        if (message.method !== "tools/call" || !conn.calls?.length) return undefined;
        const args = stableJson(message.params?.arguments ?? {});
        const call = conn.calls.find((c) => c.tool === message.params?.name && c.args === args);
        if (call) conn.calls = conn.calls.filter((c) => c !== call);
        return call?.callId;
      },
      onLate: (rpcId) => {
        const late = (conn.late ??= new Set());
        late.add(rpcId);
        setTimeout(() => late.delete(rpcId), 10_000).unref?.();
      },
    });
    conn.tracker = tracker;
    const record = (direction: "in" | "out", message: any) => {
      if (message?.method === "server/discover") conn.discovered = true;
      tracker.record(direction, message);
    };

    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      record("out", message);
      return send(message, options);
    };
    let handler: Transport["onmessage"];
    Object.defineProperty(transport, "onmessage", {
      configurable: true,
      get: () => handler,
      set: (fn: Transport["onmessage"]) => {
        handler = fn
          ? (message, extra) => {
              record("in", message);
              fn(message, extra);
            }
          : fn;
      },
    });
    // When the connection closes, whatever is still open will never be answered.
    let onclose: Transport["onclose"];
    Object.defineProperty(transport, "onclose", {
      configurable: true,
      get: () => onclose,
      set: (fn: Transport["onclose"]) => {
        onclose = fn
          ? () => {
              tracker.close();
              fn();
            }
          : fn;
      },
    });
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; runId?: string; callId?: string } = {},
  ): Promise<{ content: unknown[]; isError?: boolean; structuredContent?: unknown }> {
    try {
      return await this.callToolOnce(serverId, toolName, args, options);
    } catch (error) {
      // The server rejected the call without running it, so it's safe to send again in a new session.
      if (!(await this.renewIfSessionLost(serverId, error))) throw error;
      return this.callToolOnce(serverId, toolName, args, options);
    }
  }

  /**
   * Streamable HTTP servers that keep sessions (MongoDB's, for one) forget them
   * when idle or restarted, and answer the old Mcp-Session-Id with 404 "session
   * not found". The spec says the client then starts a new session; do that.
   * Returns true when a new session is ready to retry on.
   */
  private async renewIfSessionLost(serverId: string, error: unknown): Promise<boolean> {
    const conn = this.connections.get(serverId);
    if (!conn || conn.config.transport !== "http" || !isSessionLost(error, conn)) return false;
    const { config } = conn;
    this.bus.emit({ kind: "mcp.log", level: "warn", serverId, title: `${config.name}: session expired on the server, starting a new one and retrying` });
    const state = await this.reconnect(config);
    return state.status === "connected";
  }

  private async callToolOnce(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; runId?: string; callId?: string },
  ): Promise<{ content: unknown[]; isError?: boolean; structuredContent?: unknown }> {
    let conn = this.connections.get(serverId);
    if (conn?.state.status === "disconnected") {
      // The server went away (it crashed or exited): start it again once, so a retry can actually retry.
      await this.ensure(conn.config).catch(() => undefined);
      conn = this.connections.get(serverId);
    }
    if (!conn?.client || conn.state.status !== "connected") {
      // Nothing was sent, so nothing can have happened on the server.
      throw withErrorClass(new Error(`MCP server "${conn?.config.name ?? serverId}" is not connected.`), "transport", { notSent: true });
    }
    const { config } = conn;
    const timeout = toolTimeout(config);
    let last = 0;
    const pending = options.callId ? { tool: toolName, args: stableJson(args), callId: options.callId } : undefined;
    if (pending) (conn.calls ??= []).push(pending);
    try {
      const result = await conn.client.callTool({ name: toolName, arguments: args }, {
        signal: options.signal,
        timeout,
        resetTimeoutOnProgress: config.resetTimeoutOnProgress ?? true,
        maxTotalTimeout: config.maxTotalTimeoutMs,
        // Passing a handler is what makes the SDK send a progressToken, so servers can report progress.
        onprogress: ({ progress, total, message }) => {
          const now = Date.now();
          if (now - last < 200 && (total === undefined || progress < total)) return;
          last = now;
          const percent = total ? Math.round((progress / total) * 100) : undefined;
          this.bus.emit({
            kind: "tool.progress",
            runId: options.runId,
            serverId,
            title: `${toolName} · ${percent !== undefined ? `${percent}%` : progress}${message ? ` · ${message}` : ""}`,
            data: { id: options.callId, tool: toolName, progress, total, message },
          });
        },
      });
      return result as any;
    } catch (error: any) {
      if (options.signal?.aborted) throw withErrorClass(error, "cancelled");
      if (error?.code === SdkErrorCode.RequestTimeout) {
        throw withErrorClass(
          new Error(
            `No answer from ${config.name} after ${formatWait(timeout)} (tool timeout), so Moka stopped waiting. The server may still be working; a late reply shows up in the inspector.`,
          ),
          "timeout",
        );
      }
      // The server answered: a JSON-RPC error, a reply that doesn't parse, or a multi-round-trip flow that never finished.
      // A dropped connection, a send failure, network, HTTP or a crash is the transport.
      const answered =
        error instanceof ProtocolError ||
        (error instanceof SdkError && (error.code === SdkErrorCode.InvalidResult || error.code === SdkErrorCode.InputRequiredRoundsExceeded)) ||
        error?.name === "ZodError";
      if (answered) throw withErrorClass(error, "protocol");
      throw withErrorClass(error, "transport");
    } finally {
      if (pending && conn.calls) conn.calls = conn.calls.filter((c) => c !== pending);
    }
  }

  async readResource(serverId: string, uri: string): Promise<unknown> {
    return this.withSession(serverId, (client) => client.readResource({ uri }));
  }

  /** Subscribe to `notifications/resources/updated` for a resource (kept across reconnects). */
  async subscribe(serverId: string, uri: string): Promise<string[]> {
    const conn = this.connections.get(serverId);
    if (!conn?.client) throw new Error("Server not connected");
    if (!conn.state.canSubscribe) throw new Error(`${conn.config.name} does not support resource subscriptions`);
    const set = this.subscriptions.get(serverId) ?? new Set<string>();
    if (conn.state.protocol?.era === "modern") {
      set.add(uri);
      this.subscriptions.set(serverId, set);
      await this.relisten(conn);
      return conn.state.subscriptions;
    }
    await conn.client.subscribeResource({ uri });
    set.add(uri);
    this.subscriptions.set(serverId, set);
    conn.state.subscriptions = [...set];
    return conn.state.subscriptions;
  }

  async unsubscribe(serverId: string, uri: string): Promise<string[]> {
    const conn = this.connections.get(serverId);
    const set = this.subscriptions.get(serverId);
    set?.delete(uri);
    if (conn?.client && conn.state.protocol?.era === "modern") {
      await this.relisten(conn).catch(() => undefined);
      return conn.state.subscriptions;
    }
    if (conn?.client && conn.state.canSubscribe) await conn.client.unsubscribeResource({ uri }).catch(() => undefined);
    if (conn) conn.state.subscriptions = [...(set ?? [])];
    return conn?.state.subscriptions ?? [];
  }

  /**
   * 2026-07-28 has no `resources/subscribe` and no unsolicited notifications:
   * the client opens one `subscriptions/listen` stream with everything it
   * wants. Changing the set means replacing the stream.
   */
  private async relisten(conn: Connection): Promise<void> {
    const { client, config, state } = conn;
    if (!client) return;
    const previous = conn.listening;
    conn.listening = undefined;
    await previous?.close().catch(() => undefined);
    const caps = client.getServerCapabilities() ?? {};
    const wanted = [...(this.subscriptions.get(config.id) ?? [])];
    const filter = {
      ...((caps.tools as { listChanged?: boolean } | undefined)?.listChanged ? { toolsListChanged: true } : {}),
      ...((caps.prompts as { listChanged?: boolean } | undefined)?.listChanged ? { promptsListChanged: true } : {}),
      ...((caps.resources as { listChanged?: boolean } | undefined)?.listChanged ? { resourcesListChanged: true } : {}),
      ...(state.canSubscribe && wanted.length ? { resourceSubscriptions: wanted } : {}),
    };
    if (!Object.keys(filter).length) {
      state.subscriptions = [];
      return;
    }
    const subscription = await client.listen(filter);
    const opened = Date.now();
    conn.listening = subscription;
    state.subscriptions = subscription.honoredFilter.resourceSubscriptions ?? [];
    void subscription.closed.then((how) => {
      if (conn.listening !== subscription || how === "local") return;
      conn.listening = undefined;
      if (this.connections.get(config.id) !== conn || state.status !== "connected") return;
      const lost = () => this.bus.emit({ kind: "mcp.log", level: "warn", serverId: config.id, title: `${config.name}: the server closed the subscription stream (${how})` });
      // The stream dropped: open it again, unless the server keeps closing it straight away.
      if (Date.now() - opened < 5_000) return lost();
      void this.relisten(conn).catch(lost);
    });
  }

  async getPrompt(serverId: string, name: string, args: Record<string, string> = {}): Promise<unknown> {
    return this.withSession(serverId, (client) => client.getPrompt({ name, arguments: args }));
  }

  /** Run a request on a server's client, once more in a new session if the server lost the old one. */
  private async withSession<T>(serverId: string, request: (client: Client) => Promise<T>): Promise<T> {
    const client = () => {
      const conn = this.connections.get(serverId);
      if (!conn?.client) throw new Error("Server not connected");
      return conn.client;
    };
    try {
      return await request(client());
    } catch (error) {
      if (!(await this.renewIfSessionLost(serverId, error))) throw error;
      return request(client());
    }
  }

  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;
    this.connections.delete(id);
    await conn.pending?.catch(() => {});
    const listening = conn.listening;
    conn.listening = undefined;
    await listening?.close().catch(() => {});
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
      data: { status: state.status, error: state.error, serverInfo: state.serverInfo, tools: state.tools.length, protocol: state.protocol },
    });
  }
}

/** The MCP revision to speak, from the server's `protocol` setting (see McpServerConfig). */
export function protocolSetting(config: McpServerConfig): "auto" | "2025" | "2026" {
  if (config.protocol) return config.protocol;
  if (config.command === "moka:demo") return "auto";
  return config.transport === "http" ? "auto" : "2025";
}

function versionNegotiation(config: McpServerConfig): VersionNegotiationOptions | undefined {
  const setting = protocolSetting(config);
  if (setting === "2026") return { mode: { pin: "2026-07-28" } };
  // A legacy server answers the probe with an error straight away; one that
  // ignores it is legacy too on stdio. Don't make it wait for the full timeout.
  if (setting === "auto") return { mode: "auto", probe: { timeoutMs: Math.min(config.timeoutMs ?? 10_000, 10_000) } };
  return undefined;
}

/** A Streamable HTTP request was refused because the server no longer knows our session. */
export function isSessionLost(error: unknown, conn: { transport?: Transport; state: { http?: { status?: number } } }): boolean {
  const message = errorMessage(error);
  if (/session (?:not found|expired|is not valid|unknown)|unknown session|invalid session/i.test(message)) return true;
  // HTTP 404 for a request that carried a session id means the session is gone (MCP spec, Streamable HTTP).
  const sessionId = (conn.transport as { sessionId?: string } | undefined)?.sessionId;
  return Boolean(sessionId) && (conn.state.http?.status === 404 || /\b404\b/.test(message));
}

/** The tool-call timeout for a server. */
export function toolTimeout(config: McpServerConfig): number {
  return config.toolTimeoutMs ?? config.timeoutMs ?? 120_000;
}

/** Node's fetch says only "fetch failed"; the reason (DNS, refused, TLS…) is in its cause. */
function withCause(error: Error): string {
  let message = error.message;
  const seen = new Set<unknown>([error]);
  for (let cause = (error as any).cause; cause instanceof Error && !seen.has(cause); cause = (cause as any).cause) {
    seen.add(cause);
    if (!message.includes(cause.message)) message = message === "fetch failed" ? cause.message : `${message}: ${cause.message}`;
  }
  return message;
}

const CERT_ERROR = /self[- ]signed certificate|unable to (get local issuer|verify the first|get issuer) certificate|certificate (has expired|is not yet valid)|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i;

/** What to do about the errors people hit on company networks. */
export function withNetworkHint(message: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!CERT_ERROR.test(message) || message.includes("NODE_EXTRA_CA_CERTS")) return message;
  const systemTrusted = env.NODE_USE_SYSTEM_CA === "1" || process.execArgv.includes("--use-system-ca");
  return systemTrusted
    ? `${message}. The server's certificate isn't trusted by Node or by your system. If it's your company's, ask IT for the root certificate (.pem) and restart Moka with NODE_EXTRA_CA_CERTS=/path/to/root.pem`
    : `${message}. The server's certificate is signed by an authority Node doesn't trust, which is common on company networks. Use Node 22.19+ so Moka trusts the certificates your system trusts, or restart Moka with NODE_EXTRA_CA_CERTS=/path/to/company-root.pem`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return withNetworkHint(withCause(error));
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

function safeJson(text: string | undefined): any {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}
