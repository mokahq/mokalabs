import { readFileSync } from "node:fs";
import { ProtocolError, Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { stableJson } from "@mokalabs/core";

/** One recorded request and how the server answered it. */
export interface RecordedCall {
  method: string;
  params: any;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
  t: number;
}

/** What a recording knows about the server, plus every answered request. */
export interface Recording {
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
  instructions?: string;
  tools: any[];
  prompts: any[];
  resources: any[];
  resourceTemplates: any[];
  calls: RecordedCall[];
}

/**
 * Reads a session log (the proxy's, or a Moka recording; JSON Lines with
 * `{type:"msg", dir, msg}` records) and pairs each request with its reply.
 * Request ids are paired in order, so several sessions in one file work too.
 */
export function parseRecording(text: string): Recording {
  const pending = new Map<string, { method: string; params: any; t: number }>();
  const calls: RecordedCall[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "msg") continue;
    const msgs = Array.isArray(record.msg) ? record.msg : [record.msg];
    for (const msg of msgs) {
      if (!msg || msg.id === undefined || msg.id === null) continue;
      const key = String(msg.id);
      if (record.dir === "out" && typeof msg.method === "string") pending.set(key, { method: msg.method, params: msg.params ?? {}, t: record.t ?? 0 });
      else if (record.dir === "in" && ("result" in msg || "error" in msg)) {
        const request = pending.get(key);
        if (!request) continue;
        pending.delete(key);
        calls.push({ ...request, ...(msg.error ? { error: msg.error } : { result: msg.result }) });
      }
    }
  }
  const last = (method: string) => [...calls].reverse().find((c) => c.method === method && c.result);
  const opening = last("initialize")?.result ?? last("server/discover")?.result ?? {};
  const merge = (method: string, key: string, id: (x: any) => string) => {
    const out = new Map<string, any>();
    for (const c of calls) if (c.method === method && Array.isArray(c.result?.[key])) for (const x of c.result[key]) out.set(id(x), x);
    return [...out.values()];
  };
  const tools = merge("tools/list", "tools", (t) => t.name);
  const prompts = merge("prompts/list", "prompts", (p) => p.name);
  const resources = merge("resources/list", "resources", (r) => r.uri);
  const resourceTemplates = merge("resources/templates/list", "resourceTemplates", (r) => r.uriTemplate);
  const capabilities: Record<string, unknown> = {};
  if (tools.length || calls.some((c) => c.method === "tools/call")) capabilities.tools = {};
  if (prompts.length) capabilities.prompts = {};
  if (resources.length || resourceTemplates.length) capabilities.resources = {};
  return {
    serverInfo: { name: opening.serverInfo?.name ?? "recording", version: opening.serverInfo?.version ?? "0.0.0" },
    capabilities,
    ...(opening.instructions ? { instructions: opening.instructions } : {}),
    tools,
    prompts,
    resources,
    resourceTemplates,
    calls,
  };
}

export type MockMatch = { call: RecordedCall; match: "exact" | "partial" | "last" };

/**
 * The recorded answer for a request: same arguments, else the recorded call
 * that shares the most argument values, else (with `fallback: "last"`) the
 * last answer for that tool or prompt. Undefined: no recording fits.
 */
export function findRecorded(recording: Recording, method: string, key: { name?: string; uri?: string; arguments?: Record<string, unknown> }, fallback: "error" | "last" = "error"): MockMatch | undefined {
  const same = recording.calls.filter((c) => c.method === method && (key.uri !== undefined ? c.params?.uri === key.uri : c.params?.name === key.name));
  if (!same.length) return undefined;
  const args = key.arguments ?? {};
  const wanted = stableJson(args);
  const exact = [...same].reverse().find((c) => stableJson(c.params?.arguments ?? {}) === wanted);
  if (exact) return { call: exact, match: "exact" };
  let best: { call: RecordedCall; score: number } | undefined;
  for (const c of same) {
    const recorded = c.params?.arguments ?? {};
    const score = Object.entries(args).filter(([k, v]) => k in recorded && stableJson(recorded[k]) === stableJson(v)).length;
    if (score > 0 && (!best || score >= best.score)) best = { call: c, score };
  }
  if (best) return { call: best.call, match: "partial" };
  return fallback === "last" ? { call: same[same.length - 1]!, match: "last" } : undefined;
}

const REPLAY_META = "dev.moka/replayed";

function answer(found: MockMatch | undefined, what: string): any {
  if (!found) throw new ProtocolError(-32602, `No recording for this call (${what}). Record it once against the real server, or start the mock with --fallback last.`);
  if (found.call.error) throw new ProtocolError(found.call.error.code, found.call.error.message, found.call.error.data);
  return { ...found.call.result, _meta: { ...found.call.result?._meta, [REPLAY_META]: { match: found.match, recordedAt: found.call.t } } };
}

/** A server that answers from a recording; serves both MCP revisions. */
export function createMockServer(recording: Recording, options: { fallback?: "error" | "last" } = {}): Server {
  const fallback = options.fallback ?? "error";
  const server = new Server(recording.serverInfo, { capabilities: recording.capabilities, ...(recording.instructions ? { instructions: recording.instructions } : {}) });
  if (recording.capabilities.tools) {
    server.setRequestHandler("tools/list", async () => ({ tools: recording.tools }));
    server.setRequestHandler("tools/call", async (request: any) => answer(findRecorded(recording, "tools/call", request.params, fallback), `tool ${request.params.name}`));
  }
  if (recording.capabilities.prompts) {
    server.setRequestHandler("prompts/list", async () => ({ prompts: recording.prompts }));
    server.setRequestHandler("prompts/get", async (request: any) => answer(findRecorded(recording, "prompts/get", request.params, fallback), `prompt ${request.params.name}`));
  }
  if (recording.capabilities.resources) {
    server.setRequestHandler("resources/list", async () => ({ resources: recording.resources }));
    server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: recording.resourceTemplates }));
    server.setRequestHandler("resources/read", async (request: any) => answer(findRecorded(recording, "resources/read", { uri: request.params.uri }, fallback), `resource ${request.params.uri}`));
  }
  return server;
}

/** `moka mock <file>`: serve a recording on stdio. */
export async function runMockServer(file: string, options: { fallback?: "error" | "last" } = {}): Promise<void> {
  const recording = parseRecording(readFileSync(file, "utf8"));
  if (!recording.tools.length && !recording.calls.length) throw new Error(`${file} has no recorded MCP traffic.`);
  serveStdio(() => createMockServer(recording, options));
}
