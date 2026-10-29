import { FORMAT_HINTS, normaliseSchema, toolKey } from "./agent.js";
import { buildRenderUiDescription, buildRenderUiSchema, resolveGenerativeUi, workspaceRegistry, type LoadedCatalog } from "./catalog.js";
import type { McpServerConfig, Workspace } from "./config.js";
import type { McpServerState } from "./mcp.js";
import { applyToolOverride } from "./overrides.js";
import { skillsSystemPrompt, type LoadedSkill } from "./skills.js";
import { toolVisibleToModel } from "./ui.js";

/**
 * What the model reads on every request before the conversation: the system
 * prompt, the skills list, MCP server instructions and every tool definition.
 * Tool definitions add up fast (dozens of tools can take a large share of a
 * context window), so Moka shows where the tokens go and what hiding a tool saves.
 */

export interface BudgetItem {
  kind: "system" | "skills" | "instructions" | "tool";
  /** The tool's name, or what the text is. */
  name: string;
  /** Who adds it: a server's name, "skills", "generative UI" or "workspace". */
  source: string;
  serverId?: string;
  tokens: number;
  /** Hidden from the model (a disabled tool): not counted in the total. */
  hidden?: boolean;
}

export interface ContextBudget {
  /** Estimated tokens sent with every request, before any message. */
  total: number;
  items: BudgetItem[];
  /** Servers that aren't connected, so their tools aren't counted. */
  notConnected: Array<{ id: string; name: string; status: string }>;
}

/**
 * A model-independent estimate: about 4 characters per token for English and
 * JSON with typical tokenizers. Good for comparing tools and seeing trends; a
 * given model's count differs by some percent.
 */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

/** A tool as providers receive it (the OpenAI function format; others are close). */
export function toolTokens(name: string, description: string, schema: unknown): number {
  return estimateTokens(JSON.stringify({ type: "function", function: { name, description, parameters: schema } }));
}

export function contextBudget(options: {
  workspace: Workspace;
  servers: McpServerConfig[];
  states: Array<McpServerState | undefined>;
  skills: LoadedSkill[];
  catalogs: LoadedCatalog[];
}): ContextBudget {
  const { workspace } = options;
  const items: BudgetItem[] = [];
  const notConnected: ContextBudget["notConnected"] = [];

  if (workspace.systemPrompt?.trim()) items.push({ kind: "system", name: "System prompt", source: "workspace", tokens: estimateTokens(workspace.systemPrompt.trim()) });
  if (workspace.formatHints !== false) items.push({ kind: "system", name: "Formatting hints", source: "Moka", tokens: estimateTokens(FORMAT_HINTS) });

  const skills = options.skills.filter((s) => !s.error);
  if (skills.length) items.push({ kind: "skills", name: `Skills list (${skills.length})`, source: "skills", tokens: estimateTokens(skillsSystemPrompt(skills)) });

  options.servers.forEach((server, i) => {
    const state = options.states[i];
    if (!state || state.status !== "connected") {
      notConnected.push({ id: server.id, name: server.name, status: state?.status ?? "idle" });
      return;
    }
    if (state.instructions) items.push({ kind: "instructions", name: "Server instructions", source: server.name, serverId: server.id, tokens: estimateTokens(`### ${server.name}\n${state.instructions}`) });
    const hidden = new Set(server.disabledTools ?? []);
    for (const serverTool of state.tools) {
      if (!toolVisibleToModel(serverTool)) continue;
      const tool = applyToolOverride(serverTool, server.toolOverrides?.[serverTool.name]);
      items.push({
        kind: "tool",
        name: tool.name,
        source: server.name,
        serverId: server.id,
        tokens: toolTokens(toolKey(server.id, tool.name), tool.description ?? tool.title ?? tool.name, normaliseSchema(tool.inputSchema)),
        ...(hidden.has(tool.name) ? { hidden: true } : {}),
      });
    }
  });

  if (skills.length) {
    items.push({ kind: "tool", name: "load_skill", source: "skills", tokens: toolTokens("load_skill", "Load the full instructions of a skill by name. Call this before using a skill.", { type: "object", properties: { name: { type: "string", description: "Skill name" } }, required: ["name"] }) });
  }

  const genUi = resolveGenerativeUi(workspace);
  if (genUi.enabled) {
    const registry = workspaceRegistry(genUi, options.catalogs);
    items.push({ kind: "tool", name: genUi.toolName, source: "generative UI", tokens: toolTokens(genUi.toolName, buildRenderUiDescription(genUi, registry), buildRenderUiSchema(registry)) });
  }

  return { total: items.reduce((sum, i) => sum + (i.hidden ? 0 : i.tokens), 0), items, notConnected };
}
