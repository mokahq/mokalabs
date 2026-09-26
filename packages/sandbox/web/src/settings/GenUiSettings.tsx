import { AlertTriangle, Box, Braces, CheckCircle2, Code2, FileJson, FlaskConical, Globe, LayoutTemplate, Library, Plus, Sparkles, Trash2, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { A2uiSurfaces, type A2uiAction } from "../components/A2uiSurface";
import { Badge, Button, CopyButton, Empty, Field, Input, JsonView, Select, Spinner, Tabs, Textarea, cn, formatMs } from "../components/ui";
import { useStore } from "../store";
import type { CatalogComponent, CatalogConfig, LoadedCatalog } from "../types";
import { FormFooter, ListItem, MasterDetail, Section } from "./Settings";

type Selection = { kind: "playground" } | { kind: "catalog"; id: string } | { kind: "new" };

/** Survives tab switches so a half-written UI isn't lost. */
const playgroundDraft = {
  text: JSON.stringify(
    {
      components: [
        { id: "root", component: "Card", child: "col" },
        { id: "col", component: "Column", children: ["title", "name", "go"] },
        { id: "title", component: "Text", text: "Join the beta", variant: "h3" },
        { id: "name", component: "TextField", label: "Email", value: { path: "/email" } },
        { id: "go", component: "Button", child: "go-label", variant: "primary", action: { event: { name: "join", context: { email: { path: "/email" } } } } },
        { id: "go-label", component: "Text", text: "Join" },
      ],
      data: { email: "" },
    },
    null,
    2,
  ),
  prompt: "A booking form for a coffee tasting: name, date, party size and a confirm button",
};

export function GenUiSettings() {
  const catalogs = useStore((s) => s.catalogs);
  const [selected, setSelected] = useState<Selection>({ kind: "playground" });
  const current = selected.kind === "catalog" ? catalogs.find((c) => c.id === selected.id) : undefined;

  return (
    <MasterDetail
      list={
        <>
          <div className="space-y-0.5 p-2">
            <ListItem
              active={selected.kind === "playground"}
              onClick={() => setSelected({ kind: "playground" })}
              left={<IconTile><FlaskConical className="h-3.5 w-3.5" /></IconTile>}
              title="Playground"
              subtitle="Try UI JSON, ask a model, see the tool"
            />
          </div>
          <div className="flex items-center justify-between px-4 pt-2 pb-1">
            <span className="text-[11px] font-medium tracking-wide text-subtle uppercase">Catalogs</span>
            <Button size="xs" variant="ghost" icon={<Plus className="h-3 w-3" />} onClick={() => setSelected({ kind: "new" })}>
              Add
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
            {catalogs.map((c) => (
              <ListItem
                key={c.id}
                active={selected.kind === "catalog" && selected.id === c.id}
                onClick={() => setSelected({ kind: "catalog", id: c.id })}
                left={<IconTile>{c.source === "builtin" ? <Library className="h-3.5 w-3.5" /> : <LayoutTemplate className="h-3.5 w-3.5" />}</IconTile>}
                title={c.name}
                subtitle={c.error ? <span className="text-err">{c.error}</span> : `${Object.keys(c.components).length} components · ${c.source}`}
                right={c.error ? <AlertTriangle className="h-3.5 w-3.5 text-err" /> : undefined}
              />
            ))}
          </div>
        </>
      }
      detail={
        selected.kind === "playground" ? (
          <Playground />
        ) : selected.kind === "new" ? (
          <NewCatalog onCreated={(id) => setSelected({ kind: "catalog", id })} />
        ) : current ? (
          <CatalogView key={current.id} catalog={current} onRemoved={() => setSelected({ kind: "playground" })} />
        ) : (
          <Empty icon={<LayoutTemplate className="h-5 w-5" />} title="Catalog not found" />
        )
      }
    />
  );
}

function IconTile({ children }: { children: React.ReactNode }) {
  return <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-panel-2 text-muted">{children}</span>;
}

function useActionToast() {
  const toast = useStore((s) => s.toast);
  return (action: A2uiAction) => toast(`Action "${action.name}" · ${JSON.stringify(action.context)}`, "success");
}

/* ---------------------------------------------------------------- playground */

interface PreviewResult {
  messages: Array<Record<string, any>>;
  problems: string[];
  input?: unknown;
  model?: string;
  durationMs?: number;
  error?: string;
}

function Playground() {
  const config = useStore((s) => s.config);
  const activeId = useStore((s) => s.workspace().id);
  const [workspaceId, setWorkspaceId] = useState(activeId);
  const [tab, setTab] = useState<"json" | "model" | "tool">("json");
  const [text, setText] = useState(playgroundDraft.text);
  const [prompt, setPrompt] = useState(playgroundDraft.prompt);
  const [result, setResult] = useState<PreviewResult>();
  const [parseError, setParseError] = useState<string>();
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<{ model?: string; durationMs?: number }>();
  const [tool, setTool] = useState<{ name: string; description: string; inputSchema: unknown; components: string[]; enabled: boolean }>();
  const onAction = useActionToast();
  const ws = config.workspaces.find((w) => w.id === workspaceId);

  useEffect(() => {
    playgroundDraft.text = text;
    playgroundDraft.prompt = prompt;
  }, [text, prompt]);

  // Live preview, debounced.
  useEffect(() => {
    let input: unknown;
    try {
      input = JSON.parse(text);
      setParseError(undefined);
    } catch (e: any) {
      setParseError(e?.message ?? "Invalid JSON");
      return;
    }
    const timer = setTimeout(() => {
      api<PreviewResult>("/api/ui/preview", { body: { input, workspaceId } })
        .then(setResult)
        .catch((e) => setResult({ messages: [], problems: [e?.message ?? String(e)] }));
    }, 250);
    return () => clearTimeout(timer);
  }, [text, workspaceId, config]);

  useEffect(() => {
    if (tab !== "tool") return;
    api(`/api/ui/tool?workspaceId=${encodeURIComponent(workspaceId)}`).then(setTool).catch(() => setTool(undefined));
  }, [tab, workspaceId, config]);

  const generate = async () => {
    setGenerating(true);
    setGenerated(undefined);
    try {
      const res = await api<PreviewResult>("/api/ui/generate", { body: { prompt, workspaceId } });
      if (res.input) setText(JSON.stringify(res.input, null, 2));
      setGenerated({ model: res.model, durationMs: res.durationMs });
      setTab("json");
    } catch (e: any) {
      useStore.getState().toast(e?.message ?? "Generation failed", "error");
    } finally {
      setGenerating(false);
    }
  };

  const problems = parseError ? [`JSON: ${parseError}`] : (result?.problems ?? []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "json", label: "UI JSON", icon: <Braces className="h-3.5 w-3.5" /> },
            { value: "model", label: "Ask a model", icon: <Wand2 className="h-3.5 w-3.5" /> },
            { value: "tool", label: "What the model sees", icon: <Code2 className="h-3.5 w-3.5" /> },
          ]}
        />
        <span className="flex-1" />
        <span className="text-[12px] text-muted">Workspace</span>
        <Select className="w-44" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
          {config.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      </div>

      {tab === "tool" ? (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {!tool ? (
            <Spinner />
          ) : (
            <>
              {!tool.enabled && <p className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-[13px] text-warn">Generative UI is off in this workspace. The model won't get this tool.</p>}
              <div className="flex items-center gap-2">
                <Badge tone="violet" className="font-mono">{tool.name}</Badge>
                <span className="text-[12px] text-muted">{tool.components.length} components · {tool.description.length.toLocaleString()} chars</span>
                <span className="flex-1" />
                <CopyButton text={tool.description} label="Copy description" />
              </div>
              <pre className="max-h-[26rem] overflow-auto rounded-xl border border-line bg-panel-2/50 p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{tool.description}</pre>
              <div>
                <div className="mb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">Input schema</div>
                <JsonView value={tool.inputSchema} maxHeight="18rem" />
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-2">
          <div className="flex min-h-0 flex-col border-b border-line lg:border-r lg:border-b-0">
            {tab === "model" ? (
              <div className="space-y-3 p-5">
                <Field label="Prompt" hint={`Uses ${ws?.llmId ? config.llms.find((l) => l.id === ws.llmId)?.name ?? "the workspace model" : "the first model"} with only the render tool, so you can see how well it uses your catalog.`}>
                  <Textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
                </Field>
                <Button variant="primary" size="sm" loading={generating} disabled={!prompt.trim() || config.llms.length === 0} icon={<Sparkles className="h-3.5 w-3.5" />} onClick={generate}>
                  Generate UI
                </Button>
                {config.llms.length === 0 && <p className="text-[12.5px] text-muted">Add a model first.</p>}
              </div>
            ) : (
              <textarea
                spellCheck={false}
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="min-h-[18rem] flex-1 resize-none bg-panel-2/40 p-4 font-mono text-[12px] leading-relaxed focus:outline-none"
              />
            )}
          </div>
          <div className="min-h-0 overflow-y-auto p-5">
            <div className="mb-3 flex items-center gap-2 text-[12px]">
              {problems.length ? (
                <Badge tone="warn">
                  <AlertTriangle className="h-3 w-3" /> {problems.length} {problems.length === 1 ? "problem" : "problems"}
                </Badge>
              ) : (
                <Badge tone="ok">
                  <CheckCircle2 className="h-3 w-3" /> Valid
                </Badge>
              )}
              {generated?.model && (
                <span className="text-subtle">
                  generated by {generated.model} in {formatMs(generated.durationMs)}
                </span>
              )}
            </div>
            {problems.length > 0 && (
              <ul className="mb-4 space-y-1 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-[12.5px] text-muted">
                {problems.map((p, i) => (
                  <li key={i}>• {p}</li>
                ))}
              </ul>
            )}
            {result && result.messages.length > 0 ? (
              <A2uiSurfaces messages={result.messages} onAction={onAction} header={false} />
            ) : (
              !problems.length && <p className="text-[13px] text-muted">Nothing to show yet.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- catalog view */

function kindOf(c: CatalogComponent): "builtin" | "template" | "html" {
  return c.builtin ? "builtin" : c.template ? "template" : "html";
}

function signature(component: CatalogComponent): string {
  const required = new Set(component.required ?? []);
  return Object.entries(component.props ?? {})
    .map(([name, schema]) => `${name}${required.has(name) ? "" : "?"}${Array.isArray(schema?.enum) ? `: ${schema.enum.map((v) => JSON.stringify(v)).join("|")}` : ""}`)
    .join(", ");
}

function CatalogView({ catalog, onRemoved }: { catalog: LoadedCatalog; onRemoved: () => void }) {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const entry = config.catalogs.find((c) => c.id === catalog.id);
  const usedBy = config.workspaces.filter((w) => typeof w.generativeUi === "object" && w.generativeUi.catalogIds?.includes(catalog.id));
  const [editing, setEditing] = useState(false);

  const remove = async () => {
    if (!confirm(`Remove catalog "${catalog.name}"?`)) return;
    const ok = await saveConfig(
      {
        ...config,
        catalogs: config.catalogs.filter((c) => c.id !== catalog.id),
        workspaces: config.workspaces.map((w) =>
          typeof w.generativeUi === "object" && w.generativeUi.catalogIds?.includes(catalog.id)
            ? { ...w, generativeUi: { ...w.generativeUi, catalogIds: w.generativeUi.catalogIds.filter((id) => id !== catalog.id) } }
            : w,
        ),
      },
      "Catalog removed",
    );
    if (ok) onRemoved();
  };

  const toggleWorkspace = async (wsId: string, on: boolean) => {
    await saveConfig(
      {
        ...config,
        workspaces: config.workspaces.map((w) => {
          if (w.id !== wsId) return w;
          const gen = typeof w.generativeUi === "object" ? w.generativeUi : w.generativeUi === false ? { enabled: false } : {};
          const ids = new Set(gen.catalogIds ?? []);
          if (on) ids.add(catalog.id);
          else ids.delete(catalog.id);
          return { ...w, generativeUi: { ...gen, catalogIds: [...ids] } };
        }),
      },
      on ? "Catalog enabled" : "Catalog disabled",
    );
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1">
        <Section
          title={catalog.name}
          description={
            <span className="font-mono text-[11.5px]">
              {catalog.catalogId}
              {catalog.path ? ` · ${catalog.path}` : ""}
            </span>
          }
          right={<Badge tone={catalog.source === "builtin" ? "accent" : "violet"}>{catalog.source}</Badge>}
        >
          {catalog.description && <p className="mb-3 text-[13px] text-muted">{catalog.description}</p>}
          {catalog.error && <p className="mb-3 rounded-lg border border-err/30 bg-err/5 px-3 py-2 text-[13px] text-err">{catalog.error}</p>}
          {catalog.source !== "builtin" && (
            <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
              <span className="text-muted">Use in:</span>
              {config.workspaces.map((w) => {
                const on = usedBy.some((u) => u.id === w.id);
                return (
                  <button
                    key={w.id}
                    onClick={() => toggleWorkspace(w.id, !on)}
                    className={cn("rounded-full border px-2.5 py-0.5 transition-colors", on ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:bg-panel-2")}
                  >
                    {on && <CheckCircle2 className="mr-1 inline h-3 w-3" />}
                    {w.name}
                  </button>
                );
              })}
            </div>
          )}
          {catalog.instructions && (
            <p className="mt-3 text-[12.5px] text-muted">
              <span className="font-medium text-fg">Model instructions:</span> {catalog.instructions}
            </p>
          )}
        </Section>
        {editing && entry ? (
          <Section title="Edit catalog">
            <CatalogForm initial={entry} onDone={() => setEditing(false)} />
          </Section>
        ) : (
          <Section title={`Components · ${Object.keys(catalog.components).length}`}>
            <div className="grid gap-3 xl:grid-cols-2">
              {Object.entries(catalog.components).map(([name, component]) => (
                <ComponentCard key={name} catalogId={catalog.id} name={name} component={component} />
              ))}
            </div>
          </Section>
        )}
      </div>
      {entry && (
        <FormFooter>
          <Button variant="danger" size="sm" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={remove}>
            Remove
          </Button>
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => setEditing(!editing)}>
            {editing ? "Cancel" : "Edit"}
          </Button>
        </FormFooter>
      )}
    </div>
  );
}

function ComponentCard({ catalogId, name, component }: { catalogId: string; name: string; component: CatalogComponent }) {
  const [preview, setPreview] = useState<PreviewResult>();
  const [open, setOpen] = useState(false);
  const onAction = useActionToast();
  const kind = kindOf(component);
  const ref = useRef(false);

  useEffect(() => {
    if (!open || ref.current) return;
    ref.current = true;
    api<PreviewResult>("/api/ui/preview", { body: { component: { catalogId, name } } }).then(setPreview).catch(() => {});
  }, [open, catalogId, name]);

  return (
    <div className="rounded-xl border border-line bg-panel">
      <button className="flex w-full items-start gap-2.5 px-3.5 py-3 text-left" onClick={() => setOpen(!open)}>
        <Box className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] font-medium">{name}</span>
            <Badge tone={kind === "builtin" ? "neutral" : kind === "template" ? "violet" : "info"}>{kind}</Badge>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-subtle">{`{${signature(component)}}`}</div>
          {component.description && <div className="mt-1 text-[12.5px] text-muted">{component.description}</div>}
        </div>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line p-3.5">
          {!preview ? (
            <Spinner />
          ) : preview.problems.length ? (
            <p className="text-[12.5px] text-warn">{preview.problems.join("; ")}</p>
          ) : (
            <A2uiSurfaces messages={preview.messages} onAction={onAction} header={false} />
          )}
          {preview?.input !== undefined && (
            <div className="flex gap-2">
              <Button
                size="xs"
                variant="outline"
                icon={<FlaskConical className="h-3 w-3" />}
                onClick={() => {
                  playgroundDraft.text = JSON.stringify(preview.input, null, 2);
                  useStore.getState().toast("Copied into the playground", "success");
                }}
              >
                Send to playground
              </Button>
              <CopyButton text={JSON.stringify(preview.input, null, 2)} label="Copy JSON" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- add / edit */

const STARTER_CATALOG = {
  name: "My components",
  description: "Branded building blocks for demos",
  instructions: "Use StatCard for any single number the user should notice.",
  components: {
    StatCard: {
      description: "A big number with a label and an optional trend",
      props: {
        label: { type: "string" },
        value: { type: "string" },
        trend: { type: "string", enum: ["up", "down", "flat"], default: "flat" },
      },
      required: ["label", "value"],
      template: [
        { id: "root", component: "Card", child: "col" },
        { id: "col", component: "Column", children: ["label", "value", "trend"] },
        { id: "label", component: "Text", text: "{{label}}", variant: "caption" },
        { id: "value", component: "Text", text: "{{value}}", variant: "h2" },
        { id: "trend", component: "Text", text: "Trend: {{trend}}", variant: "caption" },
      ],
      example: { label: "Monthly active users", value: "12,480", trend: "up" },
    },
    Meter: {
      description: "A horizontal progress meter (0-100)",
      props: { value: { type: "number" }, label: { type: "string" } },
      required: ["value"],
      html: "<div id=l style='font-size:12px;color:var(--moka-muted)'></div><div style='height:10px;border-radius:99px;background:var(--moka-panel-2);overflow:hidden'><div id=b style='height:100%;width:0;background:var(--moka-accent);transition:width .4s'></div></div><script>moka.onProps(function(p){document.getElementById('l').textContent=(p.label||'')+' '+(p.value??0)+'%';document.getElementById('b').style.width=Math.max(0,Math.min(100,Number(p.value)||0))+'%'})</script>",
      height: 34,
      example: { value: 72, label: "Storage used" },
    },
  },
  examples: [{ prompt: "how many users do we have?", components: [{ id: "root", component: "StatCard", label: "Users", value: "12,480", trend: "up" }] }],
};

function NewCatalog({ onCreated }: { onCreated: (id: string) => void }) {
  return (
    <div className="p-6">
      <h3 className="text-[15px] font-semibold">Add a component catalog</h3>
      <p className="mt-1 mb-5 max-w-2xl text-[13px] text-muted">
        A catalog adds components the model can use in generative UI. <b>Template</b> components are built from standard ones with <code className="font-mono">{"{{prop}}"}</code> placeholders. <b>HTML</b> components run
        your own markup in a sandbox. Start from the example to see both.
      </p>
      <CatalogForm onDone={(id) => id && onCreated(id)} />
    </div>
  );
}

function CatalogForm({ initial, onDone }: { initial?: CatalogConfig; onDone: (id?: string) => void }) {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [source, setSource] = useState<"inline" | "path" | "url">(initial?.url ? "url" : initial?.path ? "path" : "inline");
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [path, setPath] = useState(initial?.path ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [json, setJson] = useState(initial?.catalog ? JSON.stringify(initial.catalog, null, 2) : JSON.stringify(STARTER_CATALOG, null, 2));
  const [check, setCheck] = useState<LoadedCatalog>();
  const [checking, setChecking] = useState(false);

  const built = useMemo((): CatalogConfig | string => {
    const cid = (id || name || "catalog").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "catalog";
    const base: CatalogConfig = { id: initial?.id ?? cid, ...(name ? { name } : {}) };
    if (source === "path") return path.trim() ? { ...base, path: path.trim() } : "Enter a file path";
    if (source === "url") return /^https?:\/\//.test(url) ? { ...base, url: url.trim() } : "Enter an http(s) URL";
    try {
      return { ...base, catalog: JSON.parse(json) };
    } catch (e: any) {
      return `JSON: ${e?.message}`;
    }
  }, [id, name, source, path, url, json, initial?.id]);

  const run = async () => {
    if (typeof built === "string") return;
    setChecking(true);
    try {
      const { catalog } = await api<{ catalog: LoadedCatalog }>("/api/catalogs/preview", { body: { catalog: built } });
      setCheck(catalog);
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    if (typeof built === "string") return;
    if (!initial && config.catalogs.some((c) => c.id === built.id)) {
      useStore.getState().toast(`A catalog with id "${built.id}" already exists`, "error");
      return;
    }
    const catalogs = initial ? config.catalogs.map((c) => (c.id === initial.id ? built : c)) : [...config.catalogs, built];
    if (await saveConfig({ ...config, catalogs }, initial ? "Catalog saved" : "Catalog added")) onDone(built.id);
  };

  return (
    <div className="space-y-4">
      <Tabs
        value={source}
        onChange={(v) => {
          setSource(v);
          setCheck(undefined);
        }}
        items={[
          { value: "inline", label: "JSON", icon: <FileJson className="h-3.5 w-3.5" /> },
          { value: "path", label: "File", icon: <Braces className="h-3.5 w-3.5" /> },
          { value: "url", label: "URL", icon: <Globe className="h-3.5 w-3.5" /> },
        ]}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {!initial && (
          <Field label="Id" hint="Referenced from workspaces. Defaults to the name.">
            <Input mono value={id} onChange={(e) => setId(e.target.value)} placeholder="banking" />
          </Field>
        )}
        <Field label="Display name" hint="Optional; overrides the catalog's own name.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Banking" />
        </Field>
        {source === "path" && (
          <Field label="Catalog file" className="sm:col-span-2" hint="JSON file, relative to your moka.json. htmlFile paths resolve next to it.">
            <Input mono value={path} onChange={(e) => setPath(e.target.value)} placeholder="./catalogs/banking.json" />
          </Field>
        )}
        {source === "url" && (
          <Field label="Catalog URL" className="sm:col-span-2" hint="Fetched when a chat starts (cached for a minute).">
            <Input mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/catalog.json" />
          </Field>
        )}
        {source === "inline" && (
          <Field label="Catalog JSON" className="sm:col-span-2">
            <Textarea mono rows={16} value={json} onChange={(e) => setJson(e.target.value)} />
          </Field>
        )}
      </div>
      {typeof built === "string" && <p className="text-[12.5px] text-warn">{built}</p>}
      {check && (
        <div className={cn("rounded-xl border px-4 py-3 text-[13px]", check.error ? "border-err/30 bg-err/5" : "border-ok/30 bg-ok/5")}>
          {check.error ? (
            <span className="text-err">{check.error}</span>
          ) : (
            <>
              <div className="font-medium">
                {check.name} · {Object.keys(check.components).length} components
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {Object.entries(check.components).map(([n, c]) => (
                  <Badge key={n} className="font-mono">
                    {n} · {kindOf(c)}
                  </Badge>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" loading={checking} disabled={typeof built === "string"} onClick={run}>
          Check
        </Button>
        <Button variant="primary" size="sm" disabled={typeof built === "string"} onClick={save}>
          {initial ? "Save catalog" : "Add catalog"}
        </Button>
        {initial && (
          <Button variant="ghost" size="sm" onClick={() => onDone()}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
