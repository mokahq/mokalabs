import type { ModelMessage } from "ai";
import type { ChatChunk } from "./agent.js";
import { resolveRecord, resolveSecret, type LlmProfile } from "./config.js";
import type { EventBus } from "./events.js";

/**
 * Speech to text with a transcription model (Whisper, Parakeet…): the audio
 * files in your last message go to the server's OpenAI-style
 * `/audio/transcriptions` endpoint, and the text comes back as the reply.
 * Works with OpenAI, Groq, oMLX, LocalAI, Speaches, whisper.cpp's server and
 * other OpenAI-compatible servers.
 */

export interface AudioFile {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

/** Audio Moka sends as is. Most servers decode these with ffmpeg. */
export const AUDIO_EXTENSIONS = ["wav", "mp3", "m4a", "mp4", "mpeg", "mpga", "ogg", "oga", "opus", "flac", "webm", "aac"];

const EXT: Record<string, string> = { "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/ogg": "ogg", "audio/opus": "opus", "audio/flac": "flac", "audio/x-flac": "flac", "audio/webm": "webm", "audio/aac": "aac" };

export function isAudio(mediaType: string | undefined, name?: string): boolean {
  if (mediaType?.startsWith("audio/")) return true;
  const ext = name?.split(".").pop()?.toLowerCase();
  return Boolean(ext && AUDIO_EXTENSIONS.includes(ext) && (!mediaType || mediaType === "application/octet-stream" || mediaType === "video/mp4" || mediaType === "video/webm"));
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string") {
    const match = /^data:[^,]*?(;base64)?,(.*)$/s.exec(data);
    if (match) return match[1] ? Buffer.from(match[2]!, "base64") : Buffer.from(decodeURIComponent(match[2]!));
    if (/^[A-Za-z0-9+/=\s]+$/.test(data)) return Buffer.from(data, "base64");
  }
  return undefined;
}

/** The audio files and the text of the last user message. */
export function audioFromMessages(messages: ModelMessage[]): { files: AudioFile[]; prompt: string } {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return { files: [], prompt: "" };
  if (typeof last.content === "string") return { files: [], prompt: last.content.trim() };
  const files: AudioFile[] = [];
  const text: string[] = [];
  for (const part of last.content as any[]) {
    if (part.type === "text") text.push(part.text);
    else if (part.type === "file" && isAudio(part.mediaType, part.filename)) {
      const bytes = toBytes(part.data);
      if (bytes) files.push({ name: part.filename ?? `audio.${EXT[part.mediaType] ?? "wav"}`, mediaType: part.mediaType ?? "audio/wav", bytes });
    }
  }
  return { files, prompt: text.join("\n").trim() };
}

/** Where the profile's transcription endpoint lives, or why it has none. */
export function transcriptionUrl(llm: LlmProfile): string {
  switch (llm.provider) {
    case "openai":
      return `${(llm.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/audio/transcriptions`;
    case "openai-compatible":
      if (!llm.baseURL) throw new Error(`${llm.name} has no base URL.`);
      return `${llm.baseURL.replace(/\/+$/, "")}/audio/transcriptions`;
    case "ollama":
      throw new Error("Ollama doesn't serve speech-to-text models. Run Whisper in a server with an OpenAI-style /v1/audio/transcriptions endpoint (oMLX, LocalAI, Speaches, whisper.cpp) and add it as an OpenAI-compatible model.");
    default:
      throw new Error(`Moka can transcribe with OpenAI or an OpenAI-compatible server, not with ${llm.provider}. Add the model as OpenAI-compatible, or set its type to Chat.`);
  }
}

export async function transcribe(
  llm: LlmProfile,
  file: AudioFile,
  options: { prompt?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<{ text: string; language?: string; duration?: number; fields: Record<string, string> }> {
  const { env = process.env, fetcher = fetch } = options;
  const form = new FormData();
  const fields: Record<string, string> = { model: llm.model, response_format: "json", ...(options.prompt ? { prompt: options.prompt } : {}) };
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("file", new Blob([file.bytes as unknown as ArrayBuffer], { type: file.mediaType }), file.name);
  const key = resolveSecret(llm.apiKey, env);
  const res = await fetcher(transcriptionUrl(llm), {
    method: "POST",
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...resolveRecord(llm.headers, env) },
    body: form,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 300);
    try {
      const body = JSON.parse(raw);
      detail = body?.error?.message ?? body?.detail ?? body?.message ?? detail;
    } catch {
      // not JSON
    }
    const hint = res.status === 404 ? ` The server has no ${new URL(transcriptionUrl(llm)).pathname} endpoint; is this a speech-to-text server?` : "";
    throw new Error(`${llm.name} answered HTTP ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}.${hint}`);
  }
  let text = raw;
  let language: string | undefined;
  let duration: number | undefined;
  try {
    const body = JSON.parse(raw);
    text = typeof body === "string" ? body : (body.text ?? "");
    language = body.language;
    duration = body.duration;
  } catch {
    // Some servers answer with plain text.
  }
  return { text: text.trim(), ...(language ? { language } : {}), ...(typeof duration === "number" ? { duration } : {}), fields: { ...fields, file: `${file.name} (${file.mediaType}, ${file.bytes.length.toLocaleString("en-US")} bytes)` } };
}

/** A chat turn with a transcription model: transcribe each audio file in the last message. */
export async function* runTranscription(options: {
  runId: string;
  llm: LlmProfile;
  messages: ModelMessage[];
  bus: EventBus;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
}): AsyncGenerator<ChatChunk> {
  const { runId, llm, bus } = options;
  const started = Date.now();
  yield { type: "start", runId, model: llm.model, profileId: llm.id, tools: 0 };
  bus.emit({ kind: "run.start", runId, title: `Run started · ${llm.name} (${llm.model}) · transcription`, data: { profile: llm.id, model: llm.model, tools: [], kind: "transcription" } });
  const { files, prompt } = audioFromMessages(options.messages);
  if (files.length === 0) {
    const message = `${llm.name} is a speech-to-text model: attach an audio file (WAV, MP3, M4A, OGG, FLAC or WebM) or record one with the microphone, and it replies with the text. Any text you type is sent as a hint (names, spelling).`;
    bus.emit({ kind: "run.error", level: "error", runId, title: "Nothing to transcribe", data: { message } });
    yield { type: "error", message };
    return;
  }
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(llm.timeoutMs ?? 300_000)]);
  const texts: string[] = [];
  try {
    for (const [index, file] of files.entries()) {
      const stepStarted = Date.now();
      bus.emit({
        kind: "llm.request",
        runId,
        title: `→ ${llm.model} · ${file.name}`,
        data: {
          model: llm.model,
          provider: llm.provider,
          step: index + 1,
          url: transcriptionUrl(llm),
          messages: [{ role: "user", content: [{ type: "file", mediaType: file.mediaType, filename: `${file.name} · ${(file.bytes.length / 1024).toFixed(0)} KB` }, ...(prompt ? [{ type: "text", text: prompt }] : [])] }],
        },
      });
      const result = await transcribe(llm, file, { prompt, signal, ...(options.env ? { env: options.env } : {}), ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
      bus.emit({
        kind: "llm.response",
        runId,
        title: `← ${llm.model} · ${result.text.length.toLocaleString("en-US")} characters`,
        durationMs: Date.now() - stepStarted,
        data: { finishReason: "stop", output: { text: result.text }, ...(result.language ? { language: result.language } : {}), ...(result.duration !== undefined ? { audioSeconds: result.duration } : {}), request: result.fields },
      });
      const piece = files.length > 1 ? `**${file.name}**\n\n${result.text || "_(no speech)_"}` : result.text || "_(No speech found in the audio.)_";
      texts.push(piece);
      yield { type: "text", text: `${index > 0 ? "\n\n" : ""}${piece}` };
    }
    const durationMs = Date.now() - started;
    bus.emit({ kind: "run.finish", runId, title: `Run finished · ${files.length} file${files.length > 1 ? "s" : ""} transcribed`, durationMs, data: {} });
    yield { type: "finish", usage: {}, durationMs, messages: [{ role: "assistant", content: texts.join("\n\n") }] };
  } catch (error) {
    const message = options.signal?.aborted ? "Stopped" : signal.aborted ? `${llm.name} didn't answer within ${Math.round((llm.timeoutMs ?? 300_000) / 1000)}s.` : error instanceof Error ? error.message : String(error);
    bus.emit({ kind: "run.error", level: "error", runId, title: `Transcription failed · ${llm.name}`, data: { message } });
    yield { type: "error", message };
  }
}

/** Half a second of silence as a 16 kHz mono WAV: enough to check a transcription endpoint answers. */
export function silentWav(ms = 500, rate = 16_000): Uint8Array {
  const samples = Math.round((rate * ms) / 1000);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return new Uint8Array(buffer);
}
