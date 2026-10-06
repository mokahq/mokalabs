import type { EventBus, MokaEvent, MokaEventInput } from "./events.js";

/** How a request ended: a response, a cancellation, or no response before the connection closed. */
export interface RpcSettled {
  /** Event id of the request. */
  eventId: string;
  method: string;
  /** The request message as sent. */
  request: any;
  outcome: "ok" | "error" | "cancelled" | "late" | "unanswered";
  reason?: string;
}

export interface RpcTrackerOptions {
  serverId: string;
  /** Who sends the "out" messages, for titles like "Moka gave up on …". Default "Moka". */
  clientLabel?: () => string;
  /** For an outgoing request: the tool call (`tool.call` data.id) it belongs to, if known. */
  linkCall?: (message: any) => string | undefined;
  /** A reply arrived for a request that was already cancelled. */
  onLate?: (rpcId: string) => void;
  /** A request ended (once per outcome, a late reply after a cancellation included). */
  onSettled?: (settled: RpcSettled) => void;
}

interface OpenRequest {
  eventId: string;
  method: string;
  at: number;
  request: any;
  cancelled?: boolean;
  callId?: string;
}

/**
 * Mirrors JSON-RPC traffic onto the event bus as `mcp.rpc` events and pairs
 * every response, cancellation and "no response" with its request (latency,
 * timeouts, late replies). Used for Moka's own connections and for traffic
 * recorded by `@mokalabs/proxy` between another client and a server.
 */
export class RpcTracker {
  // Open requests, keyed by who sent them: "out:3" = the client's request #3, "in:0" = the server's.
  private readonly open = new Map<string, OpenRequest>();

  constructor(
    private readonly bus: EventBus,
    private readonly options: RpcTrackerOptions,
  ) {}

  /** Record one message. `at` is when it crossed the wire (default now). `extra` adds to the event. */
  record(direction: "in" | "out", message: any, at = Date.now(), extra: Partial<MokaEventInput> = {}): MokaEvent {
    const { open, options } = this;
    const input: MokaEventInput = { kind: "mcp.rpc", direction, title: rpcTitle(message), serverId: options.serverId, data: message, ts: at };
    const other = direction === "out" ? "in" : "out";
    let request: string | undefined;
    let callId: string | undefined;
    if (message?.method === "notifications/cancelled" && message.params?.requestId != null) {
      // A cancellation refers to a request the *same* side sent earlier.
      const key = `${direction}:${message.params.requestId}`;
      const target = open.get(key);
      if (target) {
        target.cancelled = true;
        const timedOut = /timed? ?out/i.test(String(message.params.reason ?? ""));
        // Most servers never answer a cancelled request; stop waiting for a late reply after a minute.
        setTimeout(() => open.get(key) === target && open.delete(key), 60_000).unref?.();
        input.rpc = {
          id: String(message.params.requestId),
          method: target.method,
          pairId: target.eventId,
          outcome: "cancelled",
          ...(timedOut ? { reason: "timeout" } : {}),
          ...(target.callId ? { callId: target.callId } : {}),
        };
        input.durationMs = at - target.at;
        input.title = timedOut
          ? `${direction === "out" ? (options.clientLabel?.() ?? "Moka") : "The server"} gave up on ${target.method} #${message.params.requestId} after ${formatWait(at - target.at)} (timeout)`
          : `${message.method} → ${target.method} #${message.params.requestId}`;
        if (timedOut) input.level = "warn";
        options.onSettled?.({ eventId: target.eventId, method: target.method, request: target.request, outcome: "cancelled", ...(timedOut ? { reason: "timeout" } : {}) });
      }
    } else if (message?.method === "notifications/progress" && message.params?.progressToken != null) {
      // The SDK uses the request id as the progress token.
      const target = open.get(`${other}:${message.params.progressToken}`);
      if (target) {
        const { progress, total } = message.params;
        input.rpc = { id: String(message.params.progressToken), method: target.method, pairId: target.eventId, ...(target.callId ? { callId: target.callId } : {}) };
        input.title = `progress ${total ? `${Math.round((progress / total) * 100)}%` : progress} → ${target.method} #${message.params.progressToken}`;
      }
    } else if (message?.method && message.id != null) {
      input.rpc = { id: String(message.id), method: message.method };
      request = `${direction}:${message.id}`;
      if (direction === "out") {
        callId = options.linkCall?.(message);
        if (callId) input.rpc.callId = callId;
      }
    } else if (!message?.method && message?.id != null) {
      const key = `${other}:${message.id}`;
      const target = open.get(key);
      const outcome = target?.cancelled ? "late" : message.error ? "error" : "ok";
      input.rpc = { id: String(message.id), method: target?.method, pairId: target?.eventId, outcome, ...(target?.callId ? { callId: target.callId } : {}) };
      if (target) {
        input.durationMs = at - target.at;
        input.title = `${outcome === "late" ? "late " : ""}${message.error ? "error" : "result"} #${message.id} · ${target.method}`;
        if (outcome === "late") {
          input.level = "warn";
          options.onLate?.(String(message.id));
        }
        open.delete(key);
        options.onSettled?.({ eventId: target.eventId, method: target.method, request: target.request, outcome });
      }
    }
    const event = this.bus.emit({ ...input, ...extra, title: extra.title ?? input.title });
    if (request) open.set(request, { eventId: event.id, method: message.method, at, request: message, ...(callId ? { callId } : {}) });
    return event;
  }

  /** The connection closed: whatever is still open will never be answered. */
  close(at = Date.now(), reason = "connection closed"): void {
    for (const [key, request] of this.open) {
      if (request.cancelled) continue;
      const [direction, rpcId] = key.split(":") as ["in" | "out", string];
      this.bus.emit({
        kind: "mcp.unanswered",
        level: "warn",
        direction,
        serverId: this.options.serverId,
        ts: at,
        title: `${request.method} #${rpcId}: no response (${reason} after ${formatWait(at - request.at)})`,
        durationMs: at - request.at,
        rpc: { id: rpcId, method: request.method, pairId: request.eventId, outcome: "unanswered", ...(request.callId ? { callId: request.callId } : {}) },
        data: { id: rpcId, method: request.method, waitedMs: at - request.at, reason },
      });
      this.options.onSettled?.({ eventId: request.eventId, method: request.method, request: request.request, outcome: "unanswered" });
    }
    this.open.clear();
  }
}

export function formatWait(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function rpcTitle(message: any): string {
  if (message?.method) return message.id != null ? `${message.method} #${message.id}` : message.method;
  if (message?.error) return `error #${message.id}`;
  return `result #${message?.id}`;
}
