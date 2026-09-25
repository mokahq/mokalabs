import {
  AlertCircle,
  AppWindow,
  MousePointerClick,
  ArrowDownLeft,
  ArrowUpRight,
  Ban,
  Bot,
  ChevronLeft,
  Download,
  Flag,
  PauseCircle,
  PlayCircle,
  Plug,
  ScrollText,
  Search,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type { MokaEvent } from "../types";
import { IconButton, Input, JsonView, Tabs, cn, formatMs } from "./ui";

type Filter = "all" | "llm" | "tools" | "rpc" | "logs";

const FILTERS: Record<Filter, (e: MokaEvent) => boolean> = {
  all: () => true,
  llm: (e) => e.kind.startsWith("llm.") || e.kind.startsWith("run."),
  tools: (e) => e.kind.startsWith("tool.") || e.kind === "skill.load" || e.kind.startsWith("ui."),
  rpc: (e) => e.kind === "mcp.rpc",
  logs: (e) => e.kind === "mcp.log" || e.kind === "mcp.status" || e.kind === "log" || e.level === "error",
};

function meta(e: MokaEvent): { icon: React.ReactNode; tone: string } {
  const i = "h-3.5 w-3.5";
  if (e.level === "error" || e.kind.endsWith(".error")) return { icon: <AlertCircle className={i} />, tone: "text-err bg-err/10" };
  switch (e.kind) {
    case "run.start":
      return { icon: <PlayCircle className={i} />, tone: "text-accent bg-accent-soft" };
    case "run.finish":
      return { icon: <Flag className={i} />, tone: "text-ok bg-ok/10" };
    case "llm.request":
    case "llm.response":
      return { icon: <Bot className={i} />, tone: "text-violet bg-violet/10" };
    case "tool.call":
    case "tool.result":
      return { icon: <Wrench className={i} />, tone: "text-info bg-info/10" };
    case "skill.load":
      return { icon: <Sparkles className={i} />, tone: "text-violet bg-violet/10" };
    case "ui.rpc":
      return { icon: <AppWindow className={i} />, tone: "text-accent bg-accent-soft" };
    case "ui.action":
      return { icon: <MousePointerClick className={i} />, tone: "text-accent bg-accent-soft" };
    case "mcp.rpc":
      return e.direction === "out"
        ? { icon: <ArrowUpRight className={i} />, tone: "text-muted bg-panel-2" }
        : { icon: <ArrowDownLeft className={i} />, tone: "text-muted bg-panel-2" };
    case "mcp.status":
      return { icon: <Plug className={i} />, tone: "text-warn bg-warn/10" };
    default:
      return { icon: <ScrollText className={i} />, tone: "text-subtle bg-panel-2" };
  }
}

function time(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function Inspector() {
  const events = useStore((s) => s.events);
  const connected = useStore((s) => s.eventsConnected);
  const selectedId = useStore((s) => s.selectedEventId);
  const set = useStore((s) => s.set);
  const clear = useStore((s) => s.clearEvents);
  const config = useStore((s) => s.config);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<MokaEvent[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const source = paused && frozen ? frozen : events;
  const serverName = (id?: string) => config.mcpServers.find((s) => s.id === id)?.name ?? id;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return source.filter(FILTERS[filter]).filter((e) => {
      if (!q) return true;
      return e.title.toLowerCase().includes(q) || e.kind.includes(q) || (e.data !== undefined && JSON.stringify(e.data).toLowerCase().includes(q));
    });
  }, [source, filter, query]);
  const visible = filtered.slice(-600);
  const selected = selectedId ? events.find((e) => e.id === selectedId) : undefined;

  const stats = useMemo(() => {
    let tokens = 0;
    let tools = 0;
    let errors = 0;
    for (const e of events) {
      if (e.kind === "run.finish") tokens += (e.data as any)?.totalTokens ?? 0;
      if (e.kind === "tool.call") tools++;
      if (e.level === "error") errors++;
    }
    return { tokens, tools, errors };
  }, [events]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  const download = () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `moka-trace-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (selected) {
    const m = meta(selected);
    const related = selected.runId ? events.filter((e) => e.runId === selected.runId) : [];
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <IconButton label="Back" onClick={() => set({ selectedEventId: undefined })}>
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
          <span className={cn("flex h-6 w-6 items-center justify-center rounded-md", m.tone)}>{m.icon}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{selected.title}</div>
            <div className="font-mono text-[11px] text-subtle">
              {selected.kind} · {time(selected.ts)}
              {selected.durationMs !== undefined && ` · ${formatMs(selected.durationMs)}`}
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
          <div className="grid grid-cols-2 gap-2 text-[12px]">
            {selected.serverId && <Meta label="Server" value={serverName(selected.serverId)} />}
            {selected.runId && <Meta label="Run" value={selected.runId} mono />}
            {selected.direction && <Meta label="Direction" value={selected.direction === "out" ? "client → server" : "server → client"} />}
            {selected.level && <Meta label="Level" value={selected.level} />}
          </div>
          <div>
            <div className="mb-1.5 text-[11px] font-medium tracking-wide text-subtle uppercase">Payload</div>
            {selected.data === undefined ? <p className="text-[13px] text-muted">No payload</p> : <JsonView value={selected.data} maxHeight="60vh" />}
          </div>
          {related.length > 1 && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium tracking-wide text-subtle uppercase">This run</div>
              <Waterfall events={related} selectedId={selected.id} onSelect={(id) => set({ selectedEventId: id })} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-line px-3 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold">Inspector</h2>
          <span className={cn("h-1.5 w-1.5 rounded-full", connected ? "bg-ok" : "bg-err animate-pulse")} title={connected ? "Live" : "Reconnecting"} />
          <span className="flex-1" />
          <IconButton
            label={paused ? "Resume" : "Pause"}
            onClick={() => {
              setFrozen(paused ? null : events);
              setPaused(!paused);
            }}
            className="h-7 w-7"
          >
            {paused ? <PlayCircle className="h-3.5 w-3.5 text-warn" /> : <PauseCircle className="h-3.5 w-3.5" />}
          </IconButton>
          <IconButton label="Download trace" onClick={download} className="h-7 w-7">
            <Download className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Clear" onClick={() => clear()} className="h-7 w-7">
            <Ban className="h-3.5 w-3.5" />
          </IconButton>
        </div>
        <div className="grid grid-cols-3 gap-1.5 text-center">
          <Stat label="tokens" value={stats.tokens.toLocaleString()} />
          <Stat label="tool calls" value={String(stats.tools)} />
          <Stat label="errors" value={String(stats.errors)} tone={stats.errors ? "text-err" : undefined} />
        </div>
        <Tabs
          size="sm"
          value={filter}
          onChange={setFilter}
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          items={[
            { value: "all", label: "All" },
            { value: "llm", label: "LLM" },
            { value: "tools", label: "Tools" },
            { value: "rpc", label: "RPC" },
            { value: "logs", label: "Logs" },
          ]}
        />
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter events…" className="h-8 pl-8 text-[13px]" />
        </div>
      </div>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto py-1"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {visible.length === 0 ? (
          <div className="px-6 py-12 text-center text-[13px] text-muted">
            {events.length === 0 ? "Events show up here as you chat: model steps, tool calls, and raw MCP JSON-RPC." : "No events match this filter."}
          </div>
        ) : (
          visible.map((e, i) => {
            const m = meta(e);
            const prev = visible[i - 1];
            const newRun = e.kind === "run.start" && prev;
            return (
              <div key={e.id}>
                {newRun && <div className="mx-3 my-1.5 border-t border-dashed border-line" />}
                <button
                  onClick={() => set({ selectedEventId: e.id })}
                  className="group flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-panel-2"
                >
                  <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded", m.tone)}>{m.icon}</span>
                  <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", e.kind === "mcp.rpc" && "font-mono text-[11.5px] text-muted")}>
                    {e.kind === "mcp.rpc" && <span className="text-subtle">{serverName(e.serverId)} </span>}
                    {e.title}
                  </span>
                  {e.durationMs !== undefined && <span className="shrink-0 font-mono text-[10.5px] text-subtle">{formatMs(e.durationMs)}</span>}
                  <span className="hidden shrink-0 font-mono text-[10px] text-subtle group-hover:inline">{time(e.ts).slice(0, 8)}</span>
                </button>
              </div>
            );
          })
        )}
      </div>
      {paused && <div className="border-t border-line bg-warn/10 px-3 py-1.5 text-center text-[11px] text-warn">Paused — new events are buffered</div>}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2/60 px-2 py-1.5">
      <div className={cn("font-mono text-[13px] font-semibold", tone)}>{value}</div>
      <div className="text-[10px] text-subtle">{label}</div>
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-panel-2/60 px-2.5 py-1.5">
      <div className="text-[10px] text-subtle uppercase">{label}</div>
      <div className={cn("truncate", mono && "font-mono text-[11px]")}>{value}</div>
    </div>
  );
}

/** Timeline of a run's timed events, like a network waterfall. */
function Waterfall({ events, selectedId, onSelect }: { events: MokaEvent[]; selectedId: string; onSelect: (id: string) => void }) {
  const timed = events.filter((e) => e.kind !== "mcp.rpc");
  const start = Math.min(...timed.map((e) => e.ts - (e.durationMs ?? 0)));
  const end = Math.max(...timed.map((e) => e.ts));
  const span = Math.max(end - start, 1);
  return (
    <div className="space-y-1 rounded-lg border border-line bg-panel-2/40 p-2">
      {timed.map((e) => {
        const begin = e.ts - (e.durationMs ?? 0);
        const left = ((begin - start) / span) * 100;
        const width = Math.max(((e.durationMs ?? 0) / span) * 100, 0.8);
        const bar =
          e.level === "error" || e.kind.endsWith(".error")
            ? "bg-err"
            : e.kind.startsWith("llm.")
              ? "bg-violet"
              : e.kind.startsWith("tool.")
                ? "bg-info"
                : e.kind === "run.finish"
                  ? "bg-ok"
                  : "bg-accent";
        return (
          <button key={e.id} onClick={() => onSelect(e.id)} className={cn("grid w-full grid-cols-[1fr_1.2fr] items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-panel-2", e.id === selectedId && "bg-panel-2")}>
            <span className="truncate text-[11px]">{e.title}</span>
            <span className="relative h-3">
              <span className={cn("absolute top-0.5 h-2 rounded-sm opacity-80", bar)} style={{ left: `${left}%`, width: `${width}%`, minWidth: 3 }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
