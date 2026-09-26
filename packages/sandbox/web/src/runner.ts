import { streamChat } from "./api";
import type { Part, UiMessage } from "./types";

export function uid(prefix = "m"): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface RunResult {
  message: UiMessage;
  responseMessages: unknown[];
  ok: boolean;
}

/**
 * Stream one assistant turn, folding chunks into a UiMessage. `onUpdate` is
 * called (throttled to animation frames) with a fresh copy of the message.
 */
export async function runTurn(options: {
  modelMessages: unknown[];
  workspaceId?: string;
  llmId?: string;
  signal: AbortSignal;
  onUpdate: (message: UiMessage) => void;
}): Promise<RunResult> {
  const started = performance.now();
  const message: UiMessage = { id: uid("a"), role: "assistant", parts: [], meta: { steps: 0 } };
  let responseMessages: unknown[] = [];
  let ok = true;
  let frame = 0;
  const flush = () => {
    frame = 0;
    options.onUpdate({ ...message, parts: message.parts.map((p) => ({ ...p })), meta: { ...message.meta } });
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const lastPart = () => message.parts[message.parts.length - 1];

  try {
    for await (const chunk of streamChat(
      {
        messages: options.modelMessages,
        workspaceId: options.workspaceId,
        // Compare lanes can target remote agents as "agent:<id>".
        ...(options.llmId?.startsWith("agent:") ? { agentId: options.llmId.slice(6) } : { llmId: options.llmId }),
      },
      options.signal,
    )) {
      switch (chunk.type) {
        case "start":
          message.meta = { ...message.meta, model: chunk.model, profileId: chunk.profileId, runId: chunk.runId };
          break;
        case "text":
        case "reasoning": {
          if (message.meta!.firstTokenMs === undefined) message.meta!.firstTokenMs = Math.round(performance.now() - started);
          const last = lastPart();
          if (last && last.type === chunk.type) last.text += chunk.text;
          else message.parts.push({ type: chunk.type, text: chunk.text });
          break;
        }
        case "tool-call":
          message.parts.push({
            type: "tool",
            id: chunk.id,
            name: chunk.name,
            tool: chunk.tool,
            source: chunk.source,
            input: chunk.input,
            status: "running",
          });
          break;
        case "tool-result": {
          const part = message.parts.find((p): p is Extract<Part, { type: "tool" }> => p.type === "tool" && p.id === chunk.id);
          if (part) {
            part.output = chunk.output;
            part.isError = chunk.isError;
            part.durationMs = chunk.durationMs;
            part.status = chunk.isError ? "error" : "done";
            part.ui = chunk.ui;
            part.raw = chunk.raw;
          }
          break;
        }
        case "step":
          message.meta!.steps = (message.meta!.steps ?? 0) + 1;
          break;
        case "finish":
          message.meta = { ...message.meta, usage: chunk.usage, durationMs: chunk.durationMs };
          responseMessages = chunk.messages;
          break;
        case "error":
          ok = false;
          message.meta = { ...message.meta, error: chunk.message };
          break;
      }
      schedule();
    }
  } catch (error: any) {
    ok = false;
    const aborted = options.signal.aborted || error?.name === "AbortError";
    message.meta = { ...message.meta, error: aborted ? "Stopped" : error?.message ?? String(error) };
  }
  if (frame) cancelAnimationFrame(frame);
  for (const part of message.parts) {
    if (part.type === "tool" && part.status === "running") part.status = "error";
  }
  if (message.meta!.durationMs === undefined) message.meta!.durationMs = Math.round(performance.now() - started);
  flush();
  return { message, responseMessages, ok };
}
