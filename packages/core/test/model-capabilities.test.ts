import { describe, expect, it } from "vitest";
import { audioFromMessages, EventBus, modelCapabilities, runTranscription, silentWav, transcribe, transcriptionUrl, type LlmProfile } from "../src/index.js";

const profile = (provider: LlmProfile["provider"], model: string, extra: Partial<LlmProfile> = {}): LlmProfile => ({ id: model, name: model, provider, model, ...extra });

describe("model capabilities", () => {
  it.each([
    ["openai", "gpt-5.1", "levels"],
    ["openai", "gpt-5-chat-latest", undefined],
    ["openai", "o4-mini", "levels"],
    ["openai", "gpt-4.1", undefined],
    ["anthropic", "claude-sonnet-4-5", "levels"],
    ["anthropic", "claude-3-5-haiku-latest", undefined],
    ["google", "gemini-2.5-flash", "levels"],
    ["google", "gemini-2.0-flash", undefined],
    ["openai-compatible", "openai/gpt-oss-20b", "levels"],
    ["openai-compatible", "qwen/qwen3-8b", "toggle"],
    ["openai-compatible", "qwen3.6-27b-mlx", "toggle"],
    ["openai-compatible", "qwen3-30b-a3b-instruct-2507", undefined],
    ["openai-compatible", "qwen3-30b-a3b-thinking-2507", "always"],
    ["ollama", "deepseek-r1:14b", "always"],
    ["ollama", "qwq", "always"],
    ["openai-compatible", "zai-org/glm-4.6", "toggle"],
    ["ollama", "llama3.2", undefined],
    ["openai-compatible", "google/gemma-3-12b", undefined],
  ] as const)("%s %s → %s", (provider, model, reasoning) => {
    expect(modelCapabilities(profile(provider, model)).reasoning).toBe(reasoning);
  });

  it.each([
    ["whisper-1", "transcription"],
    ["mlx-community/whisper-large-v3-turbo", "transcription"],
    ["gpt-4o-mini-transcribe", "transcription"],
    ["nvidia/parakeet-tdt-0.6b-v2", "transcription"],
    ["distil-large-v3", "transcription"],
    ["qwen3-8b", "chat"],
    ["gpt-5.1", "chat"],
  ])("%s is a %s model", (model, kind) => {
    expect(modelCapabilities(profile("openai-compatible", model)).kind).toBe(kind);
  });

  it("lets the profile say what the model is", () => {
    expect(modelCapabilities(profile("openai-compatible", "my-asr", { kind: "transcription" }))).toEqual({ kind: "transcription" });
    expect(modelCapabilities(profile("openai-compatible", "whisper-chat-thing", { kind: "chat" })).kind).toBe("chat");
  });
});

const wavDataUrl = `data:audio/wav;base64,${Buffer.from(silentWav(100)).toString("base64")}`;

/** A fake /audio/transcriptions endpoint that records what it was sent. */
function fakeServer(reply: (form: FormData) => Response) {
  const calls: Array<{ url: string; headers: Headers; form: FormData }> = [];
  const fetcher = (async (url: any, init: RequestInit) => {
    const form = init.body as FormData;
    calls.push({ url: String(url), headers: new Headers(init.headers), form });
    return reply(form);
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("transcription", () => {
  const whisper = profile("openai-compatible", "whisper-large-v3-turbo", { baseURL: "http://127.0.0.1:8000/v1/", apiKey: "env:KEY", name: "oMLX Whisper" });

  it("takes the audio and the text from the last user message", () => {
    const { files, prompt } = audioFromMessages([
      { role: "user", content: "earlier" },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "file", data: wavDataUrl, mediaType: "audio/wav", filename: "a.wav" }, { type: "text", text: "Names: Moka, oMLX" }] },
    ] as any);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("a.wav");
    expect(files[0]!.bytes.length).toBe(silentWav(100).length);
    expect(prompt).toBe("Names: Moka, oMLX");
  });

  it("posts the file to /audio/transcriptions with the key and hint", async () => {
    const { fetcher, calls } = fakeServer(() => Response.json({ text: " Hello from Moka. ", language: "en", duration: 1.5 }));
    const result = await transcribe(whisper, { name: "a.wav", mediaType: "audio/wav", bytes: silentWav(100) }, { prompt: "Moka", env: { KEY: "k1" }, fetcher });
    expect(result).toMatchObject({ text: "Hello from Moka.", language: "en", duration: 1.5 });
    expect(calls[0]!.url).toBe("http://127.0.0.1:8000/v1/audio/transcriptions");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer k1");
    expect(calls[0]!.form.get("model")).toBe("whisper-large-v3-turbo");
    expect(calls[0]!.form.get("prompt")).toBe("Moka");
    const file = calls[0]!.form.get("file") as File;
    expect(file.name).toBe("a.wav");
    expect(file.type).toBe("audio/wav");
  });

  it("explains a server without the endpoint, and providers that can't transcribe", async () => {
    const { fetcher } = fakeServer(() => Response.json({ error: { message: "Not Found" } }, { status: 404 }));
    await expect(transcribe(whisper, { name: "a.wav", mediaType: "audio/wav", bytes: silentWav(100) }, { fetcher })).rejects.toThrow(/HTTP 404: Not Found\. The server has no \/v1\/audio\/transcriptions endpoint/);
    expect(() => transcriptionUrl(profile("ollama", "whisper"))).toThrow(/Ollama doesn't serve speech-to-text/);
    expect(() => transcriptionUrl(profile("anthropic", "whisper"))).toThrow(/not with anthropic/);
    expect(transcriptionUrl(profile("openai", "whisper-1"))).toBe("https://api.openai.com/v1/audio/transcriptions");
  });

  it("replies with the text, or says what to attach", async () => {
    const bus = new EventBus();
    const { fetcher } = fakeServer(() => Response.json({ text: "Testing one two three." }));
    const chunks = [];
    for await (const c of runTranscription({ runId: "r1", llm: whisper, bus, fetcher, messages: [{ role: "user", content: [{ type: "file", data: wavDataUrl, mediaType: "audio/wav", filename: "memo.wav" }] }] as any })) chunks.push(c);
    expect(chunks.map((c) => c.type)).toEqual(["start", "text", "finish"]);
    expect(chunks[1]).toEqual({ type: "text", text: "Testing one two three." });
    expect((chunks[2] as any).messages).toEqual([{ role: "assistant", content: "Testing one two three." }]);
    const request = bus.history().find((e) => e.kind === "llm.request")!;
    expect((request.data as any).messages[0].content[0]).toMatchObject({ type: "file", mediaType: "audio/wav" });
    expect((bus.history().find((e) => e.kind === "llm.response")!.data as any).output).toEqual({ text: "Testing one two three." });

    const empty = [];
    for await (const c of runTranscription({ runId: "r2", llm: whisper, bus, fetcher, messages: [{ role: "user", content: "hello?" }] })) empty.push(c);
    expect(empty.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/speech-to-text model: attach an audio file/) });
  });

  it("makes a valid silent WAV for the connection test", () => {
    const wav = Buffer.from(silentWav(500));
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.length).toBe(44 + 8000 * 2);
  });
});
