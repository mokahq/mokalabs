import type { LlmProfile } from "./config.js";
import { claudeThinking } from "./providers.js";

/** What a model is for: chatting (text, tools) or turning speech into text. */
export type ModelKind = "chat" | "transcription";

/**
 * How much say you have over a model's thinking:
 * - `levels`: off, low, medium, high (OpenAI reasoning models, Claude, Gemini 2.5+, gpt-oss)
 * - `toggle`: on or off (hybrid models: Qwen3, DeepSeek V3.1, GLM-4.5+, SmolLM3…)
 * - `always`: it always thinks and its effort can't be set (DeepSeek-R1, QwQ, "thinking" models)
 */
export type ReasoningControl = "levels" | "toggle" | "always";

export interface ModelCapabilities {
  kind: ModelKind;
  reasoning?: ReasoningControl;
}

const TRANSCRIPTION = /whisper|parakeet|canary-\d|moonshine|sensevoice|(^|[-_/])transcribe|speech-?to-?text|(^|[-_/])stt($|[-_/])|distil-large-v\d/i;

export function modelKind(profile: Pick<LlmProfile, "model" | "kind">): ModelKind {
  if (profile.kind) return profile.kind;
  return TRANSCRIPTION.test(profile.model) ? "transcription" : "chat";
}

export function reasoningControl(profile: Pick<LlmProfile, "provider" | "model" | "useChatApi">): ReasoningControl | undefined {
  const id = profile.model.toLowerCase();
  switch (profile.provider) {
    case "openai":
    case "azure": {
      const gpt = /gpt-(\d+)(?:\.(\d+))?/.exec(id);
      if (gpt) return Number(gpt[1]) >= 5 && !id.includes("chat") ? "levels" : undefined;
      if (/(^|\/)o\d/.test(id)) return "levels";
      if (id.includes("gpt-oss")) return "levels";
      return undefined;
    }
    case "anthropic":
      return claudeThinking(profile.model) === "none" ? undefined : "levels";
    case "google":
      return /gemini-(2\.5|[3-9])|gemini-(flash|pro)(-lite)?-latest/.test(id) ? "levels" : undefined;
    default:
      return localReasoning(id);
  }
}

/** Open-weight models, by name (LM Studio, Ollama, vLLM, llama.cpp, oMLX, OpenRouter…). */
function localReasoning(id: string): ReasoningControl | undefined {
  // Instruct-only releases don't think; thinking-only releases always do.
  if (/qwen-?3[\w.-]*instruct-2507|qwen-?3[\w.-]*-instruct(?![\w])/.test(id)) return undefined;
  if (/gpt-oss/.test(id)) return "levels";
  if (/thinking|reasoning|deepseek-r1|(^|[-_/])r1([-_:]|$)|qwq|magistral|phi-4-(mini-)?reasoning|glm-z1|kimi-k2-thinking|exaone-deep|openthinker|skywork-o1/.test(id)) return "always";
  if (/qwen-?3|qwen3\.5|deepseek-v3\.[1-9]|glm-4\.[5-9]|glm-[5-9]|smollm-?3|hunyuan|granite-3\.[2-9]|seed-oss|nemotron[\w.-]*(nano|super)/.test(id)) return "toggle";
  return undefined;
}

export function modelCapabilities(profile: LlmProfile): ModelCapabilities {
  const kind = modelKind(profile);
  const reasoning = kind === "chat" ? reasoningControl(profile) : undefined;
  return { kind, ...(reasoning ? { reasoning } : {}) };
}
