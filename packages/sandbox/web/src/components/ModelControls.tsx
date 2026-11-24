import { Brain, Check, Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { Attachment, LlmProfile, ReasoningControl } from "../types";
import { uid } from "../runner";
import { cn } from "./ui";

type Level = NonNullable<LlmProfile["reasoning"]>;

const LEVELS: Record<Exclude<ReasoningControl, "always">, Array<{ value: Level; label: string; hint: string }>> = {
  levels: [
    { value: "auto", label: "Auto", hint: "The model's usual effort" },
    { value: "off", label: "Off", hint: "Answer without thinking, as far as the model allows" },
    { value: "low", label: "Low", hint: "Think briefly: faster, fewer tokens" },
    { value: "medium", label: "Medium", hint: "Balanced" },
    { value: "high", label: "High", hint: "Think hard: slower, best for tricky problems" },
  ],
  toggle: [
    { value: "auto", label: "On", hint: "Think before answering" },
    { value: "off", label: "Off", hint: "Answer straight away" },
  ],
};

const LABEL: Record<Level, string> = { auto: "Auto", off: "Off", low: "Low", medium: "Medium", high: "High" };

/**
 * How hard the model thinks, from the chat input. Only for models that can
 * think; the choice is the model's Reasoning setting (Settings → Models).
 */
export function ReasoningPicker({ llm, control }: { llm: LlmProfile; control: ReasoningControl }) {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current: Level = llm.reasoning ?? "auto";
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (control === "always") {
    return (
      <span title={`${llm.model} always thinks before answering; its effort can't be set.`} className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-muted">
        <Brain className="h-3.5 w-3.5" />
        Thinks
      </span>
    );
  }
  const options = LEVELS[control];
  const shown = control === "toggle" ? (current === "off" ? "Off" : "On") : LABEL[current];
  const choose = (value: Level) => {
    setOpen(false);
    if (value === current) return;
    const llms = config.llms.map((l) => (l.id === llm.id ? { ...l, reasoning: value === "auto" ? undefined : value } : l));
    void saveConfig({ ...config, llms }, `${llm.name}: thinking ${value === "auto" ? (control === "toggle" ? "on" : "auto") : value}`);
  };
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`How much ${llm.model} thinks before answering`}
        onClick={() => setOpen(!open)}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-colors",
          current !== "auto" && current !== "off" ? "border-violet/40 bg-violet/10 text-violet" : "border-transparent text-muted hover:bg-panel-2 hover:text-fg",
          open && "bg-panel-2 text-fg",
        )}
      >
        <Brain className="h-3.5 w-3.5" />
        Thinking: {shown}
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full left-0 z-30 mb-2 w-64 rounded-xl border border-line bg-elev p-1 shadow-soft">
          <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-subtle uppercase">Thinking · {llm.name}</div>
          {options.map((o) => (
            <button key={o.value} role="menuitemradio" aria-checked={o.value === current} onClick={() => choose(o.value)} className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-panel-2">
              <Check className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 text-accent", o.value !== current && "invisible")} />
              <span>
                <span className="block text-[13px]">{o.label}</span>
                <span className="block text-[11.5px] text-muted">{o.hint}</span>
              </span>
            </button>
          ))}
          <div className="border-t border-line px-2.5 pt-1.5 pb-1 text-[11px] text-subtle">Saved for this model. Takes effect from the next message.</div>
        </div>
      )}
    </div>
  );
}

/** 16-bit mono PCM WAV: every speech-to-text server reads it. */
function encodeWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const str = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i]!)) * 0x7fff, true);
  return new Blob([buffer], { type: "audio/wav" });
}

/** Whatever the browser recorded (WebM/Opus, MP4/AAC), as 16 kHz mono WAV. */
async function toWav(recording: Blob): Promise<Blob> {
  const decoded = await new AudioContext().decodeAudioData(await recording.arrayBuffer());
  const rate = 16_000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  return encodeWav((await offline.startRendering()).getChannelData(0), rate);
}

const readDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/** Record from the microphone; the take is attached as a WAV file. */
export function RecordButton({ onRecorded, disabled }: { onRecorded: (attachment: Attachment) => void; disabled?: boolean }) {
  const toast = useStore((s) => s.toast);
  const [recording, setRecording] = useState<{ recorder: MediaRecorder; since: number }>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => () => recording?.recorder.stream.getTracks().forEach((t) => t.stop()), [recording]);

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("This browser can't record here. The microphone needs https or localhost.", "error");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        try {
          const wav = await toWav(new Blob(chunks, { type: recorder.mimeType }));
          const name = `recording-${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}.wav`;
          onRecorded({ id: uid("f"), name, mediaType: "audio/wav", size: wav.size, kind: "file", dataUrl: await readDataUrl(wav) });
        } catch (error: any) {
          toast(`Couldn't use the recording: ${error?.message ?? error}`, "error");
        }
      };
      recorder.start();
      setNow(Date.now());
      setRecording({ recorder, since: Date.now() });
    } catch (error: any) {
      toast(error?.name === "NotAllowedError" ? "Microphone access was denied. Allow it in the browser's site settings." : `Couldn't start recording: ${error?.message ?? error}`, "error");
    }
  };
  const stop = () => {
    recording?.recorder.stop();
    setRecording(undefined);
  };

  if (recording) {
    const seconds = Math.floor((now - recording.since) / 1000);
    return (
      <button type="button" onClick={stop} title="Stop recording and attach it" className="inline-flex h-7 items-center gap-1.5 rounded-full border border-err/40 bg-err/10 px-2.5 text-[12px] font-medium text-err">
        <Square className="h-3 w-3 fill-current" />
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-err" />
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      </button>
    );
  }
  return (
    <button type="button" disabled={disabled} onClick={() => void start()} title="Record from the microphone" className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-muted transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-40">
      <Mic className="h-3.5 w-3.5" />
      Record
    </button>
  );
}

const AUDIO_EXT = /\.(wav|mp3|m4a|mp4|mpeg|mpga|ogg|oga|opus|flac|webm|aac)$/i;
export const AUDIO_ACCEPT = "audio/*,.wav,.mp3,.m4a,.mp4,.mpeg,.mpga,.ogg,.oga,.opus,.flac,.webm,.aac";

export function isAudioFile(file: Pick<File, "type" | "name">): boolean {
  return file.type.startsWith("audio/") || AUDIO_EXT.test(file.name);
}
