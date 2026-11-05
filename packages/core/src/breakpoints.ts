import { z } from "zod";

export const BREAKPOINT_PHASES = ["before-tool", "after-tool", "error", "model-step"] as const;
export type BreakpointPhase = (typeof BREAKPOINT_PHASES)[number];

/** A simple check on a tool call's arguments: `args.priority == "high"`, `args.title contains "prod"`. No code runs. */
export const breakpointConditionSchema = z.object({
  /** Argument path, e.g. `priority` or `issue.labels`. */
  arg: z.string().min(1),
  op: z.enum(["eq", "ne", "contains", "gt", "lt", "exists"]),
  value: z.unknown().optional(),
});
export type BreakpointCondition = z.infer<typeof breakpointConditionSchema>;

export const breakpointSchema = z.object({
  id: z.string().min(1),
  on: z.enum(BREAKPOINT_PHASES),
  /** Tool name (`create_issue`) or `server/tool`; empty: every tool. Not used by `model-step`. */
  tool: z.string().optional(),
  when: breakpointConditionSchema.optional(),
  enabled: z.boolean().optional(),
});
export type Breakpoint = z.infer<typeof breakpointSchema>;

/** Where a run is when it checks for breakpoints. */
export interface BreakpointHit {
  phase: BreakpointPhase;
  runId: string;
  serverId?: string;
  serverName?: string;
  tool?: string;
  toolCallId?: string;
  input?: unknown;
  output?: string;
  error?: string;
  /** model-step: 1-based step, the model, and what it's about to be sent. */
  step?: number;
  model?: string;
  messages?: unknown[];
}

/**
 * What to do after a pause. `step`: continue, and pause again at the next tool
 * call or model step. `skip` (before a tool): don't run it. `fail`: the tool
 * fails with `message`. `stop`: end the run. `input`, `output` and `llmId`
 * replace the arguments, the result, or the model for this step.
 */
export interface BreakpointDecision {
  action: "continue" | "step" | "skip" | "fail" | "stop";
  input?: unknown;
  output?: string;
  message?: string;
  llmId?: string;
}

function read(input: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), input);
}

/** Whether a condition holds for these arguments. Strings compare without case. */
export function conditionHolds(when: BreakpointCondition, input: unknown): boolean {
  const actual = read(input, when.arg);
  const norm = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v);
  switch (when.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "eq":
      return JSON.stringify(norm(actual)) === JSON.stringify(norm(when.value));
    case "ne":
      return JSON.stringify(norm(actual)) !== JSON.stringify(norm(when.value));
    case "contains":
      return Array.isArray(actual) ? actual.some((v) => JSON.stringify(norm(v)) === JSON.stringify(norm(when.value))) : String(actual ?? "").toLowerCase().includes(String(when.value ?? "").toLowerCase());
    case "gt":
      return Number(actual) > Number(when.value);
    case "lt":
      return Number(actual) < Number(when.value);
  }
}

/** The first enabled breakpoint that applies to this point of a run. */
export function matchBreakpoint(breakpoints: Breakpoint[] | undefined, hit: Pick<BreakpointHit, "phase" | "tool" | "serverId" | "input">): Breakpoint | undefined {
  return (breakpoints ?? []).find((b) => {
    if (b.enabled === false || b.on !== hit.phase) return false;
    if (b.on === "model-step") return true;
    if (b.tool && b.tool !== hit.tool && b.tool !== `${hit.serverId}/${hit.tool}`) return false;
    return !b.when || conditionHolds(b.when, hit.input);
  });
}

/** What a run asks at each point it may pause; undefined: carry on. */
export type Debugger = (hit: BreakpointHit, signal?: AbortSignal) => Promise<BreakpointDecision | undefined>;
