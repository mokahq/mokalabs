import type { FaultKind, Faults, FaultRule } from "./config.js";

/** What happens to one tool call: a delay before it's sent, and/or a failure instead of the reply. */
export interface FaultDecision {
  delayMs?: number;
  fail?: FaultKind;
}

/** mulberry32: small, fast, and the same numbers for the same seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const applies = (rule: FaultRule, tool: string) => !rule.tools?.length || rule.tools.includes(tool);

/**
 * Rolls the dice for one tool call. Every matching rule is checked in order:
 * delays add up, and the first failure that hits wins.
 */
export function decideFault(faults: Faults | undefined, tool: string, random: () => number): FaultDecision | undefined {
  if (!faults || faults.enabled === false) return undefined;
  const decision: FaultDecision = {};
  for (const rule of faults.rules) {
    if (!applies(rule, tool)) continue;
    if (random() >= (rule.rate ?? 1)) continue;
    if (rule.delayMs !== undefined) {
      const [min, max] = Array.isArray(rule.delayMs) ? rule.delayMs : [rule.delayMs, rule.delayMs];
      decision.delayMs = (decision.delayMs ?? 0) + Math.round(min + random() * Math.max(0, max - min));
    }
    if (rule.fail && !decision.fail) decision.fail = rule.fail;
  }
  return decision.delayMs !== undefined || decision.fail ? decision : undefined;
}

/** The reply Moka hands the client instead of the server's, or undefined when there's none (hang, crash). */
export function faultReply(kind: FaultKind, id: string | number): Record<string, unknown> | undefined {
  switch (kind) {
    case "error":
      return { jsonrpc: "2.0", id, error: { code: -32603, message: "Injected fault: the server failed (Moka fault injection)" } };
    case "tool-error":
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Injected fault: the tool failed (Moka fault injection)" }], isError: true } };
    case "malformed":
      return { jsonrpc: "2.0", id, result: { content: "Injected fault: not a content array (Moka fault injection)" } };
    default:
      return undefined;
  }
}
