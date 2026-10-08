import { ArrowDownLeft, ArrowUpRight, Cable, Circle, Download, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { MokaEvent, ProxySession } from "../types";
import { EventDetail, requestStatus } from "./Inspector";
import { CopyButton, IconButton, cn, formatMs } from "./ui";

type Filter = "all" | "tools" | "errors" | "notifications" | "logs";

const FILTERS: Record<Filter, { label: string; test: (e: MokaEvent) => boolean }> = {
  all: { label: "All", test: () => true },
  tools: { label: "Tool calls", test: (e) => e.rpc?.method === "tools/call" },
  errors: { label: "Problems", test: (e) => e.level === "warn" || e.level === "error" || e.rpc?.outcome === "error" },
  notifications: { label: "Notifications", test: (e) => e.kind === "mcp.rpc" && !!(e.data as any)?.method && (e.data as any)?.id == null },
  logs: { label: "Server logs", test: (e) => e.kind === "mcp.log" },
};

/** One server as the user thinks of it: a client's server, across restarts (several sessions). */
interface ServerGroup {
  key: string;
  client: string;
  name: string;
  sessions: ProxySession[];
  live: boolean;
  requests: number;
  errors: number;
  timeouts: number;
}

const DETAIL_WIDTH = "moka.proxy.detailWidth";

function savedWidth(): number {
  try {
    const n = Number(localStorage.getItem(DETAIL_WIDTH));
    if (n >= 320) return n;
  } catch {
    // storage blocked
  }
  return Math.round(Math.max(420, window.innerWidth * 0.45));
}

/**
 * Traffic recorded by @mokalabs/proxy between other clients (GitHub Copilot,
 * Cursor, Claude Desktop…) and their MCP servers. Three panes that each scroll
 * on their own: client → server tree, the log, and the selected message.
 */
export function ProxyView() {
  const proxy = useStore((s) => s.proxy);
  const loadProxy = useStore((s) => s.loadProxy);
  const events = useStore((s) => s.events);
  const [selected, setSelected] = useState<{ client: string; key?: string }>();
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string>();
  const [width, setWidth] = useState(savedWidth);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    void loadProxy();
    const timer = setInterval(() => void loadProxy(), 2000);
    return () => clearInterval(timer);
  }, [loadProxy]);

  const clients = useMemo(() => groupSessions(proxy.sessions), [proxy.sessions]);
  const current = selected && clients.find((c) => c.client === selected.client) ? selected : clients[0] && { client: clients[0].client, key: clients[0].servers[0]?.key };
  const client = clients.find((c) => c.client === current?.client);
  const server = client?.servers.find((s) => s.key === current?.key);
  const groups = useMemo(() => (server ? [server] : (client?.servers ?? [])), [server, client]);
  const ids = useMemo(() => new Set(groups.flatMap((g) => g.sessions.map((s) => s.serverId))), [groups]);
  const names = useMemo(() => new Map(groups.flatMap((g) => g.sessions.map((s) => [s.serverId, g.name] as const))), [groups]);

  const { rows, answers } = useMemo(() => {
    const mine = events.filter((e) => e.serverId && ids.has(e.serverId));
    const answers = new Map<string, MokaEvent[]>();
    for (const e of mine) if (e.rpc?.pairId) answers.set(e.rpc.pairId, [...(answers.get(e.rpc.pairId) ?? []), e]);
    // Responses are shown on their request's row; the rest are rows of their own.
    const rows = mine.filter((e) => e.kind !== "mcp.status" && !(e.rpc?.pairId && (e.rpc.outcome === "ok" || e.rpc.outcome === "error"))).filter(FILTERS[filter].test);
    return { rows: rows.slice(-1000), answers };
  }, [events, ids, filter]);
  const open = openId ? events.find((e) => e.id === openId) : undefined;

  // Follow new messages while the log is scrolled to the bottom, never while you're reading above.
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  // ↑/↓ (or j/k) walk the log, Esc closes the detail.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "Escape" && openId) {
        setOpenId(undefined);
        return;
      }
      const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
      if (!step || !rows.length) return;
      e.preventDefault();
      const at = rows.findIndex((r) => r.id === openId);
      const next = rows[at < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + step))]!;
      setOpenId(next.id);
      listRef.current?.querySelector(`[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, openId]);

  const startResize = (down: React.PointerEvent) => {
    down.preventDefault();
    const startX = down.clientX;
    const startWidth = Math.min(width, Math.max(320, window.innerWidth - 560));
    let last = startWidth;
    const move = (e: PointerEvent) => {
      last = Math.round(Math.min(window.innerWidth - 480, Math.max(320, startWidth + startX - e.clientX)));
      setWidth(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.removeProperty("cursor");
      try {
        localStorage.setItem(DETAIL_WIDTH, String(last));
      } catch {
        // storage blocked
      }
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (clients.length === 0) {
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <Waiting dir={proxy.dir} />
      </div>
    );
  }

  const stats = groups.reduce((s, g) => ({ requests: s.requests + g.requests, errors: s.errors + g.errors, timeouts: s.timeouts + g.timeouts }), { requests: 0, errors: 0, timeouts: 0 });
  const latest = server?.sessions[0];
  // A width saved on a bigger screen still leaves room for the log.
  const detailWidth = Math.min(width, Math.max(320, window.innerWidth - 560));
  const choose = (next: { client: string; key?: string }) => {
    setSelected(next);
    setOpenId(undefined);
    stick.current = true;
  };

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <aside className="hidden w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-panel-2/40 p-3 md:flex">
        <div className="flex items-center gap-1 px-1 pb-1">
          <span className="flex-1 text-[11px] font-medium tracking-wide text-subtle uppercase">Clients via proxy</span>
          <IconButton label="Export all sessions (secrets redacted)" className="h-6 w-6" onClick={() => void exportSessions(proxy.sessions.map((s) => s.id), ["all"], true)}>
            <Download className="h-3.5 w-3.5" />
          </IconButton>
        </div>
        {clients.map((c) => (
          <div key={c.client} className="mb-2">
            <button
              type="button"
              onClick={() => choose({ client: c.client })}
              className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-semibold hover:bg-panel-2", current?.client === c.client && !current.key && "bg-panel-2")}
              title="All of this client's servers in one timeline"
            >
              <span className="min-w-0 flex-1 truncate">{c.client}</span>
              <span className="font-mono text-[10.5px] font-normal text-subtle">{c.servers.length} server{c.servers.length === 1 ? "" : "s"}</span>
            </button>
            {c.servers.map((g) => (
              <button
                key={g.key}
                type="button"
                onClick={() => choose({ client: c.client, key: g.key })}
                className={cn("ml-2 flex w-[calc(100%-0.5rem)] flex-col items-start rounded-lg px-2 py-1.5 text-left hover:bg-panel-2", current?.key === g.key && "bg-panel-2")}
              >
                <span className="flex w-full items-center gap-2 font-mono text-[12.5px]">
                  <Circle className={cn("h-2 w-2 shrink-0", g.live ? "fill-ok text-ok" : "fill-subtle text-subtle")} />
                  <span className="min-w-0 flex-1 truncate">{g.name}</span>
                </span>
                <span className={cn("pl-4 text-[11.5px]", g.timeouts || g.errors ? "text-warn" : "text-subtle")}>
                  {g.requests} request{g.requests === 1 ? "" : "s"}
                  {g.timeouts ? ` · ${g.timeouts} timeout${g.timeouts === 1 ? "" : "s"}` : ""}
                  {g.errors ? ` · ${g.errors} error${g.errors === 1 ? "" : "s"}` : ""}
                </span>
              </button>
            ))}
          </div>
        ))}
      </aside>

      {/* On small screens the open message takes the log's place. */}
      <section className={cn("min-h-0 min-w-0 flex-1 flex-col", open ? "hidden lg:flex" : "flex")}>
        <div className="shrink-0 space-y-2.5 border-b border-line px-4 py-3">
          <select
            className="w-full rounded-lg border border-line bg-panel px-2 py-1.5 text-[13px] md:hidden"
            value={current?.key ? `s:${current.key}` : `c:${current?.client ?? ""}`}
            onChange={(e) => {
              const [kind, rest] = [e.target.value.slice(0, 2), e.target.value.slice(2)];
              choose(kind === "c:" ? { client: rest } : { client: rest.split("\u0000")[0]!, key: rest });
            }}
          >
            {clients.map((c) => (
              <optgroup key={c.client} label={c.client}>
                <option value={`c:${c.client}`}>{c.client} · all servers</option>
                {c.servers.map((g) => (
                  <option key={g.key} value={`s:${g.key}`}>
                    {g.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <div className="flex min-w-0 items-baseline gap-x-3">
            <h1 className="shrink-0 text-[16px] font-semibold">{server ? `${client!.client} → ${server.name}` : `${client?.client} · all servers`}</h1>
            {latest && (
              <span className="min-w-0 truncate font-mono text-[11.5px] text-subtle" title={`${[latest.command, ...latest.args].join(" ")}\n${latest.cwd}`}>
                {[latest.command, ...latest.args].join(" ")}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
            <Chip>{stats.requests} requests</Chip>
            {stats.timeouts > 0 && <Chip tone="warn">{stats.timeouts} timeout{stats.timeouts === 1 ? "" : "s"}</Chip>}
            {stats.errors > 0 && <Chip tone="err">{stats.errors} error{stats.errors === 1 ? "" : "s"}</Chip>}
            {latest && <Chip>{latest.live ? "running" : `stopped ${timeAgo(latest.endedAt ?? latest.lastAt)}`}</Chip>}
            {latest?.clientInfo?.name && <Chip>client: {latest.clientInfo.name} {latest.clientInfo.version}</Chip>}
            <span className="flex-1" />
            <ExportMenu onExport={(redact) => void exportSessions(groups.flatMap((g) => g.sessions.map((s) => s.id)), [client?.client, server?.name], redact)} />
            <div className="flex flex-wrap gap-1">
              {(Object.keys(FILTERS) as Filter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => {
                    setFilter(f);
                    stick.current = true;
                  }}
                  className={cn("rounded-md px-2.5 py-1 text-[12.5px] transition-colors", filter === f ? "bg-panel-2 text-fg" : "text-muted hover:text-fg")}
                >
                  {FILTERS[f].label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto px-2 py-2 font-mono text-[12.5px]"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {rows.length === 0 && <p className="px-3 py-6 font-sans text-[13px] text-muted">Nothing here yet. Use the server from your editor and its messages appear as they happen.</p>}
          {rows.map((e) => {
            const status = requestStatus(e, answers);
            const warn = e.level === "warn" || e.level === "error";
            const active = e.id === openId;
            return (
              <button
                key={e.id}
                data-id={e.id}
                type="button"
                onClick={() => setOpenId(active ? undefined : e.id)}
                className={cn("flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left outline-none", active ? "bg-accent/10 ring-1 ring-accent/30" : "hover:bg-panel-2")}
              >
                <span className="w-16 shrink-0 text-[11px] text-subtle">{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span>
                {e.direction === "out" ? <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-accent" /> : e.direction === "in" ? <ArrowDownLeft className="h-3.5 w-3.5 shrink-0 text-info" /> : <span className="w-3.5 shrink-0" />}
                {!server && <span className="shrink-0 rounded bg-panel-2 px-1.5 text-[10.5px] text-muted">{names.get(e.serverId!)}</span>}
                <span className={cn("min-w-0 flex-1 truncate", warn && "text-warn", e.level === "error" && "text-err")}>{e.title}</span>
                {status && <span title={status.title} className={cn("shrink-0 rounded border px-1 text-[10px]", status.tone)}>{status.label}</span>}
                {!status && e.durationMs !== undefined && <span className="shrink-0 text-[10.5px] text-subtle">{formatMs(e.durationMs)}</span>}
              </button>
            );
          })}
        </div>
        <div className="hidden shrink-0 border-t border-line px-4 py-1.5 text-[11px] text-subtle lg:block">
          Click a message, or use ↑ ↓ to walk the log · Esc closes it
        </div>
      </section>

      {open && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize"
            onPointerDown={startResize}
            className="hidden w-1 shrink-0 cursor-col-resize bg-line/60 transition-colors hover:bg-accent/50 lg:block"
          />
          <section className="flex min-h-0 w-full min-w-0 flex-col bg-panel/60 lg:w-[var(--detail-w)] lg:shrink-0" style={{ "--detail-w": `${detailWidth}px` } as React.CSSProperties}>
            <EventDetail event={open} onSelect={setOpenId} onBack={() => setOpenId(undefined)} backIcon={<X className="h-4 w-4" />} backLabel="Close (Esc)" wide={detailWidth >= 640} />
          </section>
        </>
      )}
    </div>
  );
}

/** Download everything recorded for these sessions as one JSON file. */
async function exportSessions(ids: string[], label: Array<string | undefined>, redact: boolean) {
  const { toast } = useStore.getState();
  try {
    const data = await api<{ sessions: Array<{ records: unknown[] }> }>(`/api/proxy/export?ids=${encodeURIComponent(ids.join(","))}${redact ? "" : "&raw=1"}`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const slug = label.filter(Boolean).map((p) => p!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
    a.download = `moka-proxy-${[...slug, new Date().toISOString().slice(0, 19).replace(/:/g, "-")].join("-")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    const records = data.sessions.reduce((n, s) => n + s.records.length, 0);
    toast(`Exported ${data.sessions.length} session${data.sessions.length === 1 ? "" : "s"} (${records} records)${redact ? ", secrets redacted" : ""}`, "success");
  } catch (error: any) {
    toast(error?.message ?? "Could not export the sessions", "error");
  }
}

function ExportMenu({ onExport }: { onExport: (redact: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const pick = (redact: boolean) => {
    setOpen(false);
    onExport(redact);
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] text-muted transition-colors hover:bg-panel-2 hover:text-fg"
        title="Everything recorded for what's shown here, as one JSON file"
      >
        <Download className="h-3.5 w-3.5" />
        Export
      </button>
      {open && (
        <div className="absolute top-full right-0 z-20 mt-1 w-72 rounded-xl border border-line bg-panel p-1 shadow-soft">
          <button type="button" onClick={() => pick(true)} className="w-full rounded-lg px-3 py-2 text-left hover:bg-panel-2">
            <div className="text-[13px] font-medium">Export JSON</div>
            <div className="text-[11.5px] text-muted">Every message and server log. Tokens, keys and passwords redacted: safe to share.</div>
          </button>
          <button type="button" onClick={() => pick(false)} className="w-full rounded-lg px-3 py-2 text-left hover:bg-panel-2">
            <div className="text-[13px] font-medium">Export as recorded</div>
            <div className="text-[11.5px] text-muted">Nothing redacted. Keep it to yourself.</div>
          </button>
        </div>
      )}
    </div>
  );
}

function groupSessions(sessions: ProxySession[]) {
  const byClient = new Map<string, Map<string, ServerGroup>>();
  // Newest first, so each group's first session is its latest.
  for (const s of [...sessions].sort((a, b) => b.startedAt - a.startedAt)) {
    const servers = byClient.get(s.client) ?? new Map<string, ServerGroup>();
    byClient.set(s.client, servers);
    const key = `${s.client}\u0000${s.name}`;
    const group = servers.get(key) ?? { key, client: s.client, name: s.name, sessions: [], live: false, requests: 0, errors: 0, timeouts: 0 };
    servers.set(key, group);
    group.sessions.push(s);
    group.live ||= s.live;
    group.requests += s.requests;
    group.errors += s.errors;
    group.timeouts += s.timeouts;
  }
  return [...byClient.entries()].map(([client, servers]) => ({ client, servers: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name)) }));
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: "warn" | "err" }) {
  return (
    <span className={cn("rounded-full border px-2.5 py-0.5", tone === "warn" ? "border-warn/30 bg-warn/10 text-warn" : tone === "err" ? "border-err/30 bg-err/10 text-err" : "border-line bg-panel-2/60 text-muted")}>
      {children}
    </span>
  );
}

function timeAgo(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(at).toLocaleDateString();
}

/** Before any client has used a wrapped server. */
function Waiting({ dir }: { dir?: string }) {
  const steps = [
    { title: "Wrap your servers", hint: "Finds VS Code (GitHub Copilot), Cursor, Claude Desktop, Claude Code, Windsurf and Gemini configs, and asks before changing anything.", command: "npx @mokalabs/proxy wrap" },
    { title: "Restart them in your editor", hint: "Or reload its window. Then use your AI assistant as usual: its MCP traffic shows up here as it happens." },
    { title: "Undo any time", hint: "Puts your configs back exactly as they were.", command: "npx @mokalabs/proxy unwrap" },
  ];
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-5 px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-panel-2 text-accent">
        <Cable className="h-6 w-6" />
      </div>
      <div>
        <h1 className="text-xl font-semibold">See what your AI editor sends to your MCP servers</h1>
        <p className="mt-1.5 text-[13.5px] text-muted">
          Put the Moka proxy in front of a server and every message between GitHub Copilot, Cursor or Claude and that server shows up here, with timeouts, retries and errors.
        </p>
      </div>
      <ol className="w-full space-y-2 text-left">
        {steps.map((s, i) => (
          <li key={s.title} className="rounded-xl border border-line bg-panel px-4 py-3">
            <div className="text-[13.5px] font-medium">
              <span className="text-accent">{i + 1}</span> · {s.title}
            </div>
            <p className="mt-0.5 text-[12.5px] text-muted">{s.hint}</p>
            {s.command && (
              <div className="mt-2 flex items-center gap-2 rounded-lg border border-line bg-panel-2/60 px-3 py-1.5 font-mono text-[12.5px]">
                <span className="flex-1">{s.command}</span>
                <CopyButton text={s.command} className="h-6 w-6" />
              </div>
            )}
          </li>
        ))}
      </ol>
      {dir && <p className="text-[11.5px] text-subtle">Waiting for sessions in {dir}</p>}
    </div>
  );
}
