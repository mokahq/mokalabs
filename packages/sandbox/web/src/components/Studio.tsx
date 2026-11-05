import { Code2, Download, FileCode2, FileText, FlaskConical, FolderOpen, Hammer, Play, Plus, RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, authHeaders } from "../api";
import { useStore } from "../store";
import { CodeEditor } from "./Code";
import { Badge, Button, Empty, IconButton, Input, Modal, Spinner, StatusDot, cn } from "./ui";

interface Project {
  serverId: string;
  name: string;
  dir: string;
  files: Array<{ path: string; size: number }>;
}

interface StudioInfo {
  root?: string;
  typescript: boolean;
  node: string;
  templates: Array<{ id: string; label: string; description: string }>;
  projects: Project[];
}

const langOf = (file: string) => (/\.m?ts$/.test(file) ? "ts" : /\.m?js$/.test(file) ? "js" : /\.json$/.test(file) ? "json" : /\.md$/.test(file) ? "md" : /\.html$/.test(file) ? "html" : /\.css$/.test(file) ? "css" : undefined);

/**
 * Server Studio: write an MCP server in Moka. Save and it restarts; its tools
 * show up in chat, Tools and Tests right away. Export it as a project.
 */
export function StudioView() {
  const [info, setInfo] = useState<StudioInfo>();
  const [selected, setSelected] = useState<string>();
  const [file, setFile] = useState("server.ts");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState(false);
  const toast = useStore((s) => s.toast);
  const mcp = useStore((s) => s.mcp);
  const set = useStore((s) => s.set);
  const project = info?.projects.find((p) => p.serverId === selected) ?? info?.projects[0];
  const state = project ? mcp[project.serverId] : undefined;
  const dirty = text !== saved;

  const refresh = useCallback(async () => {
    const next = await api<StudioInfo>("/api/studio");
    setInfo(next);
    return next;
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = useCallback(
    async (p: Project, path: string) => {
      setLoading(true);
      try {
        const { content } = await api<{ content: string }>(`/api/studio/file?dir=${encodeURIComponent(p.dir)}&path=${encodeURIComponent(path)}`);
        setFile(path);
        setText(content);
        setSaved(content);
      } catch (e: any) {
        toast(e?.message ?? "Couldn't open the file", "error");
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );
  useEffect(() => {
    if (project) void open(project, project.files.find((f) => f.path === "server.ts")?.path ?? project.files[0]?.path ?? "server.ts");
    // only when the project changes
  }, [project?.serverId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    if (!project || !dirty) return;
    try {
      await api("/api/studio/file", { method: "PUT", body: { dir: project.dir, path: file, content: text } });
      setSaved(text);
      toast(`Saved ${file}. ${project.name} restarts with it.`, "success");
      setTimeout(() => void useStore.getState().refreshMcp(), 1200);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't save", "error");
    }
  }, [project, dirty, file, text, toast]);

  // ⌘S / Ctrl+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const exportZip = async () => {
    if (!project) return;
    const res = await fetch(`/api/studio/export?dir=${encodeURIComponent(project.dir)}`, { headers: authHeaders() });
    if (!res.ok) return toast("Export failed", "error");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob());
    a.download = `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "mcp-server"}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const created = async (serverId: string) => {
    // The server was added to the config on Moka's side: load it, then start it.
    await useStore.getState().refresh();
    await refresh();
    setSelected(serverId);
    void useStore.getState().connectServer(serverId);
  };

  if (!info) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="text-accent" />
      </div>
    );
  }

  const log = (state?.stderr ?? []).slice(-40);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <Code2 className="h-4 w-4 text-accent" />
        <h1 className="text-[15px] font-semibold">Server Studio</h1>
        {project && (
          <select
            value={project.serverId}
            onChange={(e) => setSelected(e.target.value)}
            className="h-8 rounded-lg border border-line bg-panel px-2 text-[13px]"
            aria-label="Server"
          >
            {info.projects.map((p) => (
              <option key={p.serverId} value={p.serverId}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={() => setOpening(true)}>
          Open folder
        </Button>
        <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>
          New server
        </Button>
        {project && (
          <>
            <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={() => void exportZip()} title="A .zip with package.json, tsconfig and a README, ready to publish">
              Export
            </Button>
            <Button size="sm" variant="primary" icon={<Save className="h-3.5 w-3.5" />} disabled={!dirty} onClick={() => void save()} title="Save (⌘S): the server restarts with it">
              Save
            </Button>
          </>
        )}
      </div>

      {!info.typescript && (
        <div className="border-b border-warn/30 bg-warn/5 px-5 py-2 text-[12.5px] text-warn">
          Node {info.node} can't run TypeScript. Use Node 22.18 or later, or write the server as plain JavaScript in <code className="font-mono">server.mjs</code>.
        </div>
      )}

      {!project ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <Empty
            icon={<Code2 className="h-5 w-5" />}
            title="Write an MCP server in Moka"
            action={
              <div className="flex gap-2">
                <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
                  New server
                </Button>
                <Button variant="outline" icon={<FolderOpen className="h-4 w-4" />} onClick={() => setOpening(true)}>
                  Open folder
                </Button>
              </div>
            }
          >
            Start from a template, edit <code className="font-mono">server.ts</code> here, and save: the server restarts and its tools are ready in chat, Tools and Tests. No install needed. Export it as a project when it works.
          </Empty>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-52 shrink-0 flex-col border-r border-line bg-panel-2/40 p-2 md:flex">
            <div className="truncate px-2 pt-1 pb-2 font-mono text-[11px] text-subtle" title={project.dir}>
              {project.dir}
            </div>
            {project.files.map((f) => (
              <button
                key={f.path}
                onClick={() => (dirty && !confirm(`Discard your changes to ${file}?`) ? undefined : void open(project, f.path))}
                className={cn("flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-panel-2", f.path === file && "bg-panel-2 font-medium")}
              >
                {/\.(ts|mts|js|mjs)$/.test(f.path) ? <FileCode2 className="h-3.5 w-3.5 text-accent" /> : <FileText className="h-3.5 w-3.5 text-muted" />}
                <span className="truncate font-mono text-[12.5px]">{f.path}</span>
                {f.path === file && dirty && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" title="Not saved" />}
              </button>
            ))}
          </aside>
          <section className="flex min-h-0 min-w-0 flex-1 flex-col p-3">
            {loading ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner className="text-accent" />
              </div>
            ) : (
              <CodeEditor fill value={text} onChange={setText} lang={langOf(file)} ariaLabel={`Edit ${file}`} className="min-h-0 flex-1" />
            )}
          </section>
          <aside className="hidden w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-line p-3 lg:flex">
            <div className="rounded-xl border border-line bg-panel p-3">
              <div className="flex items-center gap-2 text-[13px]">
                <StatusDot status={state?.status ?? "idle"} />
                <span className="font-medium">{project.name}</span>
                <span className="text-muted">{state?.status === "connected" ? "running" : (state?.status ?? "not started")}</span>
                <span className="flex-1" />
                <IconButton label="Restart" className="h-6 w-6" onClick={() => void useStore.getState().connectServer(project.serverId, true)}>
                  <RefreshCw className="h-3.5 w-3.5" />
                </IconButton>
              </div>
              {state?.error && <p className="mt-2 rounded-lg bg-err/5 px-2 py-1.5 text-[12px] break-words text-err">{state.error}</p>}
            </div>

            <div className="rounded-xl border border-line bg-panel">
              <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px] font-medium">
                <Hammer className="h-3.5 w-3.5 text-muted" /> Tools
                <Badge>{state?.tools.length ?? 0}</Badge>
              </div>
              {(state?.tools ?? []).map((t) => (
                <div key={t.name} className="flex items-start gap-2 border-b border-line px-3 py-2 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[12.5px] font-medium">{t.name}</div>
                    {t.description && <div className="line-clamp-2 text-[12px] text-muted">{t.description}</div>}
                  </div>
                  <Button size="xs" variant="ghost" icon={<Play className="h-3 w-3" />} onClick={() => set({ view: "tools", toolTarget: { serverId: project.serverId, tool: t.name } })}>
                    Try
                  </Button>
                </div>
              ))}
              {state?.status === "connected" && state.tools.length === 0 && <p className="px-3 py-2 text-[12px] text-muted">No tools yet: add one with server.registerTool.</p>}
            </div>

            <Button size="sm" variant="outline" icon={<FlaskConical className="h-3.5 w-3.5" />} onClick={() => set({ view: "tests" })}>
              Test with models
            </Button>

            <div className="min-h-0 rounded-xl border border-line bg-panel">
              <div className="border-b border-line px-3 py-2 text-[12px] font-medium">Server log</div>
              <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted">{log.length ? log.join("\n") : "console.error() output and errors show here."}</pre>
            </div>
          </aside>
        </div>
      )}

      {creating && <CreateDialog templates={info.templates} root={info.root} onClose={() => setCreating(false)} onCreated={(id) => (setCreating(false), void created(id))} />}
      {opening && <OpenDialog onClose={() => setOpening(false)} onOpened={(id) => (setOpening(false), void created(id))} />}
    </div>
  );
}

function CreateDialog({ templates, root, onClose, onCreated }: { templates: StudioInfo["templates"]; root?: string; onClose: () => void; onCreated: (serverId: string) => void }) {
  const [name, setName] = useState("My tools");
  const [template, setTemplate] = useState(templates[0]?.id ?? "blank");
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const slug = useMemo(() => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "server", [name]);
  const create = async () => {
    setBusy(true);
    try {
      const { serverId } = await api<{ serverId: string }>("/api/studio/create", { body: { name: name.trim(), template, ...(dir.trim() ? { dir: dir.trim() } : {}) } });
      onCreated(serverId);
    } catch (e: any) {
      setError(e instanceof ApiError ? e.message : (e?.message ?? "Couldn't create the server"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="New MCP server" description="It's added to this workspace and starts right away." className="max-w-xl">
      <div className="space-y-4 px-5 py-4">
        <label className="block space-y-1.5">
          <span className="text-[11px] font-medium tracking-wide text-subtle uppercase">Name</span>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="space-y-1.5">
          <span className="text-[11px] font-medium tracking-wide text-subtle uppercase">Start from</span>
          <div className="grid gap-2 sm:grid-cols-3">
            {templates.map((t) => (
              <button key={t.id} onClick={() => setTemplate(t.id)} className={cn("rounded-xl border p-3 text-left", template === t.id ? "border-accent bg-accent-soft" : "border-line hover:bg-panel-2/60")}>
                <div className="text-[13px] font-medium">{t.label}</div>
                <div className="mt-0.5 text-[12px] text-muted">{t.description}</div>
              </button>
            ))}
          </div>
        </div>
        <label className="block space-y-1.5">
          <span className="text-[11px] font-medium tracking-wide text-subtle uppercase">Folder (optional)</span>
          <Input mono value={dir} onChange={(e) => setDir(e.target.value)} placeholder={`${root ?? "~/.moka/studio"}/${slug}`} />
          <span className="block text-[11.5px] text-subtle">An empty folder, e.g. inside your repo. Leave empty for Moka's Studio folder.</span>
        </label>
        {error && <p className="text-[12.5px] text-err">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void create()}>
          Create
        </Button>
      </div>
    </Modal>
  );
}

function OpenDialog({ onClose, onOpened }: { onClose: () => void; onOpened: (serverId: string) => void }) {
  const [dir, setDir] = useState("");
  const [error, setError] = useState<string>();
  const openFolder = async () => {
    try {
      const { serverId } = await api<{ serverId: string }>("/api/studio/open", { body: { dir: dir.trim() } });
      onOpened(serverId);
    } catch (e: any) {
      setError(e?.message ?? "Couldn't open the folder");
    }
  };
  return (
    <Modal open onClose={onClose} title="Open a folder" description="A folder with a server.ts (or server.mjs), e.g. a server in your repo. Moka runs it and reloads it when its files change." className="max-w-xl">
      <div className="space-y-2 px-5 py-4">
        <Input autoFocus mono value={dir} onChange={(e) => (setDir(e.target.value), setError(undefined))} placeholder="/Users/you/code/my-mcp-server" onKeyDown={(e) => e.key === "Enter" && void openFolder()} />
        {error && <p className="text-[12.5px] text-err">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!dir.trim()} onClick={() => void openFolder()}>
          Open
        </Button>
      </div>
    </Modal>
  );
}
