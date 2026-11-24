import type { LlmProfile } from "./config.js";

/**
 * The prompt didn't fit in the model's context window. Every provider words it
 * differently; these are the ones Moka knows (LM Studio, Ollama, llama.cpp,
 * vLLM, OpenAI, Anthropic, Gemini, Groq, Mistral…).
 */
const OVERFLOW = [
  /tokens to keep from the initial prompt is greater than the context length/i, // LM Studio
  /context[_ ]length[_ ]exceeded/i, // OpenAI
  /maximum context length is \d+/i, // OpenAI, vLLM
  /exceeds? (the )?(model'?s? )?(maximum )?context (length|window|size)/i,
  /input length exceeds the context length/i, // Ollama
  /context size has been exceeded|exceeds the available context size/i, // llama.cpp
  /prompt is too long/i, // Anthropic
  /input token count .* exceeds the maximum/i, // Gemini
  /reduce the length of the messages/i,
  /too many tokens/i,
];

export function isContextOverflow(message: string): boolean {
  return OVERFLOW.some((re) => re.test(message));
}

/** What Moka sent, roughly, by part. */
export interface PromptSize {
  system: number;
  tools: Array<{ source: string; count: number; tokens: number }>;
  conversation: number;
}

const fmt = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US"));

export function isLmStudio(llm: LlmProfile): boolean {
  return llm.provider === "openai-compatible" && (/:1234\b|lmstudio|lm-studio/i.test(llm.baseURL ?? "") || /lm ?studio/i.test(llm.name));
}

/**
 * LM Studio says how big a context it loaded the model with (its REST API,
 * `loaded_context_length`). Undefined when that can't be read.
 */
export async function loadedContextLength(llm: LlmProfile, fetcher: typeof fetch = fetch): Promise<number | undefined> {
  if (!isLmStudio(llm) || !llm.baseURL) return undefined;
  try {
    const origin = new URL(llm.baseURL).origin;
    const res = await fetcher(`${origin}/api/v0/models/${encodeURIComponent(llm.model)}`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { loaded_context_length?: number; max_context_length?: number };
    return typeof body.loaded_context_length === "number" ? body.loaded_context_length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The error a user sees when the prompt doesn't fit: how big it was, what
 * took the room, and how to fix it for their kind of model. The provider's own
 * words come last.
 */
export function explainContextOverflow(llm: LlmProfile, size: PromptSize, original: string, loaded?: number): string {
  const tools = [...size.tools].sort((a, b) => b.tokens - a.tokens);
  const toolTotal = tools.reduce((n, t) => n + t.tokens, 0);
  const toolCount = tools.reduce((n, t) => n + t.count, 0);
  const total = size.system + toolTotal + size.conversation;
  const parts = [
    toolCount ? `≈${fmt(toolTotal)} for ${toolCount} tool definitions${tools[0] ? ` (${tools.slice(0, 3).map((t) => `${t.source} ≈${fmt(t.tokens)}`).join(", ")})` : ""}` : "",
    size.system ? `≈${fmt(size.system)} for the system prompt, skills and server instructions` : "",
    `≈${fmt(size.conversation)} for the conversation`,
  ].filter(Boolean);
  const window = loaded ? ` LM Studio loaded it with a ${fmt(loaded)}-token context.` : "";
  const fix = isLmStudio(llm)
    ? `In LM Studio, reload the model with a larger context length (${total > 12_000 ? "32768" : "16384"} or more): My Models → the model's settings → Context Length.`
    : llm.provider === "ollama"
      ? "In Ollama, raise the context: set num_ctx on the model, or start it with OLLAMA_CONTEXT_LENGTH=16384 (or more)."
      : "Use a model with a larger context window.";
  return `${llm.name} (${llm.model}) can't fit the prompt in its context window.${window} Moka sent about ${fmt(total)} tokens: ${parts.join(", ")}. ${fix} Or hide tools this workspace doesn't need (the context budget shows what each one costs). (${original})`;
}
