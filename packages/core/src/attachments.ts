import type { ModelMessage } from "ai";
import type { LlmProfile } from "./config.js";

/**
 * Files attached to a chat go to each model in a form it can read. PDFs go as
 * files to providers that take them (OpenAI, Anthropic, Gemini, Azure); for
 * every other model (LM Studio, Ollama, gateways…) and for formats no provider
 * takes (Word…), the file part becomes the text Moka read from it in the
 * browser, carried in `providerOptions.moka.text`. Without that, the AI SDK
 * rejects the whole request ("file part media type … not supported"), and
 * every later turn of the chat with it.
 */

const PDF_PROVIDERS = new Set<LlmProfile["provider"]>(["openai", "anthropic", "google", "azure"]);

/** Whether the provider takes this media type as a file part. Images are left to the model (vision). */
export function acceptsFile(provider: LlmProfile["provider"], mediaType: string): boolean {
  const type = mediaType.toLowerCase();
  if (type.startsWith("image/")) return true;
  if (type === "application/pdf") return PDF_PROVIDERS.has(provider);
  if (provider === "google") return type.startsWith("audio/") || type.startsWith("video/");
  return false;
}

function fallbackText(part: any): string {
  const text = part.providerOptions?.moka?.text;
  if (typeof text === "string") return text;
  const name = part.filename ?? "file";
  return `<file name="${name}" type="${part.mediaType}">\n[This model can't read ${part.mediaType} files, and Moka couldn't read the text out of it. Tell the user, and suggest pasting the text or switching to a model that reads this kind of file.]\n</file>`;
}

/** The messages with each file part the model can't take replaced by its text. */
export function adaptAttachments(messages: ModelMessage[], provider: LlmProfile["provider"]): ModelMessage[] {
  let changed = false;
  const out = messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    let touched = false;
    const content = message.content.map((part) => {
      if (part.type !== "file" || acceptsFile(provider, part.mediaType)) return part;
      touched = true;
      return { type: "text" as const, text: fallbackText(part) };
    });
    if (!touched) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? out : messages;
}
