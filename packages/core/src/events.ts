/**
 * Inspector events. Every interesting thing Moka does (model calls, tool calls,
 * raw MCP JSON-RPC traffic, skill loads) is emitted on an EventBus so UIs can
 * render a live timeline.
 */
export type MokaEventKind =
  | "run.start"
  | "run.finish"
  | "run.error"
  | "llm.request"
  | "llm.response"
  | "tool.call"
  | "tool.result"
  | "tool.error"
  | "mcp.status"
  | "mcp.rpc"
  | "mcp.log"
  | "skill.load"
  | "ui.rpc"
  | "ui.action"
  | "log";

export interface MokaEvent {
  id: string;
  ts: number;
  kind: MokaEventKind;
  title: string;
  runId?: string;
  serverId?: string;
  durationMs?: number;
  /** "out" = sent by Moka, "in" = received. Only set for mcp.rpc. */
  direction?: "in" | "out";
  level?: "info" | "warn" | "error";
  data?: unknown;
}

export type MokaEventInput = Omit<MokaEvent, "id" | "ts"> & { ts?: number };
export type MokaEventListener = (event: MokaEvent) => void;

let counter = 0;
export function eventId(): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

export class EventBus {
  private listeners = new Set<MokaEventListener>();
  private buffer: MokaEvent[] = [];

  constructor(private readonly capacity = 2000) {}

  emit(input: MokaEventInput): MokaEvent {
    const event: MokaEvent = { ...input, id: eventId(), ts: input.ts ?? Date.now() };
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must never break the agent loop.
      }
    }
    return event;
  }

  subscribe(listener: MokaEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  history(): MokaEvent[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }
}
