import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { maxTokensFallbackFetch } from "./max-tokens.js";
import { tolerantStreamFetch } from "./sse-filter.js";

/**
 * Fetch for chat-completions providers: skips gateway-specific stream events,
 * and falls back to `max_completion_tokens` where `max_tokens` is rejected (Azure).
 */
const compatFetch = tolerantStreamFetch(maxTokensFallbackFetch());
import { extractReasoningMiddleware, simulateStreamingMiddleware, wrapLanguageModel, type LanguageModel } from "ai";
import { resolveRecord, resolveSecret, type LlmProfile, type ProviderKind } from "./config.js";

export interface ProviderPreset {
  id: string;
  label: string;
  provider: ProviderKind;
  baseURL?: string;
  envKey?: string;
  defaultModel: string;
  docsUrl?: string;
  needsKey: boolean;
}

/**
 * Presets shown in the "Add model" form. Anything OpenAI-compatible (vLLM,
 * LiteLLM, LM Studio, corporate gateways...) works with the "custom" preset.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai", label: "OpenAI", provider: "openai", envKey: "OPENAI_API_KEY", defaultModel: "gpt-5-mini", needsKey: true, docsUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic", provider: "anthropic", envKey: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-5", needsKey: true, docsUrl: "https://console.anthropic.com/settings/keys" },
  { id: "google", label: "Google Gemini", provider: "google", envKey: "GOOGLE_GENERATIVE_AI_API_KEY", defaultModel: "gemini-2.5-flash", needsKey: true, docsUrl: "https://aistudio.google.com/apikey" },
  { id: "azure", label: "Azure OpenAI", provider: "azure", envKey: "AZURE_API_KEY", defaultModel: "gpt-4o", needsKey: true },
  { id: "ollama", label: "Ollama (local)", provider: "ollama", baseURL: "http://localhost:11434/v1", defaultModel: "llama3.2", needsKey: false },
  { id: "lmstudio", label: "LM Studio (local)", provider: "openai-compatible", baseURL: "http://localhost:1234/v1", defaultModel: "local-model", needsKey: false },
  { id: "openrouter", label: "OpenRouter", provider: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY", defaultModel: "openai/gpt-5-mini", needsKey: true },
  { id: "groq", label: "Groq", provider: "openai-compatible", baseURL: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile", needsKey: true },
  { id: "deepseek", label: "DeepSeek", provider: "openai-compatible", baseURL: "https://api.deepseek.com/v1", envKey: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat", needsKey: true },
  { id: "mistral", label: "Mistral", provider: "openai-compatible", baseURL: "https://api.mistral.ai/v1", envKey: "MISTRAL_API_KEY", defaultModel: "mistral-large-latest", needsKey: true },
  { id: "xai", label: "xAI", provider: "openai-compatible", baseURL: "https://api.x.ai/v1", envKey: "XAI_API_KEY", defaultModel: "grok-4", needsKey: true },
  { id: "together", label: "Together AI", provider: "openai-compatible", baseURL: "https://api.together.xyz/v1", envKey: "TOGETHER_API_KEY", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", needsKey: true },
  { id: "custom", label: "Custom / Enterprise gateway", provider: "openai-compatible", baseURL: "https://", defaultModel: "", needsKey: false },
];

export function createModel(profile: LlmProfile, env: NodeJS.ProcessEnv = process.env): LanguageModel {
  const model = createProviderModel(profile, env);
  // Streaming off: one plain request ("stream": false), replayed as a stream so the rest of Moka works the same.
  return profile.stream === false && typeof model !== "string" ? wrapLanguageModel({ model, middleware: simulateStreamingMiddleware() }) : model;
}

function createProviderModel(profile: LlmProfile, env: NodeJS.ProcessEnv) {
  const apiKey = resolveSecret(profile.apiKey, env) || undefined;
  const baseURL = resolveSecret(profile.baseURL, env) || undefined;
  const headers = resolveRecord(profile.headers, env);

  switch (profile.provider) {
    case "openai": {
      if (profile.useChatApi) return createOpenAI({ apiKey, baseURL, headers, fetch: compatFetch }).chat(profile.model);
      return createOpenAI({ apiKey, baseURL, headers })(profile.model);
    }
    case "anthropic":
      return createAnthropic({ apiKey, baseURL, headers })(profile.model);
    case "google":
      return createGoogleGenerativeAI({ apiKey, baseURL, headers })(profile.model);
    case "azure":
      return createAzure({
        apiKey,
        baseURL,
        headers,
        resourceName: resolveSecret(profile.resourceName, env) || undefined,
        apiVersion: profile.apiVersion || undefined,
      })(profile.model);
    case "ollama":
      return thinkTags(
        createOpenAICompatible({
          name: "ollama",
          baseURL: baseURL ?? "http://localhost:11434/v1",
          apiKey,
          headers,
          fetch: compatFetch,
        })(profile.model),
      );
    case "openai-compatible":
      if (!baseURL) throw new Error(`Model "${profile.name}" needs a base URL.`);
      // Gateways often add their own events (timings, metadata) to the stream: skip those.
      return thinkTags(createOpenAICompatible({ name: "custom", baseURL, apiKey, headers, includeUsage: true, fetch: compatFetch })(profile.model));
  }
}

/**
 * Local and open models (Qwen3, DeepSeek-R1, QwQ…) often write their reasoning
 * inline as `<think>…</think>`. Show it as reasoning, not as part of the answer.
 * (Servers that send `reasoning_content` are handled by the provider already.)
 */
function thinkTags(model: ReturnType<ReturnType<typeof createOpenAICompatible>>) {
  return wrapLanguageModel({ model, middleware: extractReasoningMiddleware({ tagName: "think" }) });
}

type ThinkingKind = "none" | "budget" | "adaptive";

/** How a Claude model thinks: not at all (Claude 3, 3.5), with a token budget (3.7 to 4.5), or adaptively (4.6 and later). */
export function claudeThinking(model: string): ThinkingKind {
  const id = model.toLowerCase();
  if (!id.includes("claude")) return "none";
  if (/claude-(2|instant|3-(?!7))|claude-3-?(haiku|opus|sonnet)/.test(id)) return "none";
  if (/claude-3-7|claude-(opus|sonnet|haiku)-4(?:-[0-5])?(?:-\d{8})?(?=$|[@:.-])/.test(id) && !/claude-(opus|sonnet|haiku)-4-[6-9]/.test(id)) return "budget";
  return "adaptive";
}

const BUDGET: Record<"low" | "medium" | "high", number> = { low: 2048, medium: 8192, high: 24576 };

/**
 * What to send so the model's reasoning comes back and can be shown, for
 * `streamText`: a reasoning level, and provider options. The profile's own
 * `providerOptions` win over these.
 */
export function reasoningOptions(profile: LlmProfile): { reasoning?: "low" | "medium" | "high"; providerOptions?: Record<string, any> } {
  const setting = profile.reasoning ?? "auto";
  const level = setting === "low" || setting === "medium" || setting === "high" ? setting : undefined;
  const ours: Record<string, any> = {};
  if (setting !== "off") {
    switch (profile.provider) {
      case "openai":
      case "azure":
        // Summaries of the reasoning (OpenAI doesn't send the raw chain of thought). Only sent to reasoning models.
        if (!(profile.provider === "openai" && profile.useChatApi)) ours[profile.provider] = { reasoningSummary: "auto", ...(level ? { reasoningEffort: level } : {}) };
        break;
      case "anthropic": {
        const kind = claudeThinking(profile.model);
        if (kind === "adaptive") ours.anthropic = { thinking: { type: "adaptive", display: "summarized" }, ...(level ? { effort: level } : {}) };
        else if (kind === "budget") ours.anthropic = { thinking: { type: "enabled", budgetTokens: BUDGET[level ?? "low"] } };
        break;
      }
      case "google": {
        if (!/gemini-(2\.5|[3-9])|gemini-(flash|pro)(-lite)?-latest/i.test(profile.model)) break;
        // Flash models barely think at their default level (Gemini 3.x Flash: often no reasoning tokens at all,
        // 2.5 Flash-Lite: thinking off), so Auto asks for a little. A chosen level is sent as `reasoning` instead.
        const id = profile.model.toLowerCase();
        const nudge = level ? {} : /gemini-[3-9][\d.]*-flash|gemini-flash(-lite)?-latest/.test(id) ? { thinkingLevel: "low" } : /gemini-2\.5-flash-lite/.test(id) ? { thinkingBudget: 1024 } : {};
        ours.google = { thinkingConfig: { includeThoughts: true, ...nudge } };
        break;
      }
    }
  }
  const merged = { ...ours };
  for (const [key, value] of Object.entries(profile.providerOptions ?? {})) merged[key] = value && typeof value === "object" && !Array.isArray(value) ? { ...merged[key], ...value } : value;
  return {
    ...(level && profile.provider !== "anthropic" && profile.provider !== "openai" && profile.provider !== "azure" ? { reasoning: level } : {}),
    ...(Object.keys(merged).length ? { providerOptions: merged } : {}),
  };
}

/** Detect usable providers from environment variables. */
export function detectProfiles(env: NodeJS.ProcessEnv = process.env): LlmProfile[] {
  const found: LlmProfile[] = [];
  for (const preset of PROVIDER_PRESETS) {
    if (!preset.envKey) continue;
    let envKey = preset.envKey;
    if (preset.id === "google" && !env[envKey] && env.GEMINI_API_KEY) envKey = "GEMINI_API_KEY";
    if (!env[envKey]) continue;
    if (preset.id === "azure" && !env.AZURE_RESOURCE_NAME) continue;
    found.push({
      id: preset.id,
      name: preset.label,
      provider: preset.provider,
      model: preset.defaultModel,
      apiKey: `env:${envKey}`,
      baseURL: preset.provider === "openai-compatible" ? preset.baseURL : undefined,
      resourceName: preset.id === "azure" ? "env:AZURE_RESOURCE_NAME" : undefined,
    });
  }
  return found;
}

/** Probe a local Ollama instance; resolves to installed model names. */
export async function detectOllama(baseURL = "http://localhost:11434", timeoutMs = 600): Promise<string[]> {
  try {
    const res = await fetch(`${baseURL}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    return (body.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

/** Models loaded in LM Studio's local server (OpenAI-compatible, port 1234 by default), embedding models left out. */
export async function detectLmStudio(baseURL = "http://localhost:1234/v1", timeoutMs = 600): Promise<string[]> {
  try {
    const res = await fetch(`${baseURL}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return (body.data ?? []).map((m) => m.id).filter((id) => !/embed/i.test(id));
  } catch {
    return [];
  }
}

/** List models available for a profile by asking the provider's API. */
export async function listModels(profile: LlmProfile, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const apiKey = resolveSecret(profile.apiKey, env) || undefined;
  const headers = { ...(resolveRecord(profile.headers, env) ?? {}) };
  const baseURL = resolveSecret(profile.baseURL, env) || undefined;
  const signal = AbortSignal.timeout(10_000);
  const getJson = async (url: string, extra: Record<string, string> = {}) => {
    const res = await fetch(url, { headers: { ...headers, ...extra }, signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as any;
  };

  switch (profile.provider) {
    case "anthropic": {
      const body = await getJson(`${baseURL ?? "https://api.anthropic.com/v1"}/models?limit=100`, {
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        "anthropic-version": "2023-06-01",
      });
      return (body.data ?? []).map((m: any) => m.id);
    }
    case "google": {
      const url = `${baseURL ?? "https://generativelanguage.googleapis.com/v1beta"}/models?pageSize=200`;
      const body = await getJson(url, apiKey ? { "x-goog-api-key": apiKey } : {});
      return (body.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m: any) => String(m.name).replace(/^models\//, ""));
    }
    case "azure":
      throw new Error("Azure lists deployments in the Azure portal. Type your deployment name as the model.");
    default: {
      const root = baseURL ?? (profile.provider === "ollama" ? "http://localhost:11434/v1" : "https://api.openai.com/v1");
      const body = await getJson(`${root.replace(/\/$/, "")}/models`, apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
      return (body.data ?? []).map((m: any) => m.id).sort();
    }
  }
}
