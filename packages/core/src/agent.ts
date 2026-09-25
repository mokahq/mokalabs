import { dynamicTool, jsonSchema, stepCountIs, streamText, type ModelMessage, type ToolSet } from "ai";
import type { LlmProfile, McpServerConfig, Workspace } from "./config.js";
import type { EventBus } from "./events.js";
import { errorMessage, type McpManager, type McpTool } from "./mcp.js";
import { createModel } from "./providers.js";
import { readSkillFile, skillsSystemPrompt, type LoadedSkill } from "./skills.js";
import {
  detectResultUi,
  RENDER_UI_DESCRIPTION,
  RENDER_UI_SCHEMA,
  renderUiToMessages,
  toolUiResourceUri,
  toolVisibleToModel,
  validateComponents,
  type UiDescriptor,
} from "./ui.js";

/** Chunks streamed to UIs while a run is in progress. */
export type ChatChunk =
  | { type: "start"; runId: string; model: string; profileId: string; tools: number }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; tool: string; source: string; input: unknown }
  | { type: "tool-result"; id: string; output: unknown; isError: boolean; durationMs?: number; ui?: UiDescriptor; raw?: RawToolResult }
  | { type: "step"; usage: Usage; finishReason: string }
  | { type: "finish"; usage: Usage; durationMs: number; messages: ModelMessage[] }
  | { type: "error"; message: string };

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface RunAgentOptions {
  runId: string;
  llm: LlmProfile;
  workspace: Workspace;
  servers: McpServerConfig[];
  skills: LoadedSkill[];
  messages: ModelMessage[];
  mcp: McpManager;
  bus: EventBus;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

interface ToolBinding {
  source: string;
  tool: string;
  serverId?: string;
}

/** The untouched MCP result, forwarded to MCP Apps as `ui/notifications/tool-result`. */
export interface RawToolResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface ToolSideChannel {
  ui?: UiDescriptor;
  raw?: RawToolResult;
}

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$ for most providers. */
export function toolKey(prefix: string, name: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  const key = `${clean(prefix)}__${clean(name)}`;
  return key.length <= 64 ? key : key.slice(0, 64);
}

/** Flatten MCP content blocks into something a model can read. */
export function mcpContentToText(result: { content?: unknown[]; structuredContent?: unknown }): string {
  const parts = (result.content ?? []).map((block: any) => {
    switch (block?.type) {
      case "text":
        return block.text;
      case "image":
        return `[image ${block.mimeType ?? ""}]`;
      case "audio":
        return `[audio ${block.mimeType ?? ""}]`;
      case "resource":
        if (String(block.resource?.uri ?? "").startsWith("ui://")) return `[interactive UI shown to the user: ${block.resource.uri}]`;
        if (String(block.resource?.mimeType ?? "").startsWith("application/json+a2ui")) return "[interactive UI shown to the user]";
        return block.resource?.text ?? `[resource ${block.resource?.uri ?? ""}]`;
      case "resource_link":
        return `[resource ${block.uri}]`;
      default:
        return JSON.stringify(block);
    }
  });
  if (parts.length === 0 && result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return parts.join("\n");
}

function normaliseSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const s = { ...(schema ?? {}) };
  if (s.type !== "object") s.type = "object";
  if (!s.properties) s.properties = {};
  return s;
}

export async function* runAgent(options: RunAgentOptions): AsyncGenerator<ChatChunk> {
  const { runId, llm, workspace, bus, mcp, signal } = options;
  const started = Date.now();
  const bindings = new Map<string, ToolBinding>();
  const sideChannel = new Map<string, ToolSideChannel>();
  const tools: ToolSet = {};
  const instructions: string[] = [];

  // 1. Connect MCP servers in parallel and expose their tools.
  const states = await Promise.all(options.servers.map((server) => mcp.ensure(server)));
  states.forEach((state, index) => {
    const server = options.servers[index]!;
    if (state.status !== "connected") {
      bus.emit({ kind: "log", level: "warn", runId, title: `Skipping ${server.name}: ${state.error ?? state.status}` });
      return;
    }
    if (state.instructions) instructions.push(`### ${server.name}\n${state.instructions}`);
    const hidden = new Set(server.disabledTools ?? []);
    for (const mcpTool of state.tools) {
      if (hidden.has(mcpTool.name) || !toolVisibleToModel(mcpTool)) continue;
      const key = toolKey(server.id, mcpTool.name);
      bindings.set(key, { source: server.name, tool: mcpTool.name, serverId: server.id });
      tools[key] = mcpToolToAiTool(mcpTool, server, options, sideChannel);
    }
  });

  // 2. Skills get two built-in tools (progressive disclosure).
  const skills = options.skills.filter((s) => !s.error);
  if (skills.length > 0) {
    const byName = new Map(skills.map((s) => [s.name.toLowerCase(), s]));
    const find = (name: string) => {
      const skill = byName.get(String(name).toLowerCase()) ?? skills.find((s) => s.id === name);
      if (!skill) throw new Error(`Unknown skill "${name}". Available: ${skills.map((s) => s.name).join(", ")}`);
      return skill;
    };
    bindings.set("load_skill", { source: "skills", tool: "load_skill" });
    tools.load_skill = dynamicTool({
      description: "Load the full instructions of a skill by name. Call this before using a skill.",
      inputSchema: jsonSchema({
        type: "object",
        properties: { name: { type: "string", description: "Skill name" } },
        required: ["name"],
      }),
      execute: async (input: any) => {
        const skill = find(input.name);
        bus.emit({ kind: "skill.load", runId, title: `Loaded skill ${skill.name}`, data: { id: skill.id } });
        const files = skill.files.length ? `\n\n---\nFiles in this skill (read with read_skill_file):\n${skill.files.map((f) => `- ${f}`).join("\n")}` : "";
        return `# Skill: ${skill.name}\n\n${skill.body}${files}`;
      },
    });
    if (skills.some((s) => s.files.length > 0)) {
      bindings.set("read_skill_file", { source: "skills", tool: "read_skill_file" });
      tools.read_skill_file = dynamicTool({
        description: "Read a file that belongs to a skill (scripts, references, templates).",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            skill: { type: "string", description: "Skill name" },
            path: { type: "string", description: "File path relative to the skill folder" },
          },
          required: ["skill", "path"],
        }),
        execute: async (input: any) => readSkillFile(find(input.skill), input.path),
      });
    }
  }

  // 3. Generative UI: any model can render native UI through A2UI.
  if (workspace.generativeUi !== false) {
    bindings.set("render_ui", { source: "generative UI", tool: "render_ui" });
    tools.render_ui = dynamicTool({
      description: RENDER_UI_DESCRIPTION,
      inputSchema: jsonSchema(RENDER_UI_SCHEMA as any),
      execute: async (input: any, { toolCallId }) => {
        const problems = input?.messages ? [] : validateComponents(input?.components);
        if (problems.length) throw new Error(`Invalid UI: ${problems.join("; ")}`);
        const messages = renderUiToMessages(input, `surface-${toolCallId.slice(-8)}`);
        sideChannel.set(toolCallId, { ui: { kind: "a2ui", messages } });
        const surfaceId = messages.find((m) => m.createSurface)?.createSurface?.surfaceId;
        return `UI rendered${surfaceId ? ` (surface "${surfaceId}")` : ""}. The user can now see and interact with it; do not repeat its contents in text.`;
      },
    });
  }

  const system = [
    workspace.systemPrompt?.trim(),
    skillsSystemPrompt(skills),
    instructions.length ? `## MCP server instructions\n\n${instructions.join("\n\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  yield { type: "start", runId, model: llm.model, profileId: llm.id, tools: Object.keys(tools).length };
  bus.emit({
    kind: "run.start",
    runId,
    title: `Run started · ${llm.name} (${llm.model})`,
    data: { profile: llm.id, model: llm.model, tools: Object.keys(tools), system },
  });

  const toolStarts = new Map<string, number>();
  let stepStarted = Date.now();
  let stepIndex = 0;

  try {
    const result = streamText({
      model: createModel(llm, options.env),
      system: system || undefined,
      messages: options.messages,
      tools: Object.keys(tools).length ? tools : undefined,
      stopWhen: stepCountIs(workspace.maxSteps ?? 12),
      temperature: llm.temperature,
      maxOutputTokens: llm.maxOutputTokens,
      providerOptions: llm.providerOptions,
      abortSignal: signal,
      maxRetries: 1,
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          yield { type: "text", text: part.text };
          break;
        case "reasoning-delta":
          yield { type: "reasoning", text: part.text };
          break;
        case "start-step":
          stepStarted = Date.now();
          stepIndex++;
          bus.emit({
            kind: "llm.request",
            runId,
            title: `→ ${llm.model} · step ${stepIndex}`,
            data: { model: llm.model, provider: llm.provider, body: part.request?.body, warnings: part.warnings },
          });
          break;
        case "finish-step": {
          const usage = toUsage(part.usage);
          bus.emit({
            kind: "llm.response",
            runId,
            title: `← ${llm.model} · ${part.finishReason} · ${usage.totalTokens ?? "?"} tok`,
            durationMs: Date.now() - stepStarted,
            data: { finishReason: part.finishReason, usage, response: { id: part.response?.id, modelId: part.response?.modelId } },
          });
          yield { type: "step", usage, finishReason: part.finishReason };
          break;
        }
        case "tool-call": {
          const binding = bindings.get(part.toolName) ?? { source: "unknown", tool: part.toolName };
          toolStarts.set(part.toolCallId, Date.now());
          bus.emit({
            kind: "tool.call",
            runId,
            title: `${binding.source} › ${binding.tool}`,
            data: { id: part.toolCallId, input: part.input },
          });
          yield { type: "tool-call", id: part.toolCallId, name: part.toolName, tool: binding.tool, source: binding.source, input: part.input };
          break;
        }
        case "tool-result": {
          if ((part as any).preliminary) break;
          const durationMs = elapsed(toolStarts, part.toolCallId);
          bus.emit({
            kind: "tool.result",
            runId,
            title: `${bindings.get(part.toolName)?.tool ?? part.toolName} ✓`,
            durationMs,
            data: { id: part.toolCallId, output: part.output },
          });
          const extra = sideChannel.get(part.toolCallId);
          sideChannel.delete(part.toolCallId);
          yield { type: "tool-result", id: part.toolCallId, output: part.output, isError: false, durationMs, ui: extra?.ui, raw: extra?.raw };
          break;
        }
        case "tool-error": {
          const durationMs = elapsed(toolStarts, part.toolCallId);
          const message = errorMessage(part.error);
          bus.emit({
            kind: "tool.error",
            runId,
            level: "error",
            title: `${bindings.get(part.toolName)?.tool ?? part.toolName} ✗ ${message.slice(0, 80)}`,
            durationMs,
            data: { id: part.toolCallId, error: message },
          });
          const extra = sideChannel.get(part.toolCallId);
          sideChannel.delete(part.toolCallId);
          yield { type: "tool-result", id: part.toolCallId, output: message, isError: true, durationMs, ui: extra?.ui, raw: extra?.raw };
          break;
        }
        case "error":
          throw part.error;
        default:
          break;
      }
    }

    const [usage, responseMessages] = await Promise.all([result.totalUsage, result.responseMessages]);
    const durationMs = Date.now() - started;
    bus.emit({ kind: "run.finish", runId, title: `Run finished · ${usage.totalTokens ?? "?"} tokens`, durationMs, data: toUsage(usage) });
    yield { type: "finish", usage: toUsage(usage), durationMs, messages: responseMessages as ModelMessage[] };
  } catch (error) {
    const message = signal?.aborted ? "Stopped" : describeError(error);
    bus.emit({ kind: "run.error", runId, level: "error", title: message, durationMs: Date.now() - started, data: serialiseError(error) });
    yield { type: "error", message };
  }
}

function mcpToolToAiTool(mcpTool: McpTool, server: McpServerConfig, options: RunAgentOptions, sideChannel: Map<string, ToolSideChannel>) {
  const appUri = toolUiResourceUri(mcpTool);
  return dynamicTool({
    description: mcpTool.description ?? mcpTool.title ?? mcpTool.name,
    inputSchema: jsonSchema(normaliseSchema(mcpTool.inputSchema) as any),
    execute: async (input: any, { abortSignal, toolCallId }) => {
      const result = await options.mcp.callTool(server.id, mcpTool.name, input ?? {}, { signal: abortSignal });
      const ui: UiDescriptor | undefined = appUri ? { kind: "mcp-app", serverId: server.id, resourceUri: appUri } : detectResultUi(server.id, result);
      sideChannel.set(toolCallId, { ui, raw: { content: result.content, structuredContent: result.structuredContent, isError: result.isError } });
      const text = mcpContentToText(result);
      if (result.isError) throw new Error(text || "Tool reported an error");
      return text;
    },
  });
}

function elapsed(starts: Map<string, number>, id: string): number | undefined {
  const start = starts.get(id);
  starts.delete(id);
  return start ? Date.now() - start : undefined;
}

function toUsage(usage: any): Usage {
  return {
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) || undefined),
  };
}

export function describeError(error: unknown): string {
  const e = error as any;
  const status = e?.statusCode ? `${e.statusCode} ` : "";
  let detail = errorMessage(error);
  if (e?.responseBody) {
    try {
      const body = JSON.parse(e.responseBody);
      detail = body?.error?.message ?? body?.message ?? detail;
    } catch {
      // keep original
    }
  }
  return `${status}${detail}`.trim();
}

function serialiseError(error: unknown): unknown {
  const e = error as any;
  if (!(error instanceof Error)) return error;
  return { name: e.name, message: e.message, statusCode: e.statusCode, url: e.url, responseBody: e.responseBody };
}
