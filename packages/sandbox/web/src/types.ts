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

export type AgentProtocol = "a2a" | "ag-ui";

export interface AgentConfig {
  id: string;
  name: string;
  protocol: AgentProtocol;
  url: string;
  headers?: Record<string, string>;
  shareTools?: boolean;
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
  approval?: { default?: ApprovalMode; tools?: Record<string, ApprovalMode> };
  oauth?: boolean | { clientId?: string; clientSecret?: string; scopes?: string[] };
  sampling?: "ask" | "auto" | "deny";
}

export type ApprovalMode = "auto" | "ask";

export interface SurfaceTheme {
  primaryColor?: string;
  font?: string;
  radius?: number;
  density?: "compact" | "comfortable";
  agentDisplayName?: string;
  iconUrl?: string;
}

export interface GenerativeUiConfig {
  enabled?: boolean;
  toolName?: string;
  description?: string;
  instructions?: string;
  standard?: boolean;
  catalogIds?: string[];
  allow?: string[];
  deny?: string[];
  theme?: SurfaceTheme;
  examples?: boolean;
  repair?: boolean;
}

export interface CatalogConfig {
  id: string;
  name?: string;
  path?: string;
  url?: string;
  catalog?: Record<string, unknown>;
}

export interface CatalogComponent {
  description?: string;
  props?: Record<string, JsonSchema>;
  required?: string[];
  template?: Array<Record<string, any>>;
  html?: string;
  csp?: { resourceDomains?: string[]; connectDomains?: string[] };
  height?: number;
  example?: Record<string, unknown>;
  builtin?: boolean;
}

export interface LoadedCatalog {
  id: string;
  catalogId: string;
  name: string;
  description?: string;
  version?: string;
  instructions?: string;
  theme?: SurfaceTheme;
  components: Record<string, CatalogComponent>;
  examples?: Array<{ title?: string; prompt?: string; components: Array<Record<string, any>>; data?: Record<string, unknown> }>;
  source: "builtin" | "file" | "url" | "inline" | "mcp";
  path?: string;
  error?: string;
}

export type Interaction = { id: string; createdAt: number } & (
  | { kind: "tool-approval"; runId?: string; toolCallId: string; serverId: string; serverName: string; tool: string; input: unknown; annotations?: Record<string, unknown> }
  | { kind: "elicitation"; serverId: string; serverName: string; message: string; mode: "form" | "url"; requestedSchema?: JsonSchema; url?: string }
  | { kind: "sampling"; serverId: string; serverName: string; messages: unknown[]; systemPrompt?: string; maxTokens?: number; modelHint?: string }
);

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
  agentId?: string;
  mcpServerIds: string[];
  skillIds: string[];
  systemPrompt?: string;
  starterPrompts?: string[];
  maxSteps?: number;
  generativeUi?: boolean | GenerativeUiConfig;
  requireApproval?: boolean;
}

export interface MokaConfig {
  version: 1;
  activeWorkspaceId?: string;
  llms: LlmProfile[];
  mcpServers: McpServerConfig[];
  skills: SkillConfig[];
  agents: AgentConfig[];
  catalogs: CatalogConfig[];
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
  status: "idle" | "connecting" | "connected" | "error" | "auth";
  error?: string;
  authUrl?: string;
  oauth?: { signedIn: boolean };
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  tools: McpTool[];
  prompts: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>;
  resources: Array<{ uri: string; name?: string; title?: string; description?: string; mimeType?: string }>;
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

/** A file, image or MCP resource the user attached to a message. */
export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  kind: "image" | "file" | "text" | "resource";
  /** data: URL for images and binary files. */
  dataUrl?: string;
  /** Inline text for text files and MCP resources. */
  text?: string;
  /** MCP resource origin. */
  uri?: string;
  serverId?: string;
}

export type Part =
  | { type: "text"; text: string }
  | { type: "attachment"; attachment: Omit<Attachment, "text"> & { text?: undefined } }
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
  catalogs: LoadedCatalog[];
  interactions: Interaction[];
}
