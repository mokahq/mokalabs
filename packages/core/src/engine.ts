import { generateText, type ModelMessage } from "ai";
import path from "node:path";
import { activeWorkspace, parseConfig, type LlmProfile, type MokaConfig, type Workspace } from "./config.js";
import { runAgent, type ChatChunk } from "./agent.js";
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
}

export interface ChatRequest {
  messages: ModelMessage[];
  workspaceId?: string;
  /** Override the workspace's model (used by compare mode). */
  llmId?: string;
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
    this.mcp = new McpManager(this.bus, this.env, options.resolveCommand);
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

  /** Connect every server in a workspace (or all servers) and return states. */
  async connectAll(workspaceId?: string) {
    const ids = workspaceId ? this.workspace(workspaceId).mcpServerIds : this.config.mcpServers.map((s) => s.id);
    const servers = this.config.mcpServers.filter((s) => ids.includes(s.id));
    return Promise.all(servers.map((s) => this.mcp.ensure(s)));
  }

  async *chat(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const workspace = this.workspace(request.workspaceId);
    const llm = this.llm(request.llmId ?? workspace.llmId);
    const runId = request.runId ?? `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!llm) {
      yield { type: "error", message: "No model configured. Add one in Settings → Models." };
      return;
    }
    const servers = this.config.mcpServers.filter((s) => workspace.mcpServerIds.includes(s.id));
    const skills = await this.loadSkills(workspace.skillIds);
    yield* runAgent({
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

  listModels(profile: LlmProfile): Promise<string[]> {
    return listModels(profile, this.env);
  }

  async close(): Promise<void> {
    await this.mcp.closeAll();
  }
}
