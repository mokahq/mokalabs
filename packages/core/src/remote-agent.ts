import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { AgentConfig, McpServerConfig, Workspace } from "./config.js";
import { resolveRecord, resolveSecret } from "./config.js";
import type { ChatChunk, ToolAuthorization, Usage } from "./agent.js";
import { describeError, expandServerUi, mcpContentToText, toolKey } from "./agent.js";
import {
  buildRenderUiDescription,
  buildRenderUiSchema,
  renderUi,
  resolveGenerativeUi,
  workspaceRegistry,
  type LoadedCatalog,
} from "./catalog.js";
import type { EventBus } from "./events.js";
import { errorMessage, type McpManager } from "./mcp.js";
import { parseA2ui, toolVisibleToModel, type A2uiMessage, type UiDescriptor } from "./ui.js";

/**
 * Remote agents: instead of calling a model directly, Moka can front an
 * existing agent and still give you the chat UI, generative UI and the
 * inspector.
 *
 * - **A2A** (Agent2Agent): JSON-RPC `message/stream` (SSE) or `message/send`.
 *   The agent keeps the conversation; Moka sends the latest turn with the
 *   `contextId`/`taskId` it got back. A2UI arrives as DataParts.
 * - **AG-UI**: POST `RunAgentInput`, read the SSE event stream. Stateless: the
 *   full history is sent each turn. With `shareTools`, the workspace's MCP
 *   tools and render tool are offered as frontend tools; Moka runs the calls
 *   and continues the run with the results.
 */

export const A2UI_EXTENSION_PREFIX = "https://a2ui.org/a2a-extension/";
const AGENT_META = "moka";

interface AgentMeta {
  contextId?: string;
  taskId?: string;
  taskState?: string;
  threadId?: string;
  state?: unknown;
}

export interface RunRemoteAgentOptions {
  runId: string;
  agent: AgentConfig;
  workspace: Workspace;
  messages: ModelMessage[];
  servers: McpServerConfig[];
  catalogs: LoadedCatalog[];
  mcp: McpManager;
  bus: EventBus;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  authorizeTool?: (request: ToolAuthorization) => Promise<boolean>;
}

/* ------------------------------------------------------------------ SSE */

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

/** Parse a text/event-stream body. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: SseEvent = { data: "" };
  let hasData = false;
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer[index] === "\r" ? 2 : 1));
        if (line === "") {
          if (hasData) yield event;
          event = { data: "" };
          hasData = false;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") {
          event.data = hasData ? `${event.data}\n${value}` : value;
          hasData = true;
        } else if (field === "event") event.event = value;
        else if (field === "id") event.id = value;
      }
    }
    if (hasData) yield event;
  } finally {
    reader.releaseLock();
  }
}

/* ------------------------------------------------------------------ helpers */

function previousMeta(messages: ModelMessage[]): AgentMeta {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any;
    const meta = m?.role === "assistant" ? m.providerOptions?.[AGENT_META] : undefined;
    if (meta) return meta as AgentMeta;
  }
  return {};
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: any) => (p?.type === "text" ? p.text : p?.type === "file" || p?.type === "image" ? `[${p.filename ?? p.mediaType ?? "attachment"}]` : ""))
    .filter(Boolean)
    .join("\n");
}

function lastUser(messages: ModelMessage[]): ModelMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") return messages[i];
  return undefined;
}

/** `[ui action] {...}` user messages (A2UI button presses) → the action object. */
export function parseUiAction(text: string): Record<string, unknown> | undefined {
  const match = /^\[ui action\]\s*(\{[\s\S]*\})\s*$/.exec(text.trim());
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]!);
  } catch {
    return undefined;
  }
}

function headersFor(agent: AgentConfig, env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", ...extra, ...(resolveRecord(agent.headers, env) ?? {}) };
}

class UiCollector {
  private messages: A2uiMessage[] = [];
  readonly id = `ui_${randomUUID().slice(0, 8)}`;
  started = false;

  add(messages: A2uiMessage[]): A2uiMessage[] {
    this.messages.push(...messages);
    return this.messages;
  }
}

/* ------------------------------------------------------------------ A2A */

export interface AgentCard {
  name?: string;
  description?: string;
  url?: string;
  version?: string;
  protocolVersion?: string;
  capabilities?: { streaming?: boolean; extensions?: Array<{ uri: string; description?: string; required?: boolean }> };
  skills?: Array<{ id?: string; name?: string; description?: string; tags?: string[]; examples?: string[] }>;
  [key: string]: unknown;
}

const cardCache = new Map<string, { at: number; card?: AgentCard; endpoint: string }>();

/** Resolve an A2A config URL (agent card or endpoint) to its card and JSON-RPC endpoint. */
export async function resolveA2a(agent: AgentConfig, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<{ card?: AgentCard; endpoint: string }> {
  const url = resolveSecret(agent.url, env)!;
  const cached = cardCache.get(url);
  if (cached && Date.now() - cached.at < 60_000) return cached;
  const isCard = /\.json($|\?)/.test(url);
  const cardUrl = isCard ? url : new URL("/.well-known/agent-card.json", url).toString();
  let card: AgentCard | undefined;
  try {
    const res = await fetch(cardUrl, { headers: headersFor(agent, env, { accept: "application/json" }), signal: signal ?? AbortSignal.timeout(10_000) });
    if (res.ok) card = (await res.json()) as AgentCard;
  } catch {
    // The card is optional when the URL is the endpoint itself.
  }
  if (isCard && !card) throw new Error(`Could not load the agent card at ${url}`);
  const endpoint = isCard ? new URL(card!.url ?? "/", url).toString() : url;
  const entry = { at: Date.now(), card, endpoint };
  cardCache.set(url, entry);
  return entry;
}

function a2aParts(parts: any[]): { text: string; ui: A2uiMessage[]; data: unknown[]; files: string[] } {
  const out = { text: "", ui: [] as A2uiMessage[], data: [] as unknown[], files: [] as string[] };
  for (const part of parts ?? []) {
    const kind = part?.kind ?? part?.type;
    if (kind === "text") out.text += part.text ?? "";
    else if (kind === "data") {
      const mime = String(part.metadata?.mimeType ?? part.mimeType ?? "");
      const ui = parseA2ui(part.data);
      if (ui || mime.includes("a2ui")) out.ui.push(...(ui ?? []));
      else out.data.push(part.data);
    } else if (kind === "file") {
      const file = part.file ?? {};
      out.files.push(file.uri ? `[${file.name ?? "file"}](${file.uri})` : `[${file.name ?? file.mimeType ?? "file"}]`);
    }
  }
  return out;
}

async function* runA2a(options: RunRemoteAgentOptions): AsyncGenerator<ChatChunk> {
  const { agent, bus, runId, signal } = options;
  const env = options.env ?? process.env;
  const { card, endpoint } = await resolveA2a(agent, env, signal);
  const meta = previousMeta(options.messages);
  const user = lastUser(options.messages);
  const text = contentText(user?.content);
  const action = parseUiAction(text);
  const parts: any[] = action
    ? [{ kind: "data", data: { version: "v0.9", action, userAction: action }, metadata: { mimeType: "application/json+a2ui" } }]
    : [{ kind: "text", text }];
  for (const p of Array.isArray(user?.content) ? (user!.content as any[]) : []) {
    if (p?.type === "file" || p?.type === "image") {
      const data = String(p.data ?? p.image ?? "");
      const bytes = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
      parts.push({ kind: "file", file: { name: p.filename ?? "attachment", mimeType: p.mediaType ?? "application/octet-stream", bytes } });
    }
  }
  const continuesTask = meta.taskId && meta.taskState && ["input-required", "auth-required"].includes(meta.taskState);
  const message = {
    kind: "message",
    role: "user",
    messageId: randomUUID(),
    parts,
    ...(meta.contextId ? { contextId: meta.contextId } : {}),
    ...(continuesTask ? { taskId: meta.taskId } : {}),
  };
  const streaming = card?.capabilities?.streaming !== false;
  const extensions = (card?.capabilities?.extensions ?? []).map((e) => e.uri).filter((u) => u.startsWith(A2UI_EXTENSION_PREFIX));
  const body = {
    jsonrpc: "2.0",
    id: randomUUID(),
    method: streaming ? "message/stream" : "message/send",
    params: { message, configuration: { acceptedOutputModes: ["text/plain", "application/json", "application/json+a2ui"], blocking: true } },
  };
  bus.emit({ kind: "agent.request", runId, title: `→ ${agent.name} · A2A ${body.method}`, data: { endpoint, body, extensions } });

  const res = await fetch(endpoint, {
    method: "POST",
    headers: headersFor(agent, env, {
      accept: streaming ? "text/event-stream" : "application/json",
      ...(extensions.length ? { "X-A2A-Extensions": extensions.join(", ") } : {}),
    }),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);

  const next: AgentMeta = { ...meta };
  const ui = new UiCollector();
  const artifacts = new Map<string, string>();
  let answer = "";
  let emittedText = "";

  const handle = function* (result: any): Generator<ChatChunk> {
    if (!result || typeof result !== "object") return;
    if (result.contextId) next.contextId = result.contextId;
    const kind = result.kind;
    let content: ReturnType<typeof a2aParts> | undefined;
    if (kind === "message") {
      content = a2aParts(result.parts);
      if (result.taskId) next.taskId = result.taskId;
    } else if (kind === "task") {
      next.taskId = result.id;
      next.taskState = result.status?.state;
      if (result.status?.message) content = a2aParts(result.status.message.parts);
      for (const artifact of result.artifacts ?? []) {
        const a = a2aParts(artifact.parts);
        if (a.text && !artifacts.has(artifact.artifactId)) {
          artifacts.set(artifact.artifactId, a.text);
          content = { ...(content ?? { text: "", ui: [], data: [], files: [] }), text: `${content?.text ?? ""}${a.text}` };
        }
        if (a.ui.length) content = { ...(content ?? { text: "", ui: [], data: [], files: [] }), ui: [...(content?.ui ?? []), ...a.ui] };
      }
    } else if (kind === "status-update") {
      next.taskId = result.taskId ?? next.taskId;
      next.taskState = result.status?.state;
      if (result.status?.message) content = a2aParts(result.status.message.parts);
      if (result.status?.state === "failed" || result.status?.state === "rejected") {
        throw new Error(content?.text || `Agent task ${result.status.state}`);
      }
    } else if (kind === "artifact-update") {
      next.taskId = result.taskId ?? next.taskId;
      const a = a2aParts(result.artifact?.parts ?? []);
      const id = result.artifact?.artifactId ?? "artifact";
      const previous = artifacts.get(id) ?? "";
      artifacts.set(id, result.append ? previous + a.text : a.text);
      content = { ...a, text: result.append ? a.text : a.text };
      if (!result.append && previous && a.text.startsWith(previous)) content.text = a.text.slice(previous.length);
    }
    if (!content) return;
    const piece = [content.text, ...content.files].filter(Boolean).join("\n");
    if (piece) {
      const sep = emittedText && kind !== "artifact-update" && !emittedText.endsWith("\n") ? "\n\n" : "";
      emittedText += sep + piece;
      answer += sep + piece;
      yield { type: "text", text: sep + piece };
    }
    if (content.ui.length) {
      if (!ui.started) {
        ui.started = true;
        yield { type: "tool-call", id: ui.id, name: "a2ui", tool: "A2UI", source: agent.name, input: {} };
      }
      yield { type: "tool-result", id: ui.id, output: "UI shown to the user", isError: false, ui: { kind: "a2ui", messages: [...ui.add(content.ui)] } };
    }
    for (const data of content.data) {
      const id = `data_${randomUUID().slice(0, 8)}`;
      yield { type: "tool-call", id, name: "data", tool: "data", source: agent.name, input: {} };
      yield { type: "tool-result", id, output: data, isError: false };
    }
  };

  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream") && res.body) {
    for await (const event of readSse(res.body, signal)) {
      let payload: any;
      try {
        payload = JSON.parse(event.data);
      } catch {
        continue;
      }
      const r = payload?.result;
      // Streamed text chunks would flood the inspector; log the last one of each artifact.
      if (!(r?.kind === "artifact-update" && r.append && !r.lastChunk)) {
        bus.emit({ kind: "agent.event", runId, title: `A2A ${r?.kind ?? (payload?.error ? "error" : "event")}${r?.status?.state ? ` · ${r.status.state}` : r?.artifact?.name ? ` · ${r.artifact.name}` : ""}`, data: payload });
      }
      if (payload?.error) throw new Error(payload.error.message ?? JSON.stringify(payload.error));
      yield* handle(payload?.result);
    }
  } else {
    const payload: any = await res.json();
    bus.emit({ kind: "agent.event", runId, title: `A2A ${payload?.result?.kind ?? "response"}`, data: payload });
    if (payload?.error) throw new Error(payload.error.message ?? JSON.stringify(payload.error));
    yield* handle(payload?.result);
  }

  const assistant: ModelMessage = {
    role: "assistant",
    content: [{ type: "text", text: answer || (ui.started ? "[interactive UI shown to the user]" : "") }],
    providerOptions: { [AGENT_META]: next as any },
  };
  yield { type: "finish", usage: {}, durationMs: 0, messages: [assistant] };
}

/* ------------------------------------------------------------------ AG-UI */

interface FrontendTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: any, toolCallId: string) => Promise<{ text: string; ui?: UiDescriptor; isError?: boolean }>;
  source: string;
  tool: string;
}

/** The workspace's MCP tools + render tool, offered to an AG-UI agent as frontend tools. */
async function frontendTools(options: RunRemoteAgentOptions): Promise<FrontendTool[]> {
  const tools: FrontendTool[] = [];
  const states = await Promise.all(options.servers.map((s) => options.mcp.ensure(s)));
  states.forEach((state, index) => {
    const server = options.servers[index]!;
    if (state.status !== "connected") return;
    const hidden = new Set(server.disabledTools ?? []);
    for (const tool of state.tools) {
      if (hidden.has(tool.name) || !toolVisibleToModel(tool)) continue;
      tools.push({
        name: toolKey(server.id, tool.name),
        description: tool.description ?? tool.name,
        parameters: { type: "object", properties: {}, ...(tool.inputSchema ?? {}) },
        source: server.name,
        tool: tool.name,
        run: async (args, toolCallId) => {
          if (options.authorizeTool) {
            const ok = await options.authorizeTool({ runId: options.runId, toolCallId, server, tool, input: args, signal: options.signal });
            if (!ok) return { text: "The user declined to run this tool.", isError: true };
          }
          const result = await options.mcp.callTool(server.id, tool.name, args ?? {}, { signal: options.signal });
          const { detectResultUi, toolUiResourceUri } = await import("./ui.js");
          const appUri = toolUiResourceUri(tool);
          let ui: UiDescriptor | undefined = appUri ? { kind: "mcp-app", serverId: server.id, resourceUri: appUri } : detectResultUi(server.id, result);
          if (ui?.kind === "a2ui") ui = { kind: "a2ui", messages: await expandServerUi(ui.messages, server.id, options) };
          return { text: mcpContentToText(result), ui, isError: Boolean(result.isError) };
        },
      });
    }
  });
  const genUi = resolveGenerativeUi(options.workspace);
  if (genUi.enabled) {
    const registry = workspaceRegistry(genUi, options.catalogs);
    tools.push({
      name: genUi.toolName,
      description: buildRenderUiDescription(genUi, registry),
      parameters: buildRenderUiSchema(registry),
      source: "generative UI",
      tool: genUi.toolName,
      run: async (args, toolCallId) => {
        const { messages, problems } = renderUi(args, { fallbackId: `surface-${toolCallId.slice(-8)}`, registry, theme: genUi.theme });
        if (problems.length) return { text: `Invalid UI, nothing was shown. Fix these problems and call ${genUi.toolName} again:\n- ${problems.join("\n- ")}`, isError: true };
        return { text: "UI rendered. The user can now see and interact with it.", ui: { kind: "a2ui", messages } };
      },
    });
  }
  return tools;
}

/** AI SDK history → AG-UI messages. */
export function toAguiMessages(messages: ModelMessage[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "system") out.push({ id: randomUUID(), role: "system", content: String(m.content) });
    else if (m.role === "user") out.push({ id: randomUUID(), role: "user", content: contentText(m.content) });
    else if (m.role === "assistant") {
      const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as any[]);
      const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("");
      const toolCalls = parts
        .filter((p) => p.type === "tool-call")
        .map((p) => ({ id: p.toolCallId, type: "function", function: { name: p.toolName, arguments: JSON.stringify(p.input ?? {}) } }));
      out.push({ id: randomUUID(), role: "assistant", ...(text ? { content: text } : {}), ...(toolCalls.length ? { toolCalls } : {}) });
    } else if (m.role === "tool") {
      for (const p of m.content as any[]) {
        if (p.type !== "tool-result") continue;
        const value = p.output?.type === "text" || p.output?.type === "error-text" ? p.output.value : JSON.stringify(p.output?.value ?? p.output);
        out.push({ id: randomUUID(), role: "tool", toolCallId: p.toolCallId, content: String(value ?? "") });
      }
    }
  }
  return out;
}

async function* runAgui(options: RunRemoteAgentOptions): AsyncGenerator<ChatChunk> {
  const { agent, bus, runId, signal } = options;
  const env = options.env ?? process.env;
  const meta = previousMeta(options.messages);
  const threadId = meta.threadId ?? randomUUID();
  let state: unknown = meta.state ?? {};
  const shared = agent.shareTools ? await frontendTools(options) : [];
  const byName = new Map(shared.map((t) => [t.name, t]));
  const produced: ModelMessage[] = [];
  const maxRounds = options.workspace.maxSteps ?? 12;
  let answer = "";
  const ui = new UiCollector();

  for (let round = 0; round < maxRounds; round++) {
    const input = {
      threadId,
      runId: `${runId}-${round}`,
      state,
      messages: toAguiMessages([...options.messages, ...produced]),
      tools: shared.map(({ name, description, parameters }) => ({ name, description, parameters })),
      context: [],
      forwardedProps: {},
    };
    bus.emit({ kind: "agent.request", runId, title: `→ ${agent.name} · AG-UI run${round ? ` (round ${round + 1})` : ""}`, data: { url: agent.url, body: input } });
    const res = await fetch(resolveSecret(agent.url, env)!, {
      method: "POST",
      headers: headersFor(agent, env, { accept: "text/event-stream" }),
      body: JSON.stringify(input),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);

    let text = "";
    const calls = new Map<string, { name: string; args: string; done: boolean; result?: string }>();
    const order: string[] = [];

    for await (const event of readSse(res.body, signal)) {
      let e: any;
      try {
        e = JSON.parse(event.data);
      } catch {
        continue;
      }
      const type = String(e.type ?? event.event ?? "");
      const quiet = type === "TEXT_MESSAGE_CONTENT" || type === "TOOL_CALL_ARGS" || type.endsWith("_CHUNK") || type.includes("THINKING") || type.includes("REASONING");
      if (!quiet) bus.emit({ kind: "agent.event", runId, title: `AG-UI ${type}${e.toolCallName ? ` · ${e.toolCallName}` : e.stepName ? ` · ${e.stepName}` : ""}`, data: e });
      switch (type) {
        case "TEXT_MESSAGE_CONTENT":
        case "TEXT_MESSAGE_CHUNK":
          if (typeof e.delta === "string" && e.delta) {
            text += e.delta;
            yield { type: "text", text: e.delta };
          }
          break;
        case "THINKING_TEXT_MESSAGE_CONTENT":
        case "REASONING_MESSAGE_CONTENT":
        case "REASONING_MESSAGE_CHUNK":
          if (typeof e.delta === "string") yield { type: "reasoning", text: e.delta };
          break;
        case "TOOL_CALL_START":
          calls.set(e.toolCallId, { name: e.toolCallName, args: "", done: false });
          order.push(e.toolCallId);
          break;
        case "TOOL_CALL_CHUNK": {
          if (!calls.has(e.toolCallId)) {
            calls.set(e.toolCallId, { name: e.toolCallName ?? "tool", args: "", done: false });
            order.push(e.toolCallId);
          }
          if (typeof e.delta === "string") calls.get(e.toolCallId)!.args += e.delta;
          break;
        }
        case "TOOL_CALL_ARGS":
          if (calls.has(e.toolCallId) && typeof e.delta === "string") calls.get(e.toolCallId)!.args += e.delta;
          break;
        case "TOOL_CALL_END": {
          const call = calls.get(e.toolCallId);
          if (!call) break;
          call.done = true;
          const known = byName.get(call.name);
          yield { type: "tool-call", id: e.toolCallId, name: call.name, tool: known?.tool ?? call.name, source: known?.source ?? agent.name, input: safeJson(call.args) };
          break;
        }
        case "TOOL_CALL_RESULT": {
          const call = calls.get(e.toolCallId);
          if (call) call.result = typeof e.content === "string" ? e.content : JSON.stringify(e.content);
          const a2ui = parseA2ui(e.content);
          yield { type: "tool-result", id: e.toolCallId, output: e.content, isError: false, ...(a2ui ? { ui: { kind: "a2ui" as const, messages: a2ui } } : {}) };
          break;
        }
        case "STATE_SNAPSHOT":
          state = e.snapshot;
          break;
        case "STATE_DELTA":
          state = applyJsonPatch(state, e.delta);
          break;
        case "CUSTOM":
        case "ACTIVITY_SNAPSHOT":
        case "RAW": {
          const a2ui = parseA2ui(e.value ?? e.content ?? e.event);
          if (a2ui) {
            if (!ui.started) {
              ui.started = true;
              yield { type: "tool-call", id: ui.id, name: "a2ui", tool: "A2UI", source: agent.name, input: {} };
            }
            yield { type: "tool-result", id: ui.id, output: "UI shown to the user", isError: false, ui: { kind: "a2ui", messages: [...ui.add(a2ui)] } };
          }
          break;
        }
        case "RUN_ERROR":
          throw new Error(e.message ?? "The agent reported an error");
        default:
          break;
      }
    }

    answer += text;
    // Frontend tool calls the agent expects us to run.
    const pending = order.map((id) => ({ id, ...calls.get(id)! })).filter((c) => c.result === undefined && byName.has(c.name));
    const assistantParts: any[] = [];
    if (text) assistantParts.push({ type: "text", text });
    for (const id of order) {
      const c = calls.get(id)!;
      assistantParts.push({ type: "tool-call", toolCallId: id, toolName: c.name, input: safeJson(c.args) });
    }
    if (assistantParts.length) produced.push({ role: "assistant", content: assistantParts });
    const results: any[] = order
      .map((id) => ({ id, c: calls.get(id)! }))
      .filter(({ c }) => c.result !== undefined)
      .map(({ id, c }) => ({ type: "tool-result", toolCallId: id, toolName: c.name, output: { type: "text", value: c.result } }));
    if (pending.length === 0) {
      if (results.length) produced.push({ role: "tool", content: results });
      break;
    }
    for (const call of pending) {
      const tool = byName.get(call.name)!;
      const started = Date.now();
      bus.emit({ kind: "tool.call", runId, title: `${tool.source} › ${tool.tool}`, data: { id: call.id, input: safeJson(call.args) } });
      try {
        const out = await tool.run(safeJson(call.args), call.id);
        bus.emit({ kind: out.isError ? "tool.error" : "tool.result", runId, title: `${tool.tool} ${out.isError ? "✗" : "✓"}`, durationMs: Date.now() - started, data: { id: call.id, output: out.text } });
        results.push({ type: "tool-result", toolCallId: call.id, toolName: call.name, output: { type: "text", value: out.text } });
        yield { type: "tool-result", id: call.id, output: out.text, isError: Boolean(out.isError), durationMs: Date.now() - started, ui: out.ui };
      } catch (error) {
        const message = errorMessage(error);
        results.push({ type: "tool-result", toolCallId: call.id, toolName: call.name, output: { type: "error-text", value: message } });
        yield { type: "tool-result", id: call.id, output: message, isError: true, durationMs: Date.now() - started };
      }
    }
    produced.push({ role: "tool", content: results });
    yield { type: "step", usage: {}, finishReason: "tool-calls" };
  }

  // Carry the thread id and agent state into the next turn.
  const last = [...produced].reverse().find((m) => m.role === "assistant");
  if (last) (last as any).providerOptions = { [AGENT_META]: { threadId, state } };
  else produced.push({ role: "assistant", content: [{ type: "text", text: answer }], providerOptions: { [AGENT_META]: { threadId, state } as any } });
  yield { type: "finish", usage: {}, durationMs: 0, messages: produced };
}

function safeJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Minimal RFC 6902 (add / replace / remove) for AG-UI STATE_DELTA. */
export function applyJsonPatch(doc: unknown, ops: unknown): unknown {
  if (!Array.isArray(ops)) return doc;
  let root: any = structuredClone(doc ?? {});
  for (const op of ops as any[]) {
    const tokens = String(op.path ?? "").split("/").slice(1).map((t: string) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (tokens.length === 0) {
      if (op.op === "add" || op.op === "replace") root = structuredClone(op.value);
      continue;
    }
    let parent = root;
    for (const t of tokens.slice(0, -1)) {
      if (parent[t] == null || typeof parent[t] !== "object") parent[t] = {};
      parent = parent[t];
    }
    const key = tokens.at(-1)!;
    if (op.op === "remove") {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else if (op.op === "add" || op.op === "replace") {
      if (Array.isArray(parent) && op.op === "add") {
        if (key === "-") parent.push(op.value);
        else parent.splice(Number(key), 0, op.value);
      } else parent[key] = op.value;
    }
  }
  return root;
}

/* ------------------------------------------------------------------ entry */

export async function* runRemoteAgent(options: RunRemoteAgentOptions): AsyncGenerator<ChatChunk> {
  const { agent, bus, runId, signal } = options;
  const started = Date.now();
  yield { type: "start", runId, model: agent.name, profileId: `agent:${agent.id}`, tools: 0 };
  bus.emit({ kind: "run.start", runId, title: `Run started · ${agent.name}`, data: { agent: agent.id, protocol: agent.protocol, url: agent.url } });
  try {
    const inner = agent.protocol === "a2a" ? runA2a(options) : runAgui(options);
    for await (const chunk of inner) {
      if (chunk.type === "finish") {
        const durationMs = Date.now() - started;
        bus.emit({ kind: "agent.response", runId, title: `← ${agent.name} · done`, durationMs });
        bus.emit({ kind: "run.finish", runId, title: "Run finished", durationMs });
        yield { ...chunk, durationMs, usage: chunk.usage as Usage };
      } else yield chunk;
    }
  } catch (error) {
    const message = signal?.aborted ? "Stopped" : describeError(error);
    bus.emit({ kind: "run.error", runId, level: "error", title: message, durationMs: Date.now() - started });
    yield { type: "error", message };
  }
}

/** Check that an agent is reachable (A2A: its card; AG-UI: a tiny run). */
export async function testRemoteAgent(agent: AgentConfig, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; latencyMs: number; card?: AgentCard; text?: string; events?: string[]; error?: string }> {
  const started = Date.now();
  try {
    if (agent.protocol === "a2a") {
      cardCache.delete(resolveSecret(agent.url, env)!);
      const { card, endpoint } = await resolveA2a(agent, env, AbortSignal.timeout(10_000));
      return { ok: true, latencyMs: Date.now() - started, card: card ?? { url: endpoint } };
    }
    const res = await fetch(resolveSecret(agent.url, env)!, {
      method: "POST",
      headers: headersFor(agent, env, { accept: "text/event-stream" }),
      body: JSON.stringify({ threadId: randomUUID(), runId: randomUUID(), state: {}, messages: [{ id: randomUUID(), role: "user", content: "Hello! Reply with one short sentence." }], tools: [], context: [], forwardedProps: {} }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
    const events: string[] = [];
    let text = "";
    for await (const event of readSse(res.body)) {
      try {
        const e = JSON.parse(event.data);
        events.push(e.type);
        if (e.type === "TEXT_MESSAGE_CONTENT" || e.type === "TEXT_MESSAGE_CHUNK") text += e.delta ?? "";
        if (e.type === "RUN_ERROR") throw new Error(e.message);
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
    return { ok: events.includes("RUN_FINISHED") || events.length > 0, latencyMs: Date.now() - started, text, events: [...new Set(events)] };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: errorMessage(error) };
  }
}
