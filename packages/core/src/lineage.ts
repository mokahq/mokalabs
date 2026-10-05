import { createHash } from "node:crypto";

/**
 * Retry lineage: the attempts of one logical tool call share a lineage, so a
 * timeout followed by the same call reads as a retry, not as two unrelated calls.
 */

/** Why a tool call failed. `timeout`, `cancelled` and `transport` leave a write's outcome unknown. */
export type ToolErrorClass =
  /** The client stopped waiting (tool timeout). The server may still have done the work. */
  | "timeout"
  /** The call was aborted (the user pressed Stop). */
  | "cancelled"
  /** The connection broke: server crashed or disconnected, HTTP or network error. */
  | "transport"
  /** The server answered with a JSON-RPC error. */
  | "protocol"
  /** The tool ran and reported an error (`isError: true`). */
  | "tool"
  /** The user declined the call in the approval prompt. */
  | "declined"
  /** The model's arguments didn't match the tool's input schema, or the tool doesn't exist. */
  | "input"
  | "other";

/** Error classes after which nobody knows whether a write happened. */
export const UNKNOWN_OUTCOME: ReadonlySet<ToolErrorClass> = new Set(["timeout", "cancelled", "transport"]);

/** Where an attempt sits in its lineage (on `tool.call`, `tool.result` and `tool.error` events). */
export interface ToolLineage {
  /** The tool call id of the first attempt; shared by every attempt. */
  id: string;
  /** 1 for the first attempt, 2 for the first retry, … */
  attempt: number;
  /** Hash of server + method + tool + input schema + normalized arguments. */
  fingerprint: string;
}

/** JSON with sorted keys, so `{a,b}` and `{b,a}` compare equal. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * Identity of a tool call for retry detection. The schema hash keeps a call to a
 * changed tool (new version, different arguments) from counting as a retry.
 */
export function toolFingerprint(serverId: string, tool: string, schemaHash: string, args: unknown): string {
  return shortHash([serverId, "tools/call", tool, schemaHash, stableJson(args ?? {})].join("\u0000"));
}

type ClassifiedError = Error & { errorClass?: ToolErrorClass; notSent?: boolean };

/**
 * Tag an error with its class (kept on the error object so it survives the AI SDK's tool loop).
 * `notSent`: the request never left Moka, so the outcome is known (nothing happened).
 */
export function withErrorClass(error: unknown, errorClass: ToolErrorClass, options: { notSent?: boolean } = {}): Error {
  const err = (error instanceof Error ? error : new Error(typeof error === "string" ? error : errorText(error))) as ClassifiedError;
  err.errorClass ??= errorClass;
  if (options.notSent) err.notSent = true;
  return err;
}

/** Whether a failed call of a tool that may write leaves it unknown if the write happened. */
export function outcomeUnknown(error: unknown, errorClass: ToolErrorClass): boolean {
  return UNKNOWN_OUTCOME.has(errorClass) && !(error as ClassifiedError | undefined)?.notSent;
}

/** The class an error was tagged with, or a best guess from its name. */
export function errorClassOf(error: unknown): ToolErrorClass {
  const tagged = (error as { errorClass?: ToolErrorClass } | undefined)?.errorClass;
  if (tagged) return tagged;
  const name = String((error as { name?: string } | undefined)?.name ?? "");
  if (/InvalidToolInput|NoSuchTool|ToolCallRepair/i.test(name)) return "input";
  if (/Abort/i.test(name)) return "cancelled";
  return "other";
}

function errorText(error: unknown): string {
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
