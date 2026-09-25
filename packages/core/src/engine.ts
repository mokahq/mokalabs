import { dynamicTool, generateText, jsonSchema, type ModelMessage } from "ai";
import path from "node:path";
import { activeWorkspace, parseConfig, type AgentConfig, type LlmProfile, type McpServerConfig, type MokaConfig, type Workspace } from "./config.js";
import { runAgent, type ChatChunk, type ToolAuthorization } from "./agent.js";
import {
  buildRenderUiDescription,
  buildRenderUiSchema,
  ComponentRegistry,
  loadCatalog,
  previewInput,
  renderUi,
  resolveGenerativeUi,
  STANDARD_CATALOG,
  workspaceRegistry,
  type LoadedCatalog,
} from "./catalog.js";
import { OAuthStore } from "./oauth.js";
import { runRemoteAgent, testRemoteAgent } from "./remote-agent.js";
import { InteractionBroker, type InteractionHandler, type InteractionResponse } from "./interactions.js";
import type { McpTool } from "./mcp.js";
import type { CreateMessageRequest, CreateMessageResult } from "@modelcontextprotocol/sdk/types.js";
import { EventBus } from "./events.js";
import { McpManager, type CommandResolver } from "./mcp.js";
import { createModel, listModels } from "./providers.js";
import { loadSkill, type LoadedSkill } from "./skills.js";
import type { ConfigStore } from "./store.js";

export interface EngineOptions {
  config: MokaConfig;
  /** Persist config changes here. Omit for an in-memory engine. */
  store?: ConfigStore;
  env?: NodeJS.ProcessEnv;
  /** Relative skill paths resolve against this directory. */
  baseDir?: string;
  bus?: EventBus;
  resolveCommand?: CommandResolver;
  /**
   * Answer approvals / elicitation / sampling programmatically. Without it,
   * requests wait for `engine.respond()` (the sandbox UI calls it over HTTP).
   */
  onInteraction?: InteractionHandler;
  /** Where OAuth tokens for remote MCP servers are stored. Omit to disable OAuth. */
  oauthStorePath?: string;
}

/** Which tools need the user's OK before they run. */
export function approvalMode(server: McpServerConfig, tool: Pick<McpTool, "name" | "annotations">, workspace?: Workspace): "auto" | "ask" {
  const explicit = server.approval?.tools?.[tool.name];
  if (explicit) return explicit;
  if (workspace?.requireApproval) return "ask";
  if (server.approval?.default) return server.approval.default;
  return tool.annotations?.destructiveHint === true && tool.annotations?.readOnlyHint !== true ? "ask" : "auto";
}

export interface ChatRequest {
  messages: ModelMessage[];
  workspaceId?: string;
  /** Override the workspace's model (used by compare mode). */
  llmId?: string;
  /** Chat with this remote agent instead (overrides the workspace). */
  agentId?: string;
  signal?: AbortSignal;
  runId?: string;
}

/**
 * The headless Moka engine: config + MCP connections + skills + agent loop,
 * with every step published on `bus`. The sandbox server is a thin HTTP layer
 * over this class; embed it directly to build your own UI or tests.
 */
export class MokaEngine {
  readonly bus: EventBus;
  readonly mcp: McpManager;
  readonly interactions: InteractionBroker;
  /** `serverId/tool` pairs the user allowed for the rest of this process. */
  private readonly sessionAllowed = new Set<string>();
  /** Loopback URL for OAuth redirects; set by the host once it knows its port. */
  oauthRedirectUrl?: string;
  private config: MokaConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly baseDir: string;
  private readonly store?: ConfigStore;

  constructor(options: EngineOptions) {
    this.config = parseConfig(options.config);
    this.env = options.env ?? process.env;
    this.store = options.store;
    this.baseDir = options.baseDir ?? (options.store ? path.dirname(options.store.file) : process.cwd());
    this.bus = options.bus ?? new EventBus();
    this.interactions = new InteractionBroker(this.bus, options.onInteraction);
    this.mcp = new McpManager(this.bus, this.env, options.resolveCommand, {
      interactions: this.interactions,
      sample: (params, server, signal) => this.sample(params, server, signal),
      oauth: options.oauthStorePath ? { store: new OAuthStore(options.oauthStorePath), redirectUrl: () => this.oauthRedirectUrl } : undefined,
    });
  }

  getConfig(): MokaConfig {
    return this.config;
  }

  async setConfig(next: unknown): Promise<MokaConfig> {
    const parsed = parseConfig(next);
    this.config = this.store ? await this.store.save(parsed) : parsed;
    await this.mcp.prune(this.config.mcpServers.map((s) => s.id));
    return this.config;
  }

  workspace(id?: string): Workspace {
    return (id && this.config.workspaces.find((w) => w.id === id)) || activeWorkspace(this.config);
  }

  llm(id?: string): LlmProfile | undefined {
    return this.config.llms.find((l) => l.id === id) ?? this.config.llms[0];
  }

  async loadSkills(ids?: string[]): Promise<LoadedSkill[]> {
    const wanted = ids ? this.config.skills.filter((s) => ids.includes(s.id)) : this.config.skills;
    return Promise.all(wanted.map((s) => loadSkill(s, this.baseDir)));
  }

  async loadCatalogs(ids?: string[]): Promise<LoadedCatalog[]> {
    const wanted = ids ? this.config.catalogs.filter((c) => ids.includes(c.id)) : this.config.catalogs;
    return Promise.all(wanted.map((c) => loadCatalog(c, this.baseDir)));
  }

  /** Answer a pending approval / elicitation / sampling request. */
  async respond(id: string, response: InteractionResponse): Promise<boolean> {
    const interaction = this.interactions.pending().find((i) => i.id === id);
    if (interaction?.kind === "tool-approval" && "approved" in response && response.approved && "remember" in response && response.remember) {
      this.sessionAllowed.add(`${interaction.serverId}/${interaction.tool}`);
      if (response.remember === "always") {
        const config = this.config;
        await this.setConfig({
          ...config,
          mcpServers: config.mcpServers.map((s) =>
            s.id === interaction.serverId ? { ...s, approval: { ...s.approval, tools: { ...s.approval?.tools, [interaction.tool]: "auto" as const } } } : s,
          ),
        });
      }
    }
    return this.interactions.respond(id, response);
  }

  private authorizer(workspace: Workspace) {
    return async ({ runId, toolCallId, server, tool, input, signal }: ToolAuthorization): Promise<boolean> => {
      if (approvalMode(server, tool, workspace) === "auto" || this.sessionAllowed.has(`${server.id}/${tool.name}`)) return true;
      const answer = await this.interactions.request(
        { kind: "tool-approval", runId, toolCallId, serverId: server.id, serverName: server.name, tool: tool.name, input, annotations: tool.annotations },
        signal,
      );
      return answer.approved;
    };
  }

  /** Answer an MCP `sampling/createMessage` request with the active workspace's model. */
  private async sample(params: CreateMessageRequest["params"], server: McpServerConfig, signal?: AbortSignal): Promise<CreateMessageResult> {
    const workspace = this.workspace();
    const llm = this.llm(workspace.llmId);
    if (!llm) throw new Error("Moka has no model configured to sample with");
    const messages = params.messages.map((m) => {
      const blocks = (Array.isArray(m.content) ? m.content : [m.content]) as any[];
      const parts = blocks.map((b) =>
        b?.type === "image" ? { type: "image" as const, image: b.data as string, mediaType: b.mimeType as string } : { type: "text" as const, text: String(b?.text ?? JSON.stringify(b)) },
      );
      return m.role === "assistant"
        ? { role: "assistant" as const, content: parts.filter((p) => p.type === "text") as Array<{ type: "text"; text: string }> }
        : { role: "user" as const, content: parts };
    });
    const started = Date.now();
    this.bus.emit({ kind: "llm.request", serverId: server.id, title: `→ ${llm.model} · sampling for ${server.name}`, data: { params } });
    const result = await generateText({
      model: createModel(llm, this.env),
      system: params.systemPrompt,
      messages: messages as ModelMessage[],
      maxOutputTokens: params.maxTokens,
      temperature: params.temperature ?? llm.temperature,
      stopSequences: params.stopSequences,
      maxRetries: 1,
      abortSignal: signal,
    });
    this.bus.emit({
      kind: "llm.response",
      serverId: server.id,
      title: `← ${llm.model} · sampling for ${server.name} · ${result.usage.totalTokens ?? "?"} tok`,
      durationMs: Date.now() - started,
      data: { text: result.text, usage: result.usage, finishReason: result.finishReason },
    });
    return {
      model: llm.model,
      role: "assistant",
      content: { type: "text", text: result.text },
      stopReason: result.finishReason === "length" ? "maxTokens" : "endTurn",
    };
  }

  /** Validate and expand render_ui input the way a workspace would (catalog playground). */
  async previewUi(input: unknown, workspaceId?: string) {
    const workspace = this.workspace(workspaceId);
    const settings = resolveGenerativeUi(workspace);
    const registry = workspaceRegistry(settings, await this.loadCatalogs());
    return renderUi(input, { fallbackId: "preview", registry, theme: settings.theme });
  }

  /** Render one catalog component with sample props (catalog browser). */
  async previewComponent(catalogId: string, name: string) {
    const catalogs = [STANDARD_CATALOG, ...(await this.loadCatalogs())];
    const catalog = catalogs.find((c) => c.id === catalogId);
    const component = catalog?.components[name];
    if (!component) return { messages: [], problems: [`Unknown component ${catalogId}/${name}`], input: undefined };
    const input = previewInput(name, component);
    return { ...renderUi(input, { fallbackId: `preview-${name}`, registry: new ComponentRegistry(catalogs), theme: catalog.theme }), input };
  }

  /** Ask a model for a UI with only the render tool available (catalog playground). */
  async generateUi(prompt: string, options: { workspaceId?: string; llmId?: string; signal?: AbortSignal } = {}) {
    const workspace = this.workspace(options.workspaceId);
    const llm = this.llm(options.llmId ?? workspace.llmId);
    if (!llm) throw new Error("No model configured. Add one in Settings → Models.");
    const settings = { ...resolveGenerativeUi(workspace), enabled: true };
    const registry = workspaceRegistry(settings, await this.loadCatalogs());
    const started = Date.now();
    let captured: unknown;
    const result = await generateText({
      model: createModel(llm, this.env),
      system: workspace.systemPrompt,
      prompt,
      tools: {
        [settings.toolName]: dynamicTool({
          description: buildRenderUiDescription(settings, registry),
          inputSchema: jsonSchema(buildRenderUiSchema(registry) as any),
          execute: async (input) => {
            captured = input;
            return "ok";
          },
        }),
      },
      toolChoice: "required",
      maxRetries: 1,
      abortSignal: options.signal ?? AbortSignal.timeout(120_000),
    });
    const rendered = captured ? renderUi(captured, { fallbackId: "generated", registry, theme: settings.theme }) : { messages: [], problems: ["The model did not call the render tool"] };
    return { ...rendered, input: captured, model: llm.model, durationMs: Date.now() - started, usage: result.totalUsage };
  }

  /** The render tool definition a workspace exposes (for the playground and docs). */
  async renderToolDefinition(workspaceId?: string) {
    const settings = resolveGenerativeUi(this.workspace(workspaceId));
    const catalogs = await this.loadCatalogs();
    const registry = workspaceRegistry(settings, catalogs);
    return {
      enabled: settings.enabled,
      name: settings.toolName,
      description: buildRenderUiDescription(settings, registry),
      inputSchema: buildRenderUiSchema(registry),
      components: registry.names(),
      catalogs: [STANDARD_CATALOG, ...catalogs],
    };
  }

  /** Connect every server in a workspace (or all servers) and return states. */
  async connectAll(workspaceId?: string) {
    const ids = workspaceId ? this.workspace(workspaceId).mcpServerIds : this.config.mcpServers.map((s) => s.id);
    const servers = this.config.mcpServers.filter((s) => ids.includes(s.id));
    return Promise.all(servers.map((s) => this.mcp.ensure(s)));
  }

  async *chat(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const workspace = this.workspace(request.workspaceId);
    const runId = request.runId ?? `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const agentId = request.agentId ?? (request.llmId ? undefined : workspace.agentId);
    const agent = agentId ? this.config.agents.find((a) => a.id === agentId) : undefined;
    if (agent) {
      yield* runRemoteAgent({
        runId,
        agent,
        workspace,
        messages: request.messages,
        servers: this.config.mcpServers.filter((s) => workspace.mcpServerIds.includes(s.id)),
        catalogs: await this.loadCatalogs(),
        mcp: this.mcp,
        bus: this.bus,
        signal: request.signal,
        env: this.env,
        authorizeTool: this.authorizer(workspace),
      });
      return;
    }
    const llm = this.llm(request.llmId ?? workspace.llmId);
    if (!llm) {
      yield { type: "error", message: "No model configured. Add one in Settings → Models." };
      return;
    }
    const servers = this.config.mcpServers.filter((s) => workspace.mcpServerIds.includes(s.id));
    const [skills, catalogs] = await Promise.all([this.loadSkills(workspace.skillIds), this.loadCatalogs()]);
    yield* runAgent({
      catalogs,
      authorizeTool: this.authorizer(workspace),
      runId,
      llm,
      workspace,
      servers,
      skills,
      messages: request.messages,
      mcp: this.mcp,
      bus: this.bus,
      signal: request.signal,
      env: this.env,
    });
  }

  /** Send a tiny prompt to verify credentials and connectivity. */
  async testLlm(profile: LlmProfile): Promise<{ ok: boolean; latencyMs: number; text?: string; error?: string }> {
    const started = Date.now();
    try {
      const result = await generateText({
        model: createModel(profile, this.env),
        prompt: "Reply with exactly: pong",
        maxOutputTokens: 16,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(30_000),
      });
      return { ok: true, latencyMs: Date.now() - started, text: result.text };
    } catch (error: any) {
      return { ok: false, latencyMs: Date.now() - started, error: error?.message ?? String(error) };
    }
  }

  testAgent(agent: AgentConfig) {
    return testRemoteAgent(agent, this.env);
  }

  listModels(profile: LlmProfile): Promise<string[]> {
    return listModels(profile, this.env);
  }

  async close(): Promise<void> {
    this.interactions.cancelAll();
    await this.mcp.closeAll();
  }
}
