import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
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
  const apiKey = resolveSecret(profile.apiKey, env) || undefined;
  const baseURL = resolveSecret(profile.baseURL, env) || undefined;
  const headers = resolveRecord(profile.headers, env);

  switch (profile.provider) {
    case "openai": {
      const provider = createOpenAI({ apiKey, baseURL, headers });
      return profile.useChatApi ? provider.chat(profile.model) : provider(profile.model);
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
      return createOpenAICompatible({
        name: "ollama",
        baseURL: baseURL ?? "http://localhost:11434/v1",
        apiKey,
        headers,
      })(profile.model);
    case "openai-compatible":
      if (!baseURL) throw new Error(`Model "${profile.name}" needs a base URL.`);
      return createOpenAICompatible({ name: "custom", baseURL, apiKey, headers, includeUsage: true })(profile.model);
  }
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
