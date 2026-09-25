import {
  Check,
  ChevronDown,
  Code2,
  Command,
  Cpu,
  GitCompareArrows,
  Layers,
  MessageSquare,
  MessageSquarePlus,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Plug,
  Presentation,
  Search,
  Settings2,
  Sparkles,
  Sun,
  Trash2,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { useStore, type View } from "../store";
import { Button, CopyButton, IconButton, Kbd, Modal, StatusDot, Tabs, cn } from "./ui";

/* ------------------------------------------------------------------ top bar */

export function TopBar() {
  const view = useStore((s) => s.view);
  const set = useStore((s) => s.set);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const presenter = useStore((s) => s.presenter);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const openSettings = useStore((s) => s.openSettings);

  return (
    <header className="relative z-30 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel/80 px-3 backdrop-blur">
      {!presenter && (
        <IconButton label="Toggle sidebar (⌘B)" onClick={() => set({ sidebarOpen: !sidebarOpen })}>
          <PanelLeft className="h-4 w-4" />
        </IconButton>
      )}
      <div className="flex items-center gap-1.5 pr-1">
        <img src="/favicon.svg" alt="" className="h-6 w-6 rounded-md" />
        <span className="text-[14px] font-semibold tracking-tight">moka</span>
      </div>
      <WorkspaceSwitcher />
      <ModelSwitcher />
      <span className="flex-1" />
      <Tabs<View>
        value={view}
        onChange={(v) => set({ view: v })}
        items={[
          { value: "chat", label: <span className="hidden sm:inline">Chat</span>, icon: <MessageSquare className="h-3.5 w-3.5" /> },
          { value: "compare", label: <span className="hidden sm:inline">Compare</span>, icon: <GitCompareArrows className="h-3.5 w-3.5" /> },
          { value: "tools", label: <span className="hidden sm:inline">Tools</span>, icon: <Wrench className="h-3.5 w-3.5" /> },
        ]}
      />
      <span className="flex-1" />
      <button
        onClick={() => set({ paletteOpen: true })}
        className="hidden h-8 items-center gap-2 rounded-lg border border-line bg-panel-2 px-2.5 text-[12px] text-muted transition-colors hover:text-fg lg:inline-flex"
      >
        <Search className="h-3.5 w-3.5" />
        Search & commands
        <Kbd>⌘K</Kbd>
      </button>
      <IconButton label="Export as code" onClick={() => set({ exportOpen: true })}>
        <Code2 className="h-4 w-4" />
      </IconButton>
      <IconButton label="Presenter mode (⌘.)" active={presenter} onClick={() => set({ presenter: !presenter })}>
        <Presentation className="h-4 w-4" />
      </IconButton>
      <IconButton label="Toggle theme" onClick={toggleTheme}>
        {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </IconButton>
      <IconButton label="Settings (⌘,)" onClick={() => openSettings()}>
        <Settings2 className="h-4 w-4" />
      </IconButton>
      {!presenter && (
        <IconButton label="Toggle inspector (⌘I)" active={inspectorOpen} onClick={() => set({ inspectorOpen: !inspectorOpen })}>
          <PanelRight className="h-4 w-4" />
        </IconButton>
      )}
    </header>
  );
}

function Dropdown({ trigger, children, align = "left", width = "w-72" }: { trigger: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; width?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen(!open)}>{trigger(open)}</div>
      {open && (
        <div className={cn("animate-in absolute top-full z-30 mt-1.5 overflow-hidden rounded-xl border border-line bg-elev p-1 shadow-soft", width, align === "right" ? "right-0" : "left-0")}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ active, onClick, children, right }: { active?: boolean; onClick: () => void; children: ReactNode; right?: ReactNode }) {
  return (
    <button onClick={onClick} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-panel-2", active && "text-accent")}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {right}
      {active && <Check className="h-3.5 w-3.5" />}
    </button>
  );
}

function Pill({ icon, children, open }: { icon: ReactNode; children: ReactNode; open: boolean }) {
  return (
    <button className={cn("inline-flex h-8 max-w-56 items-center gap-1.5 rounded-lg px-2 text-[13px] transition-colors hover:bg-panel-2", open && "bg-panel-2")}>
      <span className="text-muted">{icon}</span>
      <span className="truncate font-medium">{children}</span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-subtle" />
    </button>
  );
}

function WorkspaceSwitcher() {
  const config = useStore((s) => s.config);
  const workspace = useStore((s) => s.workspace());
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const openSettings = useStore((s) => s.openSettings);
  return (
    <Dropdown trigger={(open) => <Pill open={open} icon={<Layers className="h-3.5 w-3.5" />}>{workspace.name}</Pill>}>
      {(close) => (
        <>
          <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-subtle uppercase">Workspaces</div>
          {config.workspaces.map((w) => (
            <MenuItem
              key={w.id}
              active={w.id === workspace.id}
              onClick={() => {
                close();
                void setActiveWorkspace(w.id);
              }}
              right={<span className="text-[11px] text-subtle">{w.mcpServerIds.length}·{w.skillIds.length}</span>}
            >
              {w.name}
            </MenuItem>
          ))}
          <div className="my-1 border-t border-line" />
          <MenuItem
            onClick={() => {
              close();
              openSettings("workspaces");
            }}
          >
            Manage workspaces…
          </MenuItem>
        </>
      )}
    </Dropdown>
  );
}

function ModelSwitcher() {
  const config = useStore((s) => s.config);
  const workspace = useStore((s) => s.workspace());
  const setWorkspaceModel = useStore((s) => s.setWorkspaceModel);
  const openSettings = useStore((s) => s.openSettings);
  const llm = config.llms.find((l) => l.id === workspace.llmId) ?? config.llms[0];
  return (
    <Dropdown trigger={(open) => <Pill open={open} icon={<Cpu className="h-3.5 w-3.5" />}>{llm ? llm.model : "Add a model"}</Pill>}>
      {(close) => (
        <>
          <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-subtle uppercase">Model for {workspace.name}</div>
          {config.llms.map((l) => (
            <MenuItem
              key={l.id}
              active={l.id === llm?.id}
              onClick={() => {
                close();
                void setWorkspaceModel(l.id);
              }}
              right={<span className="text-[11px] text-subtle">{l.name}</span>}
            >
              <span className="font-mono text-[12.5px]">{l.model}</span>
            </MenuItem>
          ))}
          {config.llms.length > 0 && <div className="my-1 border-t border-line" />}
          <MenuItem
            onClick={() => {
              close();
              openSettings("models");
            }}
          >
            {config.llms.length ? "Manage models…" : "Add a model…"}
          </MenuItem>
        </>
      )}
    </Dropdown>
  );
}

/* ------------------------------------------------------------------ sidebar */

function relative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const current = useStore((s) => s.session.id);
  const newChat = useStore((s) => s.newChat);
  const openSession = useStore((s) => s.openSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const config = useStore((s) => s.config);
  const mcp = useStore((s) => s.mcp);
  const workspace = useStore((s) => s.workspace());
  const openSettings = useStore((s) => s.openSettings);
  const skills = useStore((s) => s.skills);
  const [query, setQuery] = useState("");
  const filtered = sessions.filter((s) => !query || s.title.toLowerCase().includes(query.toLowerCase()));

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-panel/60">
      <div className="space-y-2 p-3">
        <Button className="w-full justify-start" variant="secondary" icon={<MessageSquarePlus className="h-4 w-4" />} onClick={newChat}>
          New chat
          <span className="ml-auto">
            <Kbd>⌘J</Kbd>
          </span>
        </Button>
        {sessions.length > 6 && (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats"
              className="h-8 w-full rounded-lg border border-line bg-panel pr-2 pl-8 text-[13px] placeholder:text-subtle focus:outline-none"
            />
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-subtle">{sessions.length ? "No matches" : "Your chats will appear here."}</p>
        ) : (
          filtered.map((s) => (
            <div
              key={s.id}
              className={cn("group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px]", s.id === current ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel-2 hover:text-fg")}
              onClick={() => openSession(s.id)}
            >
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <span className="text-[10px] text-subtle group-hover:hidden">{relative(s.updatedAt)}</span>
              <button
                className="hidden text-subtle hover:text-err group-hover:block"
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteSession(s.id);
                }}
                aria-label="Delete chat"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
      <div className="space-y-0.5 border-t border-line p-2">
        <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-subtle uppercase">{workspace.name}</div>
        {workspace.mcpServerIds.map((id) => {
          const server = config.mcpServers.find((s) => s.id === id);
          if (!server) return null;
          const state = mcp[id];
          return (
            <button key={id} onClick={() => openSettings("mcp")} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-left text-[12.5px] text-muted hover:bg-panel-2 hover:text-fg">
              <StatusDot status={state?.status ?? "idle"} />
              <span className="min-w-0 flex-1 truncate">{server.name}</span>
              {state?.status === "connected" && <span className="font-mono text-[10.5px] text-subtle">{state.tools.length}</span>}
            </button>
          );
        })}
        {skills
          .filter((s) => workspace.skillIds.includes(s.id))
          .map((s) => (
            <button key={s.id} onClick={() => openSettings("skills")} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-left text-[12.5px] text-muted hover:bg-panel-2 hover:text-fg">
              <Sparkles className={cn("h-3 w-3", s.error ? "text-err" : "text-violet")} />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
            </button>
          ))}
        <button onClick={() => openSettings("mcp")} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-left text-[12.5px] text-subtle hover:bg-panel-2 hover:text-fg">
          <Plug className="h-3 w-3" /> Add MCP server or skill
        </button>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------ export dialog */

const TARGETS = [
  { value: "ai-sdk", label: "Vercel AI SDK", file: "agent.ts" },
  { value: "langgraph", label: "LangGraph", file: "agent.py" },
  { value: "mcp-json", label: "mcp.json", file: "mcp.json" },
  { value: "moka", label: "moka.json", file: "moka.json" },
] as const;
type Target = (typeof TARGETS)[number]["value"];

export function ExportDialog() {
  const open = useStore((s) => s.exportOpen);
  const set = useStore((s) => s.set);
  const workspace = useStore((s) => s.workspace());
  const config = useStore((s) => s.config);
  const [target, setTarget] = useState<Target>("ai-sdk");
  const [code, setCode] = useState("");

  useEffect(() => {
    if (!open) return;
    api<{ code: string }>("/api/export", { body: { target, workspaceId: workspace.id } })
      .then((r) => setCode(r.code))
      .catch((e) => setCode(`// ${e?.message}`));
  }, [open, target, workspace.id, config]);

  const file = TARGETS.find((t) => t.value === target)!.file;
  return (
    <Modal
      open={open}
      onClose={() => set({ exportOpen: false })}
      title={`Export “${workspace.name}”`}
      description="Take this setup out of the sandbox: same model, same MCP servers, same prompt. API keys are never included."
      className="max-w-3xl"
    >
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <Tabs value={target} onChange={setTarget} items={TARGETS.map((t) => ({ value: t.value, label: t.label }))} />
        <span className="flex-1" />
        <CopyButton text={code} label="Copy code" />
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob([code], { type: "text/plain" }));
            a.download = file;
            a.click();
          }}
        >
          Download {file}
        </Button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto bg-panel-2/60 p-5 font-mono text-[12px] leading-relaxed">{code}</pre>
    </Modal>
  );
}

/* ---------------------------------------------------------- command palette */

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const set = useStore((s) => s.set);
  const s = useStore();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const items: CommandItem[] = useMemo(() => {
    const i = "h-4 w-4";
    const list: CommandItem[] = [
      { id: "new", label: "New chat", hint: "⌘J", icon: <MessageSquarePlus className={i} />, run: s.newChat },
      { id: "chat", label: "Go to Chat", icon: <MessageSquare className={i} />, run: () => s.set({ view: "chat" }) },
      { id: "compare", label: "Go to Compare", icon: <GitCompareArrows className={i} />, run: () => s.set({ view: "compare" }) },
      { id: "tools", label: "Go to Tools", icon: <Wrench className={i} />, run: () => s.set({ view: "tools" }) },
      { id: "models", label: "Settings: Models", icon: <Cpu className={i} />, run: () => s.openSettings("models") },
      { id: "mcp", label: "Settings: MCP servers", icon: <Plug className={i} />, run: () => s.openSettings("mcp") },
      { id: "skills", label: "Settings: Skills", icon: <Sparkles className={i} />, run: () => s.openSettings("skills") },
      { id: "ws", label: "Settings: Workspaces", icon: <Layers className={i} />, run: () => s.openSettings("workspaces") },
      { id: "export", label: "Export as code", icon: <Code2 className={i} />, run: () => s.set({ exportOpen: true }) },
      { id: "presenter", label: "Toggle presenter mode", hint: "⌘.", icon: <Presentation className={i} />, run: () => s.set({ presenter: !s.presenter }) },
      { id: "inspector", label: "Toggle inspector", hint: "⌘I", icon: <PanelRight className={i} />, run: () => s.set({ inspectorOpen: !s.inspectorOpen }) },
      { id: "theme", label: "Toggle theme", icon: <Monitor className={i} />, run: s.toggleTheme },
    ];
    for (const w of s.config.workspaces) list.push({ id: `ws:${w.id}`, label: `Switch workspace: ${w.name}`, icon: <Layers className={i} />, run: () => void s.setActiveWorkspace(w.id) });
    for (const l of s.config.llms) list.push({ id: `llm:${l.id}`, label: `Use model: ${l.name} · ${l.model}`, icon: <Cpu className={i} />, run: () => void s.setWorkspaceModel(l.id) });
    for (const c of s.sessions.slice(0, 30)) list.push({ id: `s:${c.id}`, label: c.title, hint: "chat", icon: <MessageSquare className={i} />, run: () => void s.openSession(c.id) });
    return list;
  }, [s]);

  const filtered = items.filter((it) => it.label.toLowerCase().includes(query.toLowerCase()));
  const run = (item?: CommandItem) => {
    if (!item) return;
    set({ paletteOpen: false });
    item.run();
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[14vh]">
      <div className="absolute inset-0 bg-black/40" onClick={() => set({ paletteOpen: false })} />
      <div className="animate-in relative w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-elev shadow-soft">
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Command className="h-4 w-4 text-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                run(filtered[index]);
              } else if (e.key === "Escape") {
                set({ paletteOpen: false });
              }
            }}
            placeholder="Type a command or search chats…"
            className="h-12 flex-1 bg-transparent text-[14px] placeholder:text-subtle focus:outline-none"
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-subtle">No results</p>}
          {filtered.map((item, i) => (
            <button
              key={item.id}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(item)}
              className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px]", i === index ? "bg-panel-2 text-fg" : "text-muted")}
            >
              <span className={i === index ? "text-accent" : "text-subtle"}>{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && <span className="text-[11px] text-subtle">{item.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- toasts */

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "animate-in pointer-events-auto max-w-sm rounded-xl border px-4 py-2.5 text-[13px] shadow-soft",
            t.kind === "error" ? "border-err/30 bg-elev text-err" : t.kind === "success" ? "border-ok/30 bg-elev text-fg" : "border-line bg-elev text-fg",
          )}
        >
          {t.kind === "success" && <Check className="mr-1.5 inline h-3.5 w-3.5 text-ok" />}
          {t.message}
        </div>
      ))}
    </div>
  );
}
