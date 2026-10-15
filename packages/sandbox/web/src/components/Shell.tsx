import {
  Check,
  ChevronDown,
  BookOpen,
  Bug,
  Cable,
  Code2,
  Command,
  Cpu,
  Download,
  FlaskConical,
  Folder,
  FolderOpen,
  FolderPlus,
  Gauge,
  GitCompareArrows,
  Layers,
  MessageSquare,
  MessageSquarePlus,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Play,
  Plug,
  Plus,
  Presentation,
  Search,
  Settings2,
  Sparkles,
  Star,
  Sun,
  Trash2,
  Upload,
  Workflow,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { DOCS_URL, ISSUES_URL, REPO_URL } from "../links";
import { useStore, type View } from "../store";
import type { SessionSummary } from "../types";
import { Moka, useMokaBranding } from "./Moka";
import { SecurityMark, useSecurity } from "./Security";
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
  const branded = useMokaBranding();
  useEffect(() => {
    document.title = branded ? "Moka" : "Chat";
  }, [branded]);

  return (
    <header className="relative z-30 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel/80 px-3 backdrop-blur">
      {!presenter && (
        <IconButton label="Toggle sidebar (⌘B)" onClick={() => set({ sidebarOpen: !sidebarOpen })}>
          <PanelLeft className="h-4 w-4" />
        </IconButton>
      )}
      {branded && (
        <div className="flex items-center gap-1.5 pr-1">
          <Moka mood="still" face className="h-7 w-8" />
          <span className="text-[14px] font-semibold tracking-tight">moka</span>
        </div>
      )}
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
          { value: "tests", label: <span className="hidden sm:inline">Tests</span>, icon: <FlaskConical className="h-3.5 w-3.5" /> },
          { value: "proxy", label: <span className="hidden sm:inline">Proxy</span>, icon: <Cable className="h-3.5 w-3.5" /> },
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
      {!presenter && view !== "proxy" && (
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
  const agent = config.agents.find((a) => a.id === workspace.agentId);
  const llm = config.llms.find((l) => l.id === workspace.llmId) ?? config.llms[0];
  return (
    <Dropdown
      trigger={(open) => (
        <Pill open={open} icon={agent ? <Workflow className="h-3.5 w-3.5" /> : <Cpu className="h-3.5 w-3.5" />}>
          {agent ? agent.name : llm ? llm.model : "Add a model"}
        </Pill>
      )}
    >
      {(close) => (
        <>
          <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-subtle uppercase">Model for {workspace.name}</div>
          {config.llms.map((l) => (
            <MenuItem
              key={l.id}
              active={!agent && l.id === llm?.id}
              onClick={() => {
                close();
                void setWorkspaceModel(l.id);
              }}
              right={<span className="text-[11px] text-subtle">{l.name}</span>}
            >
              <span className="font-mono text-[12.5px]">{l.model}</span>
            </MenuItem>
          ))}
          {config.agents.length > 0 && (
            <>
              <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-subtle uppercase">Agents</div>
              {config.agents.map((a) => (
                <MenuItem
                  key={a.id}
                  active={agent?.id === a.id}
                  onClick={() => {
                    close();
                    void setWorkspaceModel(`agent:${a.id}`);
                  }}
                  right={<span className="text-[11px] text-subtle">{a.protocol === "a2a" ? "A2A" : "AG-UI"}</span>}
                >
                  {a.name}
                </MenuItem>
              ))}
            </>
          )}
          {(config.llms.length > 0 || config.agents.length > 0) && <div className="my-1 border-t border-line" />}
          <MenuItem
            onClick={() => {
              close();
              openSettings("models");
            }}
          >
            {config.llms.length ? "Manage models…" : "Add a model…"}
          </MenuItem>
          <MenuItem
            onClick={() => {
              close();
              openSettings("agents");
            }}
          >
            {config.agents.length ? "Manage agents…" : "Connect an agent (A2A / AG-UI)…"}
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
  const importSession = useStore((s) => s.importSession);
  const importInput = useRef<HTMLInputElement>(null);
  const config = useStore((s) => s.config);
  const mcp = useStore((s) => s.mcp);
  const workspace = useStore((s) => s.workspace());
  const openSettings = useStore((s) => s.openSettings);
  const skills = useStore((s) => s.skills);
  const createWorkspace = useStore((s) => s.createWorkspace);
  const openServer = useStore((s) => s.openServer);
  const security = useSecurity();
  const [query, setQuery] = useState("");
  const [naming, setNaming] = useState(false);
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const filtered = sessions.filter((s) => !query || s.title.toLowerCase().includes(query.toLowerCase()));
  // Chats by workspace, in config order; chats whose workspace is gone go to the first one.
  const groups = useMemo(() => {
    const known = new Set(config.workspaces.map((w) => w.id));
    const fallback = config.workspaces[0]?.id;
    return config.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      chats: sessions.filter((c) => (c.workspaceId && known.has(c.workspaceId) ? c.workspaceId : fallback) === w.id),
    }));
  }, [config.workspaces, sessions]);
  const workspaceLabel = (id?: string) => (config.workspaces.length > 1 ? config.workspaces.find((w) => w.id === id)?.name : undefined);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-panel/60">
      <div className="space-y-2 p-3">
        <div className="flex gap-1.5">
          <Button className="flex-1 justify-start" variant="secondary" icon={<MessageSquarePlus className="h-4 w-4" />} onClick={newChat}>
            New chat
            <span className="ml-auto">
              <Kbd>⌘J</Kbd>
            </span>
          </Button>
          <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && void importSession(e.target.files[0]).then(() => (e.target.value = ""))} />
          <IconButton label="Import a chat (.json)" className="h-9 w-9" onClick={() => importInput.current?.click()}>
            <Upload className="h-4 w-4" />
          </IconButton>
        </div>
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
        {query ? (
          filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-subtle">No matches</p>
          ) : (
            filtered.map((s) => <ChatRow key={s.id} chat={s} current={s.id === current} workspace={workspaceLabel(s.workspaceId)} />)
          )
        ) : (
          <>
            <div className="flex items-center px-2.5 pt-1 pb-1">
              <span className="flex-1 text-[11px] font-medium tracking-wide text-subtle uppercase">Workspaces</span>
              <IconButton label="New workspace" className="h-6 w-6" onClick={() => setNaming(true)}>
                <FolderPlus className="h-3.5 w-3.5" />
              </IconButton>
            </div>
            {naming && (
              <form
                className="px-1 pb-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = workspaceDraft.trim();
                  if (name) void createWorkspace(name);
                  setNaming(false);
                  setWorkspaceDraft("");
                }}
              >
                <input
                  autoFocus
                  value={workspaceDraft}
                  onChange={(e) => setWorkspaceDraft(e.target.value)}
                  onBlur={() => !workspaceDraft.trim() && setNaming(false)}
                  onKeyDown={(e) => e.key === "Escape" && (setNaming(false), setWorkspaceDraft(""))}
                  placeholder="Workspace name"
                  aria-label="Workspace name"
                  className="h-8 w-full rounded-lg border border-accent/50 bg-panel px-2.5 text-[13px] placeholder:text-subtle focus:outline-none"
                />
                <p className="px-1 pt-1 text-[11px] text-subtle">Starts with this workspace's model, MCP servers and skills.</p>
              </form>
            )}
            {groups.map((g) => (
              <WorkspaceGroup key={g.id} id={g.id} name={g.name} chats={g.chats} current={current} active={g.id === workspace.id} />
            ))}
          </>
        )}
      </div>
      <div className="space-y-0.5 border-t border-line p-2">
        <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-subtle uppercase">{workspace.name}</div>
        {workspace.mcpServerIds.map((id) => {
          const server = config.mcpServers.find((s) => s.id === id);
          if (!server) return null;
          const state = mcp[id];
          return (
            <button
              key={id}
              onClick={() => (state?.status === "auth" && state.authUrl ? window.open(state.authUrl, "_blank", "popup,width=520,height=720") : openServer(id))}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-left text-[12.5px] text-muted hover:bg-panel-2 hover:text-fg"
            >
              <StatusDot status={state?.status ?? "idle"} />
              <span className="min-w-0 flex-1 truncate">{server.name}</span>
              <SecurityMark report={security.get(id)} />
              {state?.status === "auth" && <span className="text-[10.5px] font-medium text-info">Sign in</span>}
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

const OPEN_KEY = "moka.workspaces.collapsed";

function collapsedWorkspaces(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** A workspace and its chats, in the sidebar. Any workspace can collapse; it opens again when you switch to it or start a chat in it. */
function WorkspaceGroup({ id, name, chats, current, active }: { id: string; name: string; chats: SessionSummary[]; current: string; active: boolean }) {
  const newChatIn = useStore((s) => s.newChatIn);
  const [collapsed, setCollapsed] = useState(() => collapsedWorkspaces().has(id));
  const open = !collapsed;
  const [all, setAll] = useState(false);
  const shown = all ? chats : chats.slice(0, 8);
  const setOpen = (next: boolean) => {
    setCollapsed(!next);
    try {
      const set = collapsedWorkspaces();
      if (next) set.delete(id);
      else set.add(id);
      localStorage.setItem(OPEN_KEY, JSON.stringify([...set]));
    } catch {
      // storage blocked
    }
  };
  // Switching to a collapsed workspace opens it (a reload keeps it as you left it).
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current && collapsed) setOpen(true);
    wasActive.current = active;
  }, [active]);
  // Same when the chat you're on moves to one in this workspace (New chat, the palette, a new chat appearing).
  const shownCurrent = useRef(current);
  useEffect(() => {
    if (!chats.some((c) => c.id === current)) return;
    if (current !== shownCurrent.current && collapsed) setOpen(true);
    shownCurrent.current = current;
  }, [current, chats]);
  const newChat = () => {
    if (collapsed) setOpen(true);
    void newChatIn(id);
  };
  return (
    <div className="mb-1">
      <div className={cn("group/workspace flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px]", active ? "text-fg" : "text-muted hover:bg-panel-2 hover:text-fg")}>
        <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setOpen(!open)} title={`${open ? "Collapse" : "Expand"}${active ? " (current workspace)" : ""}`} aria-expanded={open}>
          {open ? <FolderOpen className={cn("h-3.5 w-3.5 shrink-0", active ? "text-accent" : "text-subtle")} /> : <Folder className={cn("h-3.5 w-3.5 shrink-0", active ? "text-accent" : "text-subtle")} />}
          <span className="truncate font-medium">{name}</span>
          {!open && chats.length > 0 && <span className="text-[10.5px] text-subtle">{chats.length}</span>}
        </button>
        <button className="text-subtle opacity-0 group-hover/workspace:opacity-100 hover:text-fg focus:opacity-100" title={`New chat in ${name}`} aria-label={`New chat in ${name}`} onClick={newChat}>
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="ml-3.5 border-l border-line pl-1.5">
          {chats.length === 0 ? (
            <button onClick={newChat} className="px-2.5 py-1 text-[12px] text-subtle hover:text-fg">
              {active ? "Your chats will appear here." : "No chats yet. Start one"}
            </button>
          ) : (
            shown.map((c) => <ChatRow key={c.id} chat={c} current={c.id === current} />)
          )}
          {chats.length > shown.length && (
            <button onClick={() => setAll(true)} className="px-2.5 py-1 text-[12px] text-subtle hover:text-fg">
              Show {chats.length - shown.length} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ChatRow({ chat, current, workspace }: { chat: SessionSummary; current: boolean; workspace?: string }) {
  const openSession = useStore((s) => s.openSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const replay = useStore((s) => s.replay);
  const exportSession = useStore((s) => s.exportSession);
  return (
    <div
      className={cn("group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px]", current ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel-2 hover:text-fg")}
      onClick={() => openSession(chat.id)}
    >
      <span className="min-w-0 flex-1 truncate">
        {chat.title}
        {workspace && <span className="ml-1.5 text-[11px] text-subtle">{workspace}</span>}
      </span>
      <span className="text-[10px] text-subtle group-hover:hidden">{relative(chat.updatedAt)}</span>
      <button
        className="hidden text-subtle hover:text-accent group-hover:block"
        title="Replay this chat (no model needed)"
        onClick={(e) => {
          e.stopPropagation();
          void replay(chat.id);
        }}
        aria-label="Replay chat"
      >
        <Play className="h-3.5 w-3.5" />
      </button>
      <button
        className="hidden text-subtle hover:text-fg group-hover:block"
        title="Export as JSON"
        onClick={(e) => {
          e.stopPropagation();
          void exportSession(chat.id);
        }}
        aria-label="Export chat"
      >
        <Download className="h-3.5 w-3.5" />
      </button>
      <button
        className="hidden text-subtle hover:text-err group-hover:block"
        onClick={(e) => {
          e.stopPropagation();
          void deleteSession(chat.id);
        }}
        aria-label="Delete chat"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
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
      { id: "proxy", label: "Go to Proxy (traffic from other clients)", icon: <Cable className={i} />, run: () => s.set({ view: "proxy" }) },
      { id: "tests", label: "Go to Tests (tool tests across models)", icon: <FlaskConical className={i} />, run: () => s.set({ view: "tests" }) },
      { id: "tools", label: "Go to Tools", icon: <Wrench className={i} />, run: () => s.set({ view: "tools" }) },
      { id: "models", label: "Settings: Models", icon: <Cpu className={i} />, run: () => s.openSettings("models") },
      { id: "mcp", label: "Settings: MCP servers", icon: <Plug className={i} />, run: () => s.openSettings("mcp") },
      { id: "skills", label: "Settings: Skills", icon: <Sparkles className={i} />, run: () => s.openSettings("skills") },
      { id: "ws", label: "Settings: Workspaces", icon: <Layers className={i} />, run: () => s.openSettings("workspaces") },
      { id: "budget", label: "Context budget: what the model reads before every message", icon: <Gauge className={i} />, run: () => s.set({ budgetOpen: true }) },
      { id: "export", label: "Export as code", icon: <Code2 className={i} />, run: () => s.set({ exportOpen: true }) },
      { id: "presenter", label: "Toggle presenter mode", hint: "⌘.", icon: <Presentation className={i} />, run: () => s.set({ presenter: !s.presenter }) },
      { id: "inspector", label: "Toggle inspector", hint: "⌘I", icon: <PanelRight className={i} />, run: () => s.set({ inspectorOpen: !s.inspectorOpen }) },
      { id: "theme", label: "Toggle theme", icon: <Monitor className={i} />, run: s.toggleTheme },
      { id: "star", label: "Star Moka on GitHub", icon: <Star className={i} />, run: () => window.open(REPO_URL, "_blank", "noopener") },
      { id: "docs", label: "Open the docs", icon: <BookOpen className={i} />, run: () => window.open(DOCS_URL, "_blank", "noopener") },
      { id: "issue", label: "Report an issue or ask for a feature", icon: <Bug className={i} />, run: () => window.open(ISSUES_URL, "_blank", "noopener") },
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
