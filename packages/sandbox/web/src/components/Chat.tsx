import {
  AlertTriangle,
  ArrowUp,
  Brain,
  ChevronRight,
  Clock,
  Hammer,
  RotateCcw,
  Settings2,
  Sparkles,
  Square,
  Wrench,
  Zap,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type { Part, UiMessage } from "../types";
import dino from "../dino.svg";
import { Markdown } from "./Markdown";
import { ToolUi } from "./ToolUi";
import { Badge, Button, CopyButton, JsonView, Kbd, Spinner, cn, formatMs, formatNumber } from "./ui";

export function ChatView() {
  const session = useStore((s) => s.session);
  const streaming = useStore((s) => s.streaming);
  const presenter = useStore((s) => s.presenter);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [session.messages]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {session.messages.length === 0 ? (
          <EmptyChat />
        ) : (
          <div className={cn("mx-auto w-full px-5 pt-6 pb-10", presenter ? "max-w-4xl" : "max-w-3xl")}>
            {session.messages.map((m, i) => (
              <MessageView key={m.id} message={m} live={streaming && i === session.messages.length - 1} last={i === session.messages.length - 1} />
            ))}
          </div>
        )}
      </div>
      <Composer />
    </div>
  );
}

function EmptyChat() {
  const workspace = useStore((s) => s.workspace());
  const config = useStore((s) => s.config);
  const mcp = useStore((s) => s.mcp);
  const skills = useStore((s) => s.skills);
  const send = useStore((s) => s.send);
  const openSettings = useStore((s) => s.openSettings);
  const llm = config.llms.find((l) => l.id === workspace.llmId) ?? config.llms[0];
  const toolCount = workspace.mcpServerIds.reduce((n, id) => n + (mcp[id]?.tools.length ?? 0), 0);
  const wsSkills = skills.filter((s) => workspace.skillIds.includes(s.id));

  return (
    <div className="relative flex min-h-full flex-col items-center justify-center px-6 py-16">
      <div className="glow pointer-events-none absolute inset-x-0 top-0 h-80" />
      <div className="relative w-full max-w-2xl text-center">
        <img src={dino} alt="Moka the dino" className="mx-auto mb-3 h-28 w-28 drop-shadow-[0_12px_24px_rgba(0,0,0,0.25)]" />
        <h1 className="text-2xl font-semibold tracking-tight">{workspace.name === "Default" ? "What are we brewing?" : workspace.name}</h1>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5 text-[13px] text-muted">
          {llm ? (
            <Badge tone="accent">
              <Zap className="h-3 w-3" /> {llm.name} · {llm.model}
            </Badge>
          ) : (
            <button onClick={() => openSettings("models")}>
              <Badge tone="warn">
                <AlertTriangle className="h-3 w-3" /> No model — add one
              </Badge>
            </button>
          )}
          <button onClick={() => openSettings("mcp")}>
            <Badge tone="info">
              <Wrench className="h-3 w-3" /> {toolCount} tools · {workspace.mcpServerIds.length} servers
            </Badge>
          </button>
          <button onClick={() => openSettings("skills")}>
            <Badge tone="violet">
              <Sparkles className="h-3 w-3" /> {wsSkills.length} skills
            </Badge>
          </button>
        </div>

        {!llm && (
          <div className="mx-auto mt-8 max-w-md rounded-xl border border-line bg-panel p-5 text-left shadow-soft">
            <p className="text-sm font-medium">Connect a model to start</p>
            <p className="mt-1 text-[13px] text-muted">
              Set <code className="font-mono text-accent">OPENAI_API_KEY</code>, <code className="font-mono text-accent">ANTHROPIC_API_KEY</code> or run Ollama and restart — or add any provider in a few clicks.
            </p>
            <Button className="mt-4" variant="primary" icon={<Settings2 className="h-4 w-4" />} onClick={() => openSettings("models")}>
              Add a model
            </Button>
          </div>
        )}

        {llm && (workspace.starterPrompts?.length ?? 0) > 0 && (
          <div className="mt-8 grid gap-2 sm:grid-cols-2">
            {workspace.starterPrompts!.map((prompt) => (
              <button
                key={prompt}
                onClick={() => send(prompt)}
                className="group rounded-xl border border-line bg-panel px-4 py-3 text-left text-[13px] text-muted shadow-sm transition-all hover:-translate-y-px hover:border-accent/40 hover:text-fg"
              >
                <span className="line-clamp-2">{prompt}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MessageView({ message, live, last }: { message: UiMessage; live: boolean; last: boolean }) {
  const retry = useStore((s) => s.retry);
  const openSettings = useStore((s) => s.openSettings);
  const set = useStore((s) => s.set);
  const events = useStore((s) => s.events);

  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    if (message.meta?.via) {
      return (
        <div className="animate-in mb-6 flex justify-end">
          <div className="inline-flex max-w-[85%] items-center gap-2 rounded-full border border-accent/30 bg-accent-soft/60 px-3.5 py-1.5 text-[13px] text-accent">
            <Sparkles className="h-3.5 w-3.5" />
            <span className="truncate">{message.meta.via === "a2ui" ? text : `From app: ${text}`}</span>
          </div>
        </div>
      );
    }
    return (
      <div className="animate-in mb-6 flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-fg">{text}</div>
      </div>
    );
  }

  const meta = message.meta ?? {};
  const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  const empty = message.parts.length === 0;
  const toolParts = message.parts.filter((p) => p.type === "tool").length;

  return (
    <div className="animate-in group mb-8">
      <div className="space-y-3 text-[15px]">
        {empty && live && (
          <div className="flex items-center gap-2 text-sm">
            <Spinner className="text-accent" />
            <span className="shimmer font-medium">Thinking…</span>
          </div>
        )}
        {message.parts.map((part, i) => (
          <PartView key={i} part={part} live={live && i === message.parts.length - 1} />
        ))}
        {meta.error && (
          <div className="flex items-start gap-3 rounded-xl border border-err/25 bg-err/5 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-err" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-err">{meta.error === "Stopped" ? "Stopped" : "Something went wrong"}</p>
              {meta.error !== "Stopped" && <p className="mt-0.5 break-words text-muted">{meta.error}</p>}
              {last && (
                <div className="mt-2 flex gap-2">
                  <Button size="xs" variant="outline" icon={<RotateCcw className="h-3 w-3" />} onClick={() => retry()}>
                    Retry
                  </Button>
                  {meta.error !== "Stopped" && (
                    <Button size="xs" variant="ghost" onClick={() => openSettings("models")}>
                      Check model settings
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {!live && !empty && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-subtle opacity-70 transition-opacity group-hover:opacity-100">
          {meta.model && <span className="font-medium">{meta.model}</span>}
          {meta.durationMs !== undefined && (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatMs(meta.durationMs)}
            </span>
          )}
          {meta.firstTokenMs !== undefined && <span>TTFT {formatMs(meta.firstTokenMs)}</span>}
          {meta.usage?.totalTokens !== undefined && (
            <span>
              {formatNumber(meta.usage.inputTokens)} in · {formatNumber(meta.usage.outputTokens)} out
            </span>
          )}
          {toolParts > 0 && (
            <span className="inline-flex items-center gap-1">
              <Hammer className="h-3 w-3" />
              {toolParts} tool {toolParts === 1 ? "call" : "calls"}
            </span>
          )}
          {meta.steps ? <span>{meta.steps} steps</span> : null}
          <span className="flex-1" />
          {meta.runId && events.some((e) => e.runId === meta.runId) && (
            <button
              className="hover:text-fg"
              onClick={() => {
                const first = events.find((e) => e.runId === meta.runId);
                set({ inspectorOpen: true, selectedEventId: first?.id });
              }}
            >
              Inspect run →
            </button>
          )}
          {text && <CopyButton text={text} className="h-6 w-6" />}
        </div>
      )}
    </div>
  );
}

function PartView({ part, live }: { part: Part; live: boolean }) {
  if (part.type === "text") return <Markdown text={part.text} className={live ? "caret" : undefined} />;
  if (part.type === "reasoning") return <Reasoning text={part.text} live={live} />;
  if (!part.ui) return <ToolCard part={part} />;
  return (
    <div className="space-y-2">
      <ToolCard part={part} />
      <ToolUi part={part} />
    </div>
  );
}

function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-line bg-panel-2/60">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-[13px] text-muted" onClick={() => setOpen(!open)}>
        <Brain className="h-3.5 w-3.5" />
        <span className={cn("font-medium", live && "shimmer")}>{live ? "Reasoning…" : "Reasoning"}</span>
        <ChevronRight className={cn("ml-auto h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
      </button>
      {open && <div className="border-t border-line px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-muted">{text}</div>}
    </div>
  );
}

export function ToolCard({ part }: { part: Extract<Part, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const running = part.status === "running";
  const inputPreview = useMemo(() => {
    const s = JSON.stringify(part.input ?? {});
    return s === "{}" ? "" : s.length > 80 ? `${s.slice(0, 80)}…` : s;
  }, [part.input]);
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-panel transition-colors",
        part.status === "error" ? "border-err/30" : running ? "border-accent/40" : "border-line",
      )}
    >
      <button className="flex w-full items-center gap-2.5 px-3 py-2 text-left" onClick={() => setOpen(!open)}>
        <div
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
            part.status === "error" ? "bg-err/10 text-err" : running ? "bg-accent-soft text-accent" : "bg-ok/10 text-ok",
          )}
        >
          {running ? <Spinner /> : part.source === "skills" ? <Sparkles className="h-3.5 w-3.5" /> : <Wrench className="h-3.5 w-3.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="font-mono font-medium">{part.tool}</span>
            <span className="truncate text-subtle">{part.source}</span>
          </div>
          {!open && inputPreview && <div className="truncate font-mono text-[11px] text-subtle">{inputPreview}</div>}
        </div>
        {part.durationMs !== undefined && <span className="font-mono text-[11px] text-subtle">{formatMs(part.durationMs)}</span>}
        <ChevronRight className={cn("h-3.5 w-3.5 text-subtle transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-line bg-panel-2/40 p-3">
          <div>
            <div className="mb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">Input</div>
            <JsonView value={part.input ?? {}} maxHeight="14rem" />
          </div>
          {part.output !== undefined && (
            <div>
              <div className={cn("mb-1 text-[11px] font-medium tracking-wide uppercase", part.isError ? "text-err" : "text-subtle")}>
                {part.isError ? "Error" : "Output"}
              </div>
              <JsonView value={part.output} maxHeight="18rem" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Composer({
  onSend,
  onStop,
  busy,
  disabledReason,
  placeholder,
  compact,
}: {
  onSend?: (text: string) => void;
  onStop?: () => void;
  busy?: boolean;
  disabledReason?: string;
  placeholder?: string;
  compact?: boolean;
}) {
  const send = useStore((s) => s.send);
  const storeStop = useStore((s) => s.stop);
  const storeStreaming = useStore((s) => s.streaming);
  const streaming = busy ?? storeStreaming;
  const stop = onStop ?? storeStop;
  const presenter = useStore((s) => s.presenter);
  const hasModel = useStore((s) => s.config.llms.length > 0);
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => {
    const focus = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement === document.body) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, []);

  const submit = () => {
    if (!text.trim() || streaming || !hasModel) return;
    (onSend ?? send)(text);
    setText("");
  };

  return (
    <div className={cn("shrink-0 px-5 pb-5", compact ? "pt-2" : "pt-1")}>
      <div className={cn("mx-auto w-full", presenter ? "max-w-4xl" : "max-w-3xl")}>
        <div className="rounded-2xl border border-line bg-panel shadow-soft transition-colors focus-within:border-accent/50">
          <textarea
            ref={ref}
            rows={1}
            value={text}
            disabled={!hasModel}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={disabledReason ?? (hasModel ? placeholder ?? "Message Moka…" : "Add a model in Settings to start chatting")}
            className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed placeholder:text-subtle focus:outline-none"
          />
          <div className="flex items-center gap-2 px-3 pb-2.5">
            <span className="hidden text-[11px] text-subtle sm:inline">
              <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> newline
            </span>
            <span className="flex-1" />
            {streaming ? (
              <Button size="sm" variant="secondary" icon={<Square className="h-3 w-3 fill-current" />} onClick={stop}>
                Stop
              </Button>
            ) : (
              <button
                aria-label="Send"
                disabled={!text.trim() || !hasModel}
                onClick={submit}
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-fg transition-all hover:brightness-110 disabled:opacity-30"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
