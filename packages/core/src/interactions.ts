import type { EventBus } from "./events.js";

/**
 * Human-in-the-loop requests: tool approvals, MCP elicitation (a server asks
 * the user for input) and MCP sampling (a server asks to use the model).
 *
 * Requests are published on the event bus as `interaction.request` and stay
 * pending until someone calls `respond()` (the sandbox UI does this over
 * HTTP) or the request is aborted. Embedders can pass a `handler` to answer
 * programmatically instead.
 */

export type InteractionKind = "tool-approval" | "elicitation" | "sampling";

export interface ToolApprovalRequest {
  kind: "tool-approval";
  runId?: string;
  toolCallId: string;
  serverId: string;
  serverName: string;
  tool: string;
  input: unknown;
  annotations?: Record<string, unknown>;
}

export interface ElicitationRequest {
  kind: "elicitation";
  serverId: string;
  serverName: string;
  message: string;
  /** "form": fill `requestedSchema`; "url": open `url` (out-of-band flow). */
  mode: "form" | "url";
  requestedSchema?: Record<string, unknown>;
  url?: string;
}

export interface SamplingRequest {
  kind: "sampling";
  serverId: string;
  serverName: string;
  messages: unknown[];
  systemPrompt?: string;
  maxTokens?: number;
  modelHint?: string;
}

export type InteractionRequest = ToolApprovalRequest | ElicitationRequest | SamplingRequest;

export type ToolApprovalResponse = { approved: boolean; remember?: "session" | "always" };
export type ElicitationResponse = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };
export type SamplingResponse = { approved: boolean };
export type InteractionResponse = ToolApprovalResponse | ElicitationResponse | SamplingResponse;

export type ResponseFor<R extends InteractionRequest> = R extends ToolApprovalRequest
  ? ToolApprovalResponse
  : R extends ElicitationRequest
    ? ElicitationResponse
    : SamplingResponse;

export type Interaction = InteractionRequest & { id: string; createdAt: number };

export type InteractionHandler = (interaction: Interaction) => Promise<InteractionResponse>;

interface Pending {
  interaction: Interaction;
  resolve: (response: InteractionResponse) => void;
}

const CANCELLED: Record<InteractionKind, InteractionResponse> = {
  "tool-approval": { approved: false },
  elicitation: { action: "cancel" },
  sampling: { approved: false },
};

let counter = 0;

export class InteractionBroker {
  private pendingById = new Map<string, Pending>();

  constructor(
    private readonly bus: EventBus,
    private readonly handler?: InteractionHandler,
  ) {}

  pending(): Interaction[] {
    return [...this.pendingById.values()].map((p) => p.interaction);
  }

  /** Ask the user. Resolves with their answer, or a "cancelled" answer if `signal` aborts. */
  request<R extends InteractionRequest>(request: R, signal?: AbortSignal): Promise<ResponseFor<R>> {
    const interaction = { ...request, id: `ix_${Date.now().toString(36)}${(++counter).toString(36)}`, createdAt: Date.now() } as Interaction;
    if (this.handler) return this.handler(interaction) as Promise<ResponseFor<R>>;
    if (signal?.aborted) return Promise.resolve(CANCELLED[request.kind] as ResponseFor<R>);
    return new Promise<ResponseFor<R>>((resolve) => {
      const onAbort = () => this.finish(interaction.id, CANCELLED[request.kind], "cancelled");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingById.set(interaction.id, {
        interaction,
        resolve: (response) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(response as ResponseFor<R>);
        },
      });
      this.bus.emit({
        kind: "interaction.request",
        runId: "runId" in request ? request.runId : undefined,
        serverId: request.serverId,
        title: titleFor(request),
        data: interaction,
      });
    });
  }

  /** Answer a pending request. Returns false if it no longer exists. */
  respond(id: string, response: InteractionResponse): boolean {
    return this.finish(id, response, "answered");
  }

  /** Cancel everything (e.g. on shutdown). */
  cancelAll(): void {
    for (const { interaction } of this.pendingById.values()) this.finish(interaction.id, CANCELLED[interaction.kind], "cancelled");
  }

  private finish(id: string, response: InteractionResponse, outcome: "answered" | "cancelled"): boolean {
    const pending = this.pendingById.get(id);
    if (!pending) return false;
    this.pendingById.delete(id);
    pending.resolve(response);
    const { interaction } = pending;
    this.bus.emit({
      kind: "interaction.resolved",
      runId: "runId" in interaction ? interaction.runId : undefined,
      serverId: interaction.serverId,
      title: `${titleFor(interaction)} · ${outcome === "cancelled" ? "cancelled" : summarise(response)}`,
      data: { id, kind: interaction.kind, outcome, response },
    });
    return true;
  }
}

function titleFor(request: InteractionRequest): string {
  switch (request.kind) {
    case "tool-approval":
      return `Approval · ${request.serverName} › ${request.tool}`;
    case "elicitation":
      return `Input requested · ${request.serverName}`;
    case "sampling":
      return `Sampling requested · ${request.serverName}`;
  }
}

function summarise(response: InteractionResponse): string {
  if ("approved" in response) return response.approved ? "approved" : "denied";
  return response.action;
}
