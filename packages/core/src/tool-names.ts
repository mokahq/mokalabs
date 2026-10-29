/**
 * Models sometimes call a tool by a name that isn't quite the one they were
 * given: without Moka's `<server>__` prefix (`order_coffee`), or with a
 * namespace of their own (Gemini's `default_api.order_coffee`, OpenAI-style
 * `functions.order_coffee`). When exactly one tool fits, that's the call they
 * meant.
 */
const MODEL_PREFIX = /^(?:default_api|functions|tools|api)(?:\.|__|:)/i;

export function repairToolName(name: string, available: string[]): string | undefined {
  if (available.includes(name)) return name;
  const bare = name.replace(MODEL_PREFIX, "");
  if (available.includes(bare)) return bare;
  // `server.tool` or `server/tool` for `server__tool`.
  const dotted = bare.replace(/[./:]/, "__");
  if (available.includes(dotted)) return dotted;
  const short = bare.includes("__") ? bare.slice(bare.lastIndexOf("__") + 2) : bare;
  const matches = available.filter((t) => t === short || t.endsWith(`__${short}`));
  return matches.length === 1 ? matches[0] : undefined;
}
