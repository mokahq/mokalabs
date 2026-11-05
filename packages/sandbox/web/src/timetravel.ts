import type { Branch, ForkMeta, Part, UiMessage } from "./types";

/**
 * Time-travel: fork a turn from one of its steps. A turn's model messages are
 * its steps in order: an assistant message (text, reasoning, tool calls), then
 * a tool message with the results, then the next assistant message, and so on.
 * Every user message in the chat added exactly one "user" model message, which
 * is how a chat message maps to its turn's model messages.
 */

type ModelMessage = { role: string; content: unknown; [key: string]: unknown };
type ContentPart = { type: string; toolCallId?: string; text?: string; input?: unknown; output?: unknown; [key: string]: unknown };

/** Where the turn of the assistant message at `index` sits in the model messages: [start, end). */
export function turnRange(messages: UiMessage[], modelMessages: unknown[], index: number): [number, number] {
  const users = messages.slice(0, index).filter((m) => m.role === "user").length;
  let seen = 0;
  let start = 0;
  for (let i = 0; i < modelMessages.length; i++) {
    if ((modelMessages[i] as ModelMessage)?.role !== "user") continue;
    if (++seen === users) {
      start = i + 1;
      break;
    }
  }
  let end = modelMessages.length;
  for (let i = start; i < modelMessages.length; i++) {
    if ((modelMessages[i] as ModelMessage)?.role === "user") {
      end = i;
      break;
    }
  }
  return [start, end];
}

const content = (m: ModelMessage | undefined): ContentPart[] => (Array.isArray(m?.content) ? (m!.content as ContentPart[]) : typeof m?.content === "string" ? [{ type: "text", text: m.content }] : []);

/** Indexes of the assistant messages in a turn: one per step. */
export function stepStarts(turn: unknown[]): number[] {
  return turn.flatMap((m, i) => ((m as ModelMessage)?.role === "assistant" ? [i] : []));
}

/**
 * The step (0-based) of each part of a reply. A tool part belongs to the step
 * whose assistant message made the call; text and thinking belong to the step
 * of the next tool call after them, or to the last step.
 */
export function partSteps(parts: Part[], turn: unknown[]): number[] {
  const starts = stepStarts(turn);
  const last = Math.max(0, starts.length - 1);
  const callStep = new Map<string, number>();
  starts.forEach((at, step) => {
    for (const p of content(turn[at] as ModelMessage)) if (p.type === "tool-call" && p.toolCallId) callStep.set(p.toolCallId, step);
  });
  const steps = new Array<number>(parts.length).fill(last);
  let next = last;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (part.type === "tool" && callStep.has(part.id)) next = callStep.get(part.id)!;
    steps[i] = part.type === "tool" ? (callStep.get(part.id) ?? next) : next;
  }
  return steps;
}

export interface ForkPlan {
  /** The turn's model messages to send (the model continues after them). */
  prefix: unknown[];
  /** The reply's parts that the fork keeps (shown as shared with the original). */
  parts: Part[];
  fork: ForkMeta;
  /** Nothing to run: the edit itself is the new branch (an edited final answer). */
  done?: boolean;
}

/** The parts up to and including the last one of `step` (tool calls of a step come after its text). */
function partsThrough(parts: Part[], steps: number[], step: number): Part[] {
  let lastIndex = -1;
  steps.forEach((s, i) => {
    if (s <= step) lastIndex = i;
  });
  return parts.slice(0, lastIndex + 1);
}

function toolName(part: Part | undefined): string | undefined {
  return part?.type === "tool" ? part.tool : undefined;
}

/** Fork with a different result for a tool call: the model continues from it, nothing runs again. */
export function forkWithResult(message: UiMessage, turn: unknown[], toolId: string, output: string, isError: boolean): ForkPlan {
  const steps = partSteps(message.parts, turn);
  const index = message.parts.findIndex((p) => p.type === "tool" && p.id === toolId);
  const step = steps[index]!;
  const starts = stepStarts(turn);
  const toolAt = starts[step]! + 1;
  const prefix = turn.slice(0, toolAt + 1).map((m, i) => {
    if (i !== toolAt) return m;
    const msg = m as ModelMessage;
    return { ...msg, content: content(msg).map((p) => (p.toolCallId === toolId ? { ...p, output: isError ? { type: "error-text", value: output } : { type: "text", value: output } } : p)) };
  });
  const parts = partsThrough(message.parts, steps, step).map((p) =>
    p.type === "tool" && p.id === toolId ? { ...p, output, isError, status: isError ? ("error" as const) : ("done" as const), edited: "result" as const, ui: undefined, raw: undefined, errorClass: undefined, outcomeUnknown: undefined } : p,
  );
  const tool = toolName(message.parts[index]);
  return { prefix, parts, fork: { step: step + 1, edit: "result", tool, label: `edited result of ${tool}`, runId: message.meta?.runId } };
}

/** Fork with different arguments for a tool call: Moka runs the call again with them, then the model continues. */
export function forkWithArguments(message: UiMessage, turn: unknown[], toolId: string, input: unknown): ForkPlan {
  const steps = partSteps(message.parts, turn);
  const index = message.parts.findIndex((p) => p.type === "tool" && p.id === toolId);
  const step = steps[index]!;
  const starts = stepStarts(turn);
  const assistantAt = starts[step]!;
  const assistant = turn[assistantAt] as ModelMessage;
  const prefix: unknown[] = [...turn.slice(0, assistantAt), { ...assistant, content: content(assistant).map((p) => (p.type === "tool-call" && p.toolCallId === toolId ? { ...p, input } : p)) }];
  // Keep the other calls' results; the edited one runs again.
  const results = turn[assistantAt + 1] as ModelMessage | undefined;
  if (results?.role === "tool") {
    const others = content(results).filter((p) => p.toolCallId !== toolId);
    if (others.length) prefix.push({ ...results, content: others });
  }
  const parts = partsThrough(message.parts, steps, step).filter((p) => !(p.type === "tool" && p.id === toolId));
  const tool = toolName(message.parts[index]);
  return { prefix, parts, fork: { step: step + 1, edit: "arguments", tool, label: `edited arguments of ${tool}`, runId: message.meta?.runId } };
}

/**
 * Fork with different text from the model at a step. The step's thinking and
 * any tool calls after the text are dropped (thinking can't be edited, and
 * Claude rejects modified thinking). An edited final answer is the branch
 * as is; mid-turn, the model continues from it.
 */
export function forkWithReply(message: UiMessage, turn: unknown[], partIndex: number, text: string): ForkPlan {
  const steps = partSteps(message.parts, turn);
  const step = steps[partIndex]!;
  const starts = stepStarts(turn);
  const assistantAt = starts[step]!;
  const assistant = turn[assistantAt] as ModelMessage | undefined;
  const prefix = [...turn.slice(0, assistantAt), { ...(assistant ?? { role: "assistant" }), role: "assistant", content: [{ type: "text", text }] }];
  const before = message.parts.slice(0, partIndex).filter((_, i) => steps[i]! < step);
  const parts: Part[] = [...before, { type: "text", text, edited: true }];
  const final = step === starts.length - 1 || starts.length === 0;
  return { prefix, parts, fork: { step: step + 1, edit: "reply", label: final ? "edited answer" : `edited reply at step ${step + 1}`, runId: message.meta?.runId }, done: final };
}

/** Fork that runs a step again, with the same model (retry) or another one. */
export function forkFromStep(message: UiMessage, turn: unknown[], partIndex: number, model?: { id: string; label: string }): ForkPlan {
  const steps = partSteps(message.parts, turn);
  const step = steps[partIndex] ?? 0;
  const starts = stepStarts(turn);
  const prefix = turn.slice(0, starts[step] ?? 0);
  const parts = message.parts.filter((_, i) => steps[i]! < step);
  return {
    prefix,
    parts,
    fork: model
      ? { step: step + 1, edit: "model", label: `${model.label} from step ${step + 1}`, runId: message.meta?.runId }
      : { step: step + 1, edit: "retry", label: `retry from step ${step + 1}`, runId: message.meta?.runId },
  };
}

/** The reply as a branch, without its own branch list. */
function bare(message: UiMessage): UiMessage {
  const { branches: _b, branch: _i, ...rest } = message;
  return rest;
}

/** Snapshot the active branch of the turn at `index`, so switching away keeps it. */
export function snapshot(messages: UiMessage[], modelMessages: unknown[], index: number): Branch {
  const message = messages[index]!;
  const [start, end] = turnRange(messages, modelMessages, index);
  return {
    label: message.fork?.label ?? "original",
    ...(message.fork ? { fork: message.fork } : {}),
    message: bare(message),
    turnModel: modelMessages.slice(start, end),
    tail: messages.slice(index + 1),
    tailModel: modelMessages.slice(end),
  };
}

/** The chat with the turn at `index` showing branch `to` (the current one is saved first). */
export function switchBranch(messages: UiMessage[], modelMessages: unknown[], index: number, to: number): { messages: UiMessage[]; modelMessages: unknown[] } {
  const current = messages[index]!;
  const branches = [...(current.branches ?? [snapshot(messages, modelMessages, index)])];
  branches[current.branch ?? 0] = snapshot(messages, modelMessages, index);
  const target = branches[to];
  if (!target) return { messages, modelMessages };
  const [start] = turnRange(messages, modelMessages, index);
  return {
    messages: [...messages.slice(0, index), { ...target.message, branches, branch: to }, ...target.tail],
    modelMessages: [...modelMessages.slice(0, start), ...target.turnModel, ...target.tailModel],
  };
}
