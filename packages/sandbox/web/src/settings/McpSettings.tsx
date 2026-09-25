import { ClipboardPaste, Globe, LayoutGrid, Play, Plug, Plus, RefreshCw, Terminal, Trash2, Unplug, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Badge, Button, Empty, Field, Input, JsonView, KeyValueEditor, Modal, StatusDot, Switch, Tabs, Textarea, cn } from "../components/ui";
import { useStore } from "../store";
import type { McpServerConfig, McpServerState } from "../types";
import { FormFooter, ListItem, MasterDetail, Section } from "./Settings";

interface GalleryItem {
  name: string;
  description: string;
  server: Omit<McpServerConfig, "id">;
  needs?: string;
}

const GALLERY: GalleryItem[] = [
  {
    name: "Everything (reference)",
    description: "Official test server exercising every MCP feature: tools, resources, prompts, sampling.",
    server: { name: "Everything", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
  },
  {
    name: "Filesystem",
    description: "Read, write and search files inside an allowed folder.",
    server: { name: "Filesystem", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    needs: "Edit the last argument to the folder you want to expose.",
  },
  {
    name: "Memory",
    description: "Knowledge-graph memory the model can read and write.",
    server: { name: "Memory", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
  },
  {
    name: "Sequential thinking",
    description: "Structured step-by-step reasoning tool.",
    server: { name: "Sequential thinking", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
  },
  {
    name: "Playwright browser",
    description: "Drive a real browser: navigate, click, fill forms, screenshot.",
    server: { name: "Playwright", transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] },
  },
  {
    name: "Fetch",
    description: "Fetch web pages as markdown (Python, runs via uvx).",
    server: { name: "Fetch", transport: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
    needs: "Requires uv (https://docs.astral.sh/uv/).",
  },
  {
    name: "Git",
    description: "Inspect and operate on a local git repository (Python, via uvx).",
    server: { name: "Git", transport: "stdio", command: "uvx", args: ["mcp-server-git", "--repository", "."] },
    needs: "Requires uv.",
  },
  {
    name: "DeepWiki",
    description: "Ask questions about any public GitHub repository. Remote, no auth.",
    server: { name: "DeepWiki", transport: "http", url: "https://mcp.deepwiki.com/mcp" },
  },
  {
    name: "Context7",
    description: "Up-to-date library documentation for coding. Remote.",
    server: { name: "Context7", transport: "http", url: "https://mcp.context7.com/mcp" },
  },
  {
    name: "GitHub",
    description: "GitHub's official remote MCP server: repos, issues, PRs.",
    server: {
      name: "GitHub",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
    },
    needs: "Set GITHUB_TOKEN in your environment.",
  },
];

export function McpSettings() {
  const config = useStore((s) => s.config);
  const mcp = useStore((s) => s.mcp);
  const [selected, setSelected] = useState<string | "new" | undefined>(config.mcpServers[0]?.id ?? "new");

  useEffect(() => {
    if (selected && selected !== "new" && !config.mcpServers.some((s) => s.id === selected)) setSelected(config.mcpServers[0]?.id ?? "new");
  }, [config.mcpServers, selected]);

  const current = config.mcpServers.find((s) => s.id === selected);
  return (
    <MasterDetail
      list={
        <>
          <div className="p-3">
            <Button className="w-full" variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setSelected("new")}>
              Add server
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
            {config.mcpServers.map((s) => {
              const state = mcp[s.id];
              return (
                <ListItem
                  key={s.id}
                  active={selected === s.id}
                  onClick={() => setSelected(s.id)}
                  left={<StatusDot status={state?.status ?? "idle"} />}
                  title={s.name}
                  subtitle={s.transport === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : s.url}
                  right={state?.status === "connected" ? <span className="font-mono text-[11px] text-subtle">{state.tools.length}</span> : undefined}
                />
              );
            })}
          </div>
        </>
      }
      detail={
        selected === "new" ? (
          <NewServer onCreated={setSelected} />
        ) : current ? (
          <ServerForm key={current.id} initial={current} />
        ) : (
          <Empty icon={<Plug className="h-5 w-5" />} title="No server selected" />
        )
      }
    />
  );
}

function useAddServers() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const connectServer = useStore((s) => s.connectServer);
  return async (servers: Array<Omit<McpServerConfig, "id"> & { id?: string }>, addToWorkspace: boolean) => {
    const taken = new Set(config.mcpServers.map((s) => s.id));
    const created: McpServerConfig[] = servers.map((s) => {
      const base = (s.id ?? s.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "server";
      let id = base;
      for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
      taken.add(id);
      return { ...s, id } as McpServerConfig;
    });
    const activeId = config.activeWorkspaceId;
    const workspaces = addToWorkspace
      ? config.workspaces.map((w) => (w.id === activeId ? { ...w, mcpServerIds: [...w.mcpServerIds, ...created.map((c) => c.id)] } : w))
      : config.workspaces;
    const ok = await saveConfig(
      { ...config, mcpServers: [...config.mcpServers, ...created], workspaces },
      created.length === 1 ? `Added ${created[0]!.name}` : `Added ${created.length} servers`,
    );
    if (ok) for (const c of created) void connectServer(c.id);
    return ok ? created : [];
  };
}

function NewServer({ onCreated }: { onCreated: (id: string) => void }) {
  const [mode, setMode] = useState<"gallery" | "manual" | "import">("gallery");
  const [importOpen, setImportOpen] = useState(false);
  const add = useAddServers();
  const [transport, setTransport] = useState<McpServerConfig["transport"]>("stdio");

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold">Add an MCP server</h3>
          <p className="mt-1 text-[13px] text-muted">Local (stdio), Streamable HTTP, or SSE. New servers join the active workspace.</p>
        </div>
        <Tabs
          value={mode}
          onChange={(m) => (m === "import" ? setImportOpen(true) : setMode(m))}
          items={[
            { value: "gallery", label: "Gallery", icon: <LayoutGrid className="h-3.5 w-3.5" /> },
            { value: "manual", label: "Manual", icon: <Terminal className="h-3.5 w-3.5" /> },
            { value: "import", label: "Paste JSON", icon: <ClipboardPaste className="h-3.5 w-3.5" /> },
          ]}
        />
      </div>

      {mode === "gallery" ? (
        <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
          {GALLERY.map((g) => (
            <button
              key={g.name}
              onClick={async () => {
                const [created] = await add([g.server], true);
                if (created) onCreated(created.id);
              }}
              className="group rounded-xl border border-line bg-panel p-3.5 text-left transition-all hover:-translate-y-px hover:border-accent/40 hover:shadow-soft"
            >
              <div className="flex items-center gap-2">
                {g.server.transport === "stdio" ? <Terminal className="h-3.5 w-3.5 text-muted" /> : <Globe className="h-3.5 w-3.5 text-muted" />}
                <span className="text-[13px] font-medium">{g.name}</span>
                <Badge className="ml-auto">{g.server.transport}</Badge>
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{g.description}</p>
              {g.needs && <p className="mt-1.5 text-[11px] text-warn">{g.needs}</p>}
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-5">
          <Tabs
            value={transport}
            onChange={setTransport}
            items={[
              { value: "stdio", label: "stdio (local command)" },
              { value: "http", label: "Streamable HTTP" },
              { value: "sse", label: "SSE (legacy)" },
            ]}
          />
          <div className="mt-4">
            <ServerForm
              key={transport}
              initial={{ id: "", name: "", transport, args: [] }}
              isNew
              onCreated={onCreated}
            />
          </div>
        </div>
      )}
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(ids) => {
          setImportOpen(false);
          if (ids[0]) onCreated(ids[0]);
        }}
      />
    </div>
  );
}

function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (ids: string[]) => void }) {
  const [json, setJson] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const add = useAddServers();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import MCP servers"
      description="Paste the mcpServers JSON from Claude Desktop, Claude Code, Cursor, Windsurf — or VS Code's servers block."
      className="max-w-2xl"
    >
      <div className="p-5">
        <Textarea
          mono
          rows={14}
          value={json}
          onChange={(e) => {
            setJson(e.target.value);
            setError(undefined);
          }}
          placeholder={`{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]\n    },\n    "remote": { "type": "http", "url": "https://example.com/mcp" }\n  }\n}`}
        />
        {error && <p className="mt-2 text-[12.5px] text-err">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!json.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              const { servers } = await api<{ servers: McpServerConfig[] }>("/api/mcp/import", { body: { json } });
              const created = await add(servers, true);
              setJson("");
              onImported(created.map((c) => c.id));
            } catch (e: any) {
              setError(e?.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Import
        </Button>
      </div>
    </Modal>
  );
}

function ServerForm({ initial, isNew, onCreated }: { initial: McpServerConfig; isNew?: boolean; onCreated?: (id: string) => void }) {
  const config = useStore((s) => s.config);
  const state = useStore((s) => s.mcp[initial.id]);
  const saveConfig = useStore((s) => s.saveConfig);
  const connectServer = useStore((s) => s.connectServer);
  const set = useStore((s) => s.set);
  const add = useAddServers();
  const [draft, setDraft] = useState<McpServerConfig>(initial);
  const [argsText, setArgsText] = useState((initial.args ?? []).join("\n"));
  const [testState, setTestState] = useState<McpServerState>();
  const [testing, setTesting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(Boolean(initial.env || initial.cwd || initial.timeoutMs));

  const build = (): McpServerConfig => {
    const out: any = { ...draft, args: argsText.split("\n").map((a) => a.trim()).filter(Boolean) };
    if (out.transport === "stdio") {
      delete out.url;
      delete out.headers;
    } else {
      delete out.command;
      delete out.args;
      delete out.env;
      delete out.cwd;
    }
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (v === "" || v === undefined || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)) delete out[k];
      if (Array.isArray(v) && v.length === 0 && k !== "args") delete out[k];
    }
    return out;
  };
  const built = build();
  const dirty = useMemo(() => JSON.stringify(built) !== JSON.stringify(initial), [built, initial]);
  const patch = (p: Partial<McpServerConfig>) => setDraft((d) => ({ ...d, ...p }));
  const valid = !!draft.name.trim() && (draft.transport === "stdio" ? !!draft.command?.trim() : /^https?:\/\//.test(draft.url ?? ""));
  const live = testState ?? state;

  const save = async () => {
    if (isNew) {
      const [created] = await add([{ ...built, id: undefined } as any], true);
      if (created) onCreated?.(created.id);
      return;
    }
    const ok = await saveConfig({ ...config, mcpServers: config.mcpServers.map((s) => (s.id === initial.id ? built : s)) }, "Server saved");
    if (ok) void connectServer(initial.id, true);
  };

  const test = async () => {
    setTesting(true);
    try {
      const { state } = await api<{ state: McpServerState }>("/api/mcp/test", { body: { server: { ...built, id: built.id || "__test__" } } });
      setTestState(state);
    } catch (e: any) {
      setTestState({ id: "", name: draft.name, status: "error", error: e?.message, tools: [], prompts: [], resources: [], stderr: [] });
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Remove "${initial.name}"?`)) return;
    await api(`/api/mcp/${initial.id}/disconnect`, { body: {} }).catch(() => {});
    await saveConfig(
      {
        ...config,
        mcpServers: config.mcpServers.filter((s) => s.id !== initial.id),
        workspaces: config.workspaces.map((w) => ({ ...w, mcpServerIds: w.mcpServerIds.filter((id) => id !== initial.id) })),
      },
      "Server removed",
    );
  };

  const toggleTool = async (tool: string, enabled: boolean) => {
    const disabled = new Set(initial.disabledTools ?? []);
    if (enabled) disabled.delete(tool);
    else disabled.add(tool);
    await saveConfig({
      ...config,
      mcpServers: config.mcpServers.map((s) => (s.id === initial.id ? { ...s, disabledTools: disabled.size ? [...disabled] : undefined } : s)),
    });
  };

  const fields = (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" className="sm:col-span-2">
        <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="My server" />
      </Field>
      {draft.transport === "stdio" ? (
        <>
          <Field label="Command" className="sm:col-span-2" hint="npx, uvx, node, python, docker, or an absolute path.">
            <Input mono value={draft.command ?? ""} onChange={(e) => patch({ command: e.target.value })} placeholder="npx" />
          </Field>
          <Field label="Arguments" className="sm:col-span-2" hint="One per line. ${VAR} is expanded from the environment.">
            <Textarea mono rows={Math.max(3, argsText.split("\n").length)} value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder={"-y\n@modelcontextprotocol/server-everything"} />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL" className="sm:col-span-2" hint={draft.transport === "sse" ? "Legacy HTTP+SSE endpoint (usually ends in /sse)." : "Streamable HTTP endpoint (usually ends in /mcp)."}>
            <Input mono value={draft.url ?? ""} onChange={(e) => patch({ url: e.target.value })} placeholder="https://example.com/mcp" />
          </Field>
          <Field label="Headers" className="sm:col-span-2" hint="e.g. Authorization: Bearer ${API_TOKEN}. Values support env:NAME and ${NAME}.">
            <KeyValueEditor value={draft.headers} onChange={(headers) => patch({ headers })} keyPlaceholder="Header" />
          </Field>
        </>
      )}
      <div className="flex items-center gap-2 sm:col-span-2">
        <Switch checked={showAdvanced} onChange={setShowAdvanced} label="Advanced" />
        <span className="text-[12.5px] text-muted">Advanced options</span>
      </div>
      {showAdvanced && (
        <>
          {draft.transport === "stdio" && (
            <>
              <Field label="Environment variables" className="sm:col-span-2" hint="Merged over a safe default environment (PATH, HOME…). Values support env:NAME.">
                <KeyValueEditor value={draft.env} onChange={(env) => patch({ env })} />
              </Field>
              <Field label="Working directory">
                <Input mono value={draft.cwd ?? ""} onChange={(e) => patch({ cwd: e.target.value })} placeholder="(current directory)" />
              </Field>
            </>
          )}
          <Field label="Timeout (ms)">
            <Input type="number" value={draft.timeoutMs ?? ""} onChange={(e) => patch({ timeoutMs: e.target.value ? Number(e.target.value) : undefined })} placeholder="30000" />
          </Field>
        </>
      )}
    </div>
  );

  if (isNew) {
    return (
      <div className="space-y-4">
        {fields}
        <StatePanel state={testState} />
        <div className="flex gap-2">
          <Button variant="outline" size="sm" loading={testing} disabled={!valid} icon={<Plug className="h-3.5 w-3.5" />} onClick={test}>
            Test connection
          </Button>
          <Button variant="primary" size="sm" disabled={!valid} onClick={save}>
            Add server
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1">
        <Section
          title={initial.name}
          description={
            <span className="inline-flex items-center gap-2">
              <StatusDot status={state?.status ?? "idle"} />
              {state?.status ?? "not connected"}
              {state?.serverInfo?.name && ` · ${state.serverInfo.name} ${state.serverInfo.version ?? ""}`}
            </span>
          }
          right={
            <div className="flex gap-1.5">
              {state?.status === "connected" ? (
                <Button size="xs" variant="outline" icon={<Unplug className="h-3 w-3" />} onClick={() => api(`/api/mcp/${initial.id}/disconnect`, { body: {} }).then(() => useStore.getState().refreshMcp())}>
                  Disconnect
                </Button>
              ) : null}
              <Button size="xs" variant="outline" icon={<RefreshCw className="h-3 w-3" />} onClick={() => connectServer(initial.id, true)}>
                {state?.status === "connected" ? "Reconnect" : "Connect"}
              </Button>
            </div>
          }
        >
          {fields}
        </Section>
        {live && live.status !== "connected" && (
          <div className="px-6 pt-5">
            <StatePanel state={live} />
          </div>
        )}
        {state?.status === "connected" && (
          <Section title={`Tools · ${state.tools.length}`} description="Toggle which tools the model can see. Hidden tools stay callable from the Tools view.">
            <div className="divide-y divide-line rounded-xl border border-line">
              {state.tools.length === 0 && <p className="px-4 py-3 text-[13px] text-muted">This server exposes no tools.</p>}
              {state.tools.map((t) => {
                const enabled = !(initial.disabledTools ?? []).includes(t.name);
                return (
                  <div key={t.name} className="flex items-start gap-3 px-4 py-2.5">
                    <Wrench className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", enabled ? "text-accent" : "text-subtle")} />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[12.5px] font-medium">{t.name}</div>
                      {t.description && <div className="mt-0.5 line-clamp-2 text-[12px] text-muted">{t.description}</div>}
                    </div>
                    <Button
                      size="xs"
                      variant="ghost"
                      icon={<Play className="h-3 w-3" />}
                      onClick={() => set({ settingsOpen: false, view: "tools", toolTarget: { serverId: initial.id, tool: t.name } })}
                    >
                      Try
                    </Button>
                    <Switch checked={enabled} onChange={(v) => toggleTool(t.name, v)} label={`Enable ${t.name}`} />
                  </div>
                );
              })}
            </div>
            {(state.resources.length > 0 || state.prompts.length > 0) && (
              <p className="mt-3 text-[12px] text-muted">
                Also exposes {state.resources.length} resources and {state.prompts.length} prompts — browse them in the Tools view.
              </p>
            )}
            {state.instructions && (
              <div className="mt-4">
                <div className="mb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">Server instructions (sent to the model)</div>
                <JsonView value={state.instructions} maxHeight="10rem" />
              </div>
            )}
          </Section>
        )}
      </div>
      <FormFooter>
        <Button variant="danger" size="sm" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={remove}>
          Remove
        </Button>
        <span className="flex-1" />
        <Button variant="outline" size="sm" loading={testing} disabled={!valid} icon={<Plug className="h-3.5 w-3.5" />} onClick={test}>
          Test
        </Button>
        <Button variant="primary" size="sm" disabled={!dirty || !valid} onClick={save}>
          Save & reconnect
        </Button>
      </FormFooter>
    </div>
  );
}

function StatePanel({ state }: { state?: McpServerState }) {
  if (!state) return null;
  const ok = state.status === "connected";
  return (
    <div className={cn("rounded-xl border px-4 py-3 text-[13px]", ok ? "border-ok/30 bg-ok/5" : state.status === "connecting" ? "border-line" : "border-err/30 bg-err/5")}>
      <div className="flex items-center gap-2 font-medium">
        <StatusDot status={state.status} />
        {ok ? `Connected · ${state.tools.length} tools, ${state.resources.length} resources, ${state.prompts.length} prompts` : state.status === "connecting" ? "Connecting…" : "Could not connect"}
      </div>
      {state.error && <p className="mt-1 break-words text-muted">{state.error}</p>}
      {ok && state.tools.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {state.tools.slice(0, 30).map((t) => (
            <Badge key={t.name} className="font-mono">
              {t.name}
            </Badge>
          ))}
        </div>
      )}
      {!ok && state.stderr.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[11px] font-medium text-subtle uppercase">stderr</div>
          <JsonView value={state.stderr.slice(-30).join("\n")} maxHeight="10rem" />
        </div>
      )}
    </div>
  );
}
