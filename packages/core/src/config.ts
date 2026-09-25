import { z } from "zod";

/**
 * Provider kinds Moka knows how to talk to natively. Everything else can be
 * reached through `openai-compatible` with a base URL.
 */
export const PROVIDER_KINDS = [
  "openai",
  "anthropic",
  "google",
  "azure",
  "ollama",
  "openai-compatible",
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

const stringRecord = z.record(z.string(), z.string());

export const llmProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.enum(PROVIDER_KINDS),
  model: z.string().min(1),
  /** Literal key, or `env:VAR_NAME` / `${VAR_NAME}` to read from the environment. */
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  headers: stringRecord.optional(),
  /** Azure only. */
  resourceName: z.string().optional(),
  apiVersion: z.string().optional(),
  /** OpenAI only: use the Chat Completions API instead of Responses. */
  useChatApi: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** Free-form provider options passed straight to the AI SDK. */
  providerOptions: z.record(z.string(), z.any()).optional(),
});
export type LlmProfile = z.infer<typeof llmProfileSchema>;

export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export const MCP_APPROVAL_MODES = ["auto", "ask"] as const;
export type ApprovalMode = (typeof MCP_APPROVAL_MODES)[number];
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const mcpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: z.enum(MCP_TRANSPORTS),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: stringRecord.optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: stringRecord.optional(),
  /** Tools hidden from the model (still callable from the tool runner). */
  disabledTools: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  /**
   * OAuth for http/sse servers. On by default when the server asks for it and
   * no Authorization header is set; `false` disables it, an object sets a
   * pre-registered client and scopes.
   */
  oauth: z
    .union([
      z.boolean(),
      z.object({ clientId: z.string().optional(), clientSecret: z.string().optional(), scopes: z.array(z.string()).optional() }),
    ])
    .optional(),
  /** MCP sampling requests from this server: ask the user (default), allow, or refuse. */
  sampling: z.enum(["ask", "auto", "deny"]).optional(),
  /**
   * When to ask the user before the model runs a tool. `default` applies to
   * every tool (tools annotated destructiveHint default to "ask"); `tools`
   * overrides individual tools.
   */
  approval: z
    .object({
      default: z.enum(MCP_APPROVAL_MODES).optional(),
      tools: z.record(z.string(), z.enum(MCP_APPROVAL_MODES)).optional(),
    })
    .optional(),
});
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export const skillSchema = z.object({
  id: z.string().min(1),
  /** Folder containing SKILL.md, or a path to a SKILL.md file. */
  path: z.string().optional(),
  /** Inline SKILL.md content (frontmatter optional). */
  content: z.string().optional(),
  /** Overrides for frontmatter values. */
  name: z.string().optional(),
  description: z.string().optional(),
});
export type SkillConfig = z.infer<typeof skillSchema>;

export const AGENT_PROTOCOLS = ["a2a", "ag-ui"] as const;
export type AgentProtocol = (typeof AGENT_PROTOCOLS)[number];

/** A remote agent Moka can chat with instead of a raw model. */
export const agentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  protocol: z.enum(AGENT_PROTOCOLS),
  /** A2A: agent card URL or JSON-RPC endpoint. AG-UI: the agent's run endpoint. */
  url: z.string().min(1),
  headers: stringRecord.optional(),
  /** AG-UI: offer the workspace's MCP tools and render tool to the agent as frontend tools. */
  shareTools: z.boolean().optional(),
});
export type AgentConfig = z.infer<typeof agentSchema>;

export const catalogConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  /** A catalog JSON file (relative paths resolve against the config file). */
  path: z.string().optional(),
  /** A catalog JSON served over HTTP(S). */
  url: z.string().optional(),
  /** An inline catalog object. */
  catalog: z.record(z.string(), z.any()).optional(),
});
export type CatalogConfig = z.infer<typeof catalogConfigSchema>;

export const surfaceThemeSchema = z.object({
  primaryColor: z.string().optional(),
  font: z.string().optional(),
  radius: z.number().min(0).max(40).optional(),
  density: z.enum(["compact", "comfortable"]).optional(),
  agentDisplayName: z.string().optional(),
  iconUrl: z.string().optional(),
});

export const generativeUiSchema = z.object({
  enabled: z.boolean().optional(),
  /** Name of the tool the model calls. Default "render_ui". */
  toolName: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/, "letters, digits, _ and - only")
    .optional(),
  /** Replace the generated tool description entirely. */
  description: z.string().optional(),
  /** Extra guidance appended to the tool description. */
  instructions: z.string().optional(),
  /** Include the A2UI standard catalog. Default true. */
  standard: z.boolean().optional(),
  /** Custom catalogs (ids from the top-level `catalogs`). */
  catalogIds: z.array(z.string()).optional(),
  /** Only these component names. */
  allow: z.array(z.string()).optional(),
  /** Never these component names. */
  deny: z.array(z.string()).optional(),
  theme: surfaceThemeSchema.optional(),
  /** Put catalog examples in the tool description. Default true. */
  examples: z.boolean().optional(),
  /** Send validation errors back to the model so it can fix its UI. Default true. */
  repair: z.boolean().optional(),
});
export type GenerativeUiConfig = z.infer<typeof generativeUiSchema>;

export const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  llmId: z.string().optional(),
  /** Chat with a remote agent (A2A / AG-UI) instead of `llmId`. */
  agentId: z.string().optional(),
  mcpServerIds: z.array(z.string()).default([]),
  skillIds: z.array(z.string()).default([]),
  systemPrompt: z.string().optional(),
  starterPrompts: z.array(z.string()).optional(),
  maxSteps: z.number().int().min(1).max(100).optional(),
  /** Generative UI (A2UI): `false` to disable, or settings for the render_ui tool. Default on. */
  generativeUi: z.union([z.boolean(), generativeUiSchema]).optional(),
  /** Ask before every MCP tool call in this workspace (overrides per-server settings). */
  requireApproval: z.boolean().optional(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const mokaConfigSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1).default(1),
  activeWorkspaceId: z.string().optional(),
  llms: z.array(llmProfileSchema).default([]),
  mcpServers: z.array(mcpServerSchema).default([]),
  skills: z.array(skillSchema).default([]),
  /** Remote agents (A2A, AG-UI). */
  agents: z.array(agentSchema).default([]),
  /** A2UI component catalogs available to workspaces. */
  catalogs: z.array(catalogConfigSchema).default([]),
  workspaces: z.array(workspaceSchema).default([]),
});
export type MokaConfig = z.infer<typeof mokaConfigSchema>;

export function emptyConfig(): MokaConfig {
  return mokaConfigSchema.parse({
    workspaces: [{ id: "default", name: "Default", mcpServerIds: [], skillIds: [] }],
    activeWorkspaceId: "default",
  });
}

/** Validate and normalise a config, guaranteeing at least one workspace. */
export function parseConfig(input: unknown): MokaConfig {
  const config = mokaConfigSchema.parse(input ?? {});
  if (config.workspaces.length === 0) {
    config.workspaces.push({ id: "default", name: "Default", mcpServerIds: [], skillIds: [] });
  }
  if (!config.activeWorkspaceId || !config.workspaces.some((w) => w.id === config.activeWorkspaceId)) {
    config.activeWorkspaceId = config.workspaces[0]!.id;
  }
  return config;
}

export function activeWorkspace(config: MokaConfig): Workspace {
  return config.workspaces.find((w) => w.id === config.activeWorkspaceId) ?? config.workspaces[0]!;
}

const ENV_PREFIX = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;
const ENV_TEMPLATE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Resolve `env:NAME` and `${NAME}` references against `env`.
 * Unknown variables resolve to an empty string.
 */
export function resolveSecret(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (value == null || value === "") return value;
  const direct = ENV_PREFIX.exec(value);
  if (direct) return env[direct[1]!] ?? "";
  return value.replace(ENV_TEMPLATE, (_, name: string) => env[name] ?? "");
}

export function resolveRecord(
  record: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (!record) return record;
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, resolveSecret(v, env) ?? ""]));
}

function isSecretReference(value: string): boolean {
  return ENV_PREFIX.test(value) || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value);
}

const SENSITIVE_KEY = /(key|token|secret|password|authorization|auth|cookie)/i;

/**
 * Produce a copy of the config that is safe to share: literal API keys and
 * sensitive-looking headers / env values are replaced with placeholders,
 * while `env:` references are kept.
 */
export function redactConfig(config: MokaConfig): MokaConfig {
  const scrub = (value: string | undefined, placeholder: string) =>
    value == null || value === "" || isSecretReference(value) ? value : placeholder;
  const scrubRecord = (record: Record<string, string> | undefined) =>
    record &&
    Object.fromEntries(
      Object.entries(record).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? scrub(v, "<redacted>")! : v]),
    );
  return {
    ...config,
    llms: config.llms.map((llm) => ({
      ...llm,
      apiKey: scrub(llm.apiKey, "<set-me>"),
      headers: scrubRecord(llm.headers),
    })),
    mcpServers: config.mcpServers.map((s) => ({
      ...s,
      env: scrubRecord(s.env),
      headers: scrubRecord(s.headers),
      ...(typeof s.oauth === "object" && s.oauth.clientSecret ? { oauth: { ...s.oauth, clientSecret: scrub(s.oauth.clientSecret, "<set-me>") } } : {}),
    })),
    agents: config.agents.map((a) => ({ ...a, headers: scrubRecord(a.headers) })),
  };
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "item";
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const slug = slugify(base);
  if (!used.has(slug)) return slug;
  for (let i = 2; ; i++) {
    const candidate = `${slug}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** JSON Schema for moka.json, for editor autocompletion (`"$schema"`). */
export function mokaJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(mokaConfigSchema, { io: "input" }) as Record<string, unknown>;
  return {
    ...schema,
    $id: "https://unpkg.com/@mokalabs/sandbox/dist/moka.schema.json",
    title: "Moka config",
    description: "Models, MCP servers, skills and workspaces for Moka (npx @mokalabs/sandbox).",
  };
}
