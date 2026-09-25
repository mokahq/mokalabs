export type ProviderKind = "openai" | "anthropic" | "google" | "azure" | "ollama" | "openai-compatible";

export interface LlmProfile {
  id: string;
  name: string;
  provider: ProviderKind;
  model: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  resourceName?: string;
  apiVersion?: string;
  useChatApi?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: Record<string, unknown>;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabledTools?: string[];
  timeoutMs?: number;
}

export interface SkillConfig {
  id: string;
  path?: string;
  content?: string;
  name?: string;
  description?: string;
}

export interface Workspace {
  id: string;
  name: string;
  llmId?: string;
  mcpServerIds: string[];
  skillIds: string[];
  systemPrompt?: string;
  starterPrompts?: string[];
  maxSteps?: number;
  generativeUi?: boolean;
}

export interface MokaConfig {
  version: 1;
  activeWorkspaceId?: string;
  llms: LlmProfile[];
  mcpServers: McpServerConfig[];
  skills: SkillConfig[];
  workspaces: Workspace[];
}

export interface ProviderPreset {
  id: string;
  label: string;
  provider: ProviderKind;
  baseURL?: string;
  envKey?: string;
  defaultModel: string;
  docsUrl?: string;
  needsKey: boolean;
}

export type UiDescriptor =
  | { kind: "mcp-app"; serverId: string; resourceUri: string }
  | { kind: "mcp-ui"; serverId: string; uri: string; mimeType: string; html?: string; url?: string }
  | { kind: "a2ui"; messages: Array<Record<string, any>> };

export interface RawToolResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpTool {
  _meta?: Record<string, any>;
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: Record<string, unknown>;
}

export interface McpServerState {
  id: string;
  name: string;
  status: "idle" | "connecting" | "connected" | "error";
  error?: string;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  tools: McpTool[];
  prompts: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>;
  resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>;
  stderr: string[];
}

export interface LoadedSkill {
  id: string;
  name: string;
  description: string;
  body?: string;
  dir?: string;
  files: string[];
  error?: string;
}

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: JsonSchema;
  title?: string;
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchema[];
  [key: string]: unknown;
}

export interface MokaEvent {
  id: string;
  ts: number;
  kind: string;
  title: string;
  runId?: string;
  serverId?: string;
  durationMs?: number;
  direction?: "in" | "out";
  level?: "info" | "warn" | "error";
  data?: unknown;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type ChatChunk =
  | { type: "start"; runId: string; model: string; profileId: string; tools: number }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; tool: string; source: string; input: unknown }
  | { type: "tool-result"; id: string; output: unknown; isError: boolean; durationMs?: number; ui?: UiDescriptor; raw?: RawToolResult }
  | { type: "step"; usage: Usage; finishReason: string }
  | { type: "finish"; usage: Usage; durationMs: number; messages: unknown[] }
  | { type: "error"; message: string };

export type Part =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      tool: string;
      source: string;
      input: unknown;
      output?: unknown;
      isError?: boolean;
      durationMs?: number;
      status: "running" | "done" | "error";
      ui?: UiDescriptor;
      raw?: RawToolResult;
    };

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  parts: Part[];
  meta?: {
    model?: string;
    profileId?: string;
    runId?: string;
    usage?: Usage;
    durationMs?: number;
    steps?: number;
    error?: string;
    firstTokenMs?: number;
    /** User messages produced by a UI (A2UI button, MCP App ui/message). */
    via?: "a2ui" | "mcp-app";
  };
}

export interface SessionData {
  messages: UiMessage[];
  modelMessages: unknown[];
}

export interface SessionSummary {
  id: string;
  title: string;
  workspaceId?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface Bootstrap {
  version: string;
  configPath: string;
  config: MokaConfig;
  presets: ProviderPreset[];
  env: Record<string, boolean>;
  mcp: McpServerState[];
  skills: LoadedSkill[];
}
