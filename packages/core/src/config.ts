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

export const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  llmId: z.string().optional(),
  mcpServerIds: z.array(z.string()).default([]),
  skillIds: z.array(z.string()).default([]),
  systemPrompt: z.string().optional(),
  starterPrompts: z.array(z.string()).optional(),
  maxSteps: z.number().int().min(1).max(100).optional(),
  /** Give the model the built-in `render_ui` (A2UI) tool. Default true. */
  generativeUi: z.boolean().optional(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const mokaConfigSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1).default(1),
  activeWorkspaceId: z.string().optional(),
  llms: z.array(llmProfileSchema).default([]),
  mcpServers: z.array(mcpServerSchema).default([]),
  skills: z.array(skillSchema).default([]),
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
    })),
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
