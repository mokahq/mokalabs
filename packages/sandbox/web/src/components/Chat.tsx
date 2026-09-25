import {
  AlertTriangle,
  ArrowUp,
  AtSign,
  Database,
  FileText,
  Paperclip,
  Play,
  Slash,
  X,
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
import { api } from "../api";
import { uid } from "../runner";
import { useStore } from "../store";
import type { Attachment, Part, UiMessage } from "../types";
import dino from "../dino.svg";
import { ApprovalBar, usePendingApproval } from "./Interactions";
import { Markdown } from "./Markdown";
import { ToolUi } from "./ToolUi";
import { Badge, Button, CopyButton, IconButton, JsonView, Kbd, Spinner, cn, formatMs, formatNumber } from "./ui";

export function ChatView() {
  const session = useStore((s) => s.session);
  const streaming = useStore((s) => s.streaming);
  const presenter = useStore((s) => s.presenter);
  const replaying = useStore((s) => s.replaying);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [session.messages]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {replaying && (
        <div className="pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2">
          <span className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-accent/30 bg-panel px-3 py-1 text-[12px] text-accent shadow-soft">
            <Play className="h-3 w-3" /> Replaying a saved chat (no model calls)
          </span>
        </div>
      )}
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
  const agent = config.agents.find((a) => a.id === workspace.agentId);
  const llm = agent ? { name: agent.name, model: agent.protocol === "a2a" ? "A2A agent" : "AG-UI agent" } : (config.llms.find((l) => l.id === workspace.llmId) ?? config.llms[0]);
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
  const toast = useStore((s) => s.toast);
  const hasEvents = Boolean(message.meta?.runId && events.some((e) => e.runId === message.meta!.runId));

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
    const files = message.parts.filter((p): p is Extract<Part, { type: "attachment" }> => p.type === "attachment");
    return (
      <div className="animate-in mb-6 flex flex-col items-end gap-1.5">
        {files.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {files.map((f) =>
              f.attachment.kind === "image" && f.attachment.dataUrl ? (
                <img key={f.attachment.id} src={f.attachment.dataUrl} alt={f.attachment.name} className="max-h-48 max-w-64 rounded-xl border border-line object-cover" />
              ) : (
                <AttachmentChip key={f.attachment.id} attachment={f.attachment} />
              ),
            )}
          </div>
        )}
        {text && <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-fg">{text}</div>}
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
          {meta.runId && (
            <button
              className="hover:text-fg"
              title={hasEvents ? "Show this run in the inspector" : "This run's events are no longer in the inspector"}
              onClick={() => {
                const first = events.find((e) => e.runId === meta.runId);
                if (!first) {
                  toast("This run's events aren't in the inspector anymore. Events are kept in memory, so they're cleared when Moka restarts or you press Clear.");
                  return;
                }
                set({ inspectorOpen: true, selectedEventId: first.id });
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
  if (part.type === "attachment") return <AttachmentChip attachment={part.attachment} />;
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
  const approval = usePendingApproval(part.id);
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
        approval ? "border-warn/50" : part.status === "error" ? "border-err/30" : running ? "border-accent/40" : "border-line",
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
        {approval && <Badge tone="warn">waiting for you</Badge>}
        {part.durationMs !== undefined && <span className="font-mono text-[11px] text-subtle">{formatMs(part.durationMs)}</span>}
        <ChevronRight className={cn("h-3.5 w-3.5 text-subtle transition-transform", open && "rotate-90")} />
      </button>
      {(open || approval) && (
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
      {approval && <ApprovalBar approval={approval} />}
    </div>
  );
}

const MAX_ATTACHMENT = 10 * 1024 * 1024;
const TEXT_EXT = /\.(txt|md|mdx|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|sql|log|ini|env)$/i;

function readAs(file: File, as: "text" | "dataUrl"): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    if (as === "text") reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

async function toAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT) throw new Error(`${file.name} is larger than 10 MB`);
  const mediaType = file.type || "application/octet-stream";
  const base = { id: uid("f"), name: file.name || "pasted", mediaType, size: file.size };
  if (mediaType.startsWith("image/")) return { ...base, kind: "image", dataUrl: await readAs(file, "dataUrl") };
  if (mediaType.startsWith("text/") || mediaType.includes("json") || TEXT_EXT.test(file.name)) return { ...base, kind: "text", text: await readAs(file, "text") };
  return { ...base, kind: "file", dataUrl: await readAs(file, "dataUrl") };
}

function AttachmentChip({ attachment, onRemove }: { attachment: Pick<Attachment, "name" | "kind" | "dataUrl" | "size" | "uri">; onRemove?: () => void }) {
  return (
    <span className="group inline-flex max-w-56 items-center gap-1.5 rounded-lg border border-line bg-panel-2/70 py-1 pr-1.5 pl-1 text-[12px]">
      {attachment.kind === "image" && attachment.dataUrl ? (
        <img src={attachment.dataUrl} alt="" className="h-7 w-7 rounded object-cover" />
      ) : attachment.kind === "resource" ? (
        <Database className="ml-1 h-3.5 w-3.5 text-info" />
      ) : (
        <FileText className="ml-1 h-3.5 w-3.5 text-muted" />
      )}
      <span className="truncate" title={attachment.uri ?? attachment.name}>
        {attachment.name}
      </span>
      {onRemove && (
        <button type="button" aria-label={`Remove ${attachment.name}`} onClick={onRemove} className="text-subtle hover:text-err">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

export { AttachmentChip };

type PromptInfo = { serverId: string; serverName: string; name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> };

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
  const toast = useStore((s) => s.toast);
  const workspace = useStore((s) => s.workspace());
  const mcp = useStore((s) => s.mcp);
  const streaming = busy ?? storeStreaming;
  const stop = onStop ?? storeStop;
  const presenter = useStore((s) => s.presenter);
  const hasModel = useStore((s) => s.config.llms.length > 0 || Boolean(s.workspace().agentId && s.config.agents.some((a) => a.id === s.workspace().agentId)));
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [menu, setMenu] = useState<"resources" | undefined>();
  const [prompt, setPrompt] = useState<PromptInfo>();
  const [promptArgs, setPromptArgs] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const rich = !onSend; // attachments, resources and prompts only in the main chat

  const servers = workspace.mcpServerIds.map((id) => mcp[id]).filter((s): s is NonNullable<typeof s> => s?.status === "connected");
  const resources = servers.flatMap((s) => s.resources.map((r) => ({ ...r, serverId: s.id, serverName: s.name })));
  const prompts: PromptInfo[] = servers.flatMap((s) => s.prompts.map((p) => ({ ...p, serverId: s.id, serverName: s.name })));
  const slash = rich && /^\/[\w.-]*$/.test(text) ? text.slice(1).toLowerCase() : undefined;
  const promptMatches = slash !== undefined ? prompts.filter((p) => p.name.toLowerCase().includes(slash)) : [];

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => {
    setMenu(undefined);
    setPrompt(undefined);
  }, [workspace.id]);

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

  const addFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      try {
        const attachment = await toAttachment(file);
        setAttachments((a) => [...a, attachment]);
      } catch (e: any) {
        toast(e?.message ?? `Could not read ${file.name}`, "error");
      }
    }
  };

  const attachResource = async (r: (typeof resources)[number]) => {
    setMenu(undefined);
    try {
      const { result } = await api<{ result: any }>(`/api/mcp/${encodeURIComponent(r.serverId)}/resource`, { body: { uri: r.uri } });
      const content = (result?.contents ?? []).map((c: any) => c.text ?? (c.blob ? `[binary ${c.mimeType ?? ""}]` : "")).join("\n");
      setAttachments((a) => [...a, { id: uid("r"), name: r.title ?? r.name ?? r.uri, mediaType: r.mimeType ?? "text/plain", size: content.length, kind: "resource", text: content, uri: r.uri, serverId: r.serverId }]);
    } catch (e: any) {
      toast(e?.message ?? "Could not read resource", "error");
    }
  };

  const usePrompt = async (p: PromptInfo, args: Record<string, string>) => {
    try {
      const { result } = await api<{ result: any }>(`/api/mcp/${encodeURIComponent(p.serverId)}/prompt`, { body: { name: p.name, args } });
      const body = (result?.messages ?? [])
        .map((m: any) => {
          const blocks = Array.isArray(m.content) ? m.content : [m.content];
          const t = blocks.map((b: any) => b?.text ?? (b?.resource?.text ? `<resource uri="${b.resource.uri}">\n${b.resource.text}\n</resource>` : "")).join("\n");
          return result.messages.length > 1 && m.role === "assistant" ? `Assistant: ${t}` : t;
        })
        .join("\n\n");
      setText(body);
      setPrompt(undefined);
      setPromptArgs({});
      ref.current?.focus();
    } catch (e: any) {
      toast(e?.message ?? "Could not load prompt", "error");
    }
  };

  const pickPrompt = (p: PromptInfo) => {
    if (p.arguments?.length) {
      setPrompt(p);
      setText("");
    } else void usePrompt(p, {});
  };

  const submit = () => {
    if ((!text.trim() && attachments.length === 0) || streaming || !hasModel) return;
    if (slash !== undefined && promptMatches.length) {
      pickPrompt(promptMatches[0]!);
      return;
    }
    if (onSend) onSend(text);
    else void send(text, { attachments });
    setText("");
    setAttachments([]);
    setMenu(undefined);
  };

  return (
    <div className={cn("shrink-0 px-5 pb-5", compact ? "pt-2" : "pt-1")}>
      <div className={cn("relative mx-auto w-full", presenter ? "max-w-4xl" : "max-w-3xl")}>
        {slash !== undefined && promptMatches.length > 0 && (
          <div className="absolute right-0 bottom-full left-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-line bg-elev p-1 shadow-soft">
            <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-subtle uppercase">MCP prompts</div>
            {promptMatches.map((p) => (
              <button key={`${p.serverId}/${p.name}`} onClick={() => pickPrompt(p)} className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-panel-2">
                <Slash className="mt-0.5 h-3.5 w-3.5 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[12.5px]">{p.name}</span>
                  {p.description && <span className="block truncate text-[11.5px] text-muted">{p.description}</span>}
                </span>
                <span className="text-[11px] text-subtle">{p.serverName}</span>
              </button>
            ))}
          </div>
        )}
        {prompt && (
          <form
            className="absolute right-0 bottom-full left-0 z-20 mb-2 space-y-2 rounded-xl border border-line bg-elev p-3 shadow-soft"
            onSubmit={(e) => {
              e.preventDefault();
              void usePrompt(prompt, promptArgs);
            }}
          >
            <div className="flex items-center gap-2 text-[13px]">
              <Slash className="h-3.5 w-3.5 text-accent" />
              <span className="font-mono font-medium">{prompt.name}</span>
              <span className="text-subtle">· {prompt.serverName}</span>
              <span className="flex-1" />
              <button type="button" onClick={() => setPrompt(undefined)} className="text-subtle hover:text-fg" aria-label="Close">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {prompt.arguments!.map((arg, i) => (
              <input
                key={arg.name}
                autoFocus={i === 0}
                value={promptArgs[arg.name] ?? ""}
                onChange={(e) => setPromptArgs((a) => ({ ...a, [arg.name]: e.target.value }))}
                placeholder={`${arg.name}${arg.required ? " *" : ""}${arg.description ? ` · ${arg.description}` : ""}`}
                className="h-8 w-full rounded-lg border border-line bg-panel px-2.5 text-[13px] focus:border-accent/60 focus:outline-none"
              />
            ))}
            <Button size="xs" variant="primary" type="submit" disabled={prompt.arguments!.some((a) => a.required && !promptArgs[a.name])}>
              Insert prompt
            </Button>
          </form>
        )}
        {menu === "resources" && (
          <div className="absolute right-0 bottom-full left-0 z-20 mb-2 max-h-72 overflow-y-auto rounded-xl border border-line bg-elev p-1 shadow-soft">
            <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-subtle uppercase">Attach an MCP resource</div>
            {resources.length === 0 && <p className="px-2.5 py-2 text-[12.5px] text-muted">No resources on this workspace's servers.</p>}
            {resources.map((r) => (
              <button key={`${r.serverId}/${r.uri}`} onClick={() => attachResource(r)} className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-panel-2">
                <Database className="mt-0.5 h-3.5 w-3.5 text-info" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px]">{r.title ?? r.name ?? r.uri}</span>
                  <span className="block truncate font-mono text-[11px] text-subtle">{r.uri}</span>
                </span>
                <span className="text-[11px] text-subtle">{r.serverName}</span>
              </button>
            ))}
          </div>
        )}
        <div
          onDragOver={(e) => {
            if (!rich || !e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            if (!rich) return;
            e.preventDefault();
            setDragging(false);
            void addFiles(e.dataTransfer.files);
          }}
          className={cn("rounded-2xl border bg-panel shadow-soft transition-colors focus-within:border-accent/50", dragging ? "border-accent border-dashed" : "border-line")}
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {attachments.map((a) => (
                <AttachmentChip key={a.id} attachment={a} onRemove={() => setAttachments((list) => list.filter((x) => x.id !== a.id))} />
              ))}
            </div>
          )}
          <textarea
            ref={ref}
            rows={1}
            value={text}
            disabled={!hasModel}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              if (!rich) return;
              const files = Array.from(e.clipboardData.files);
              if (files.length) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setMenu(undefined);
                setPrompt(undefined);
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={disabledReason ?? (hasModel ? placeholder ?? (rich && prompts.length ? "Message Moka… (/ for prompts)" : "Message Moka…") : "Add a model in Settings to start chatting")}
            className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed placeholder:text-subtle focus:outline-none"
          />
          <div className="flex items-center gap-1 px-3 pb-2.5">
            {rich && (
              <>
                <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files).then(() => (e.target.value = ""))} />
                <IconButton label="Attach files or images" className="h-7 w-7" disabled={!hasModel} onClick={() => fileInput.current?.click()}>
                  <Paperclip className="h-3.5 w-3.5" />
                </IconButton>
                {resources.length > 0 && (
                  <IconButton label="Attach an MCP resource" className="h-7 w-7" active={menu === "resources"} onClick={() => setMenu(menu ? undefined : "resources")}>
                    <AtSign className="h-3.5 w-3.5" />
                  </IconButton>
                )}
              </>
            )}
            <span className="ml-1 hidden text-[11px] text-subtle sm:inline">
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
                disabled={(!text.trim() && attachments.length === 0) || !hasModel}
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
