import { CheckCircle2, Copy, Layers, LayoutTemplate, Plus, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Empty, Field, Input, Select, StatusDot, Switch, Textarea, cn } from "../components/ui";
import { useStore } from "../store";
import type { GenerativeUiConfig, Workspace } from "../types";
import { FormFooter, ListItem, MasterDetail, Section } from "./Settings";

export function WorkspaceSettings() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [selected, setSelected] = useState<string>(config.activeWorkspaceId ?? config.workspaces[0]!.id);
  useEffect(() => {
    if (!config.workspaces.some((w) => w.id === selected)) setSelected(config.workspaces[0]!.id);
  }, [config.workspaces, selected]);

  const create = async (base?: Workspace) => {
    const taken = new Set(config.workspaces.map((w) => w.id));
    let id = base ? `${base.id}-copy` : "workspace";
    for (let i = 2; taken.has(id); i++) id = `${base ? `${base.id}-copy` : "workspace"}-${i}`;
    const ws: Workspace = base
      ? { ...base, id, name: `${base.name} (copy)` }
      : { id, name: "New workspace", llmId: config.llms[0]?.id, mcpServerIds: [], skillIds: [], starterPrompts: [] };
    if (await saveConfig({ ...config, workspaces: [...config.workspaces, ws] }, "Workspace created")) setSelected(id);
  };

  const current = config.workspaces.find((w) => w.id === selected);
  return (
    <MasterDetail
      list={
        <>
          <div className="p-3">
            <Button className="w-full" variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => create()}>
              New workspace
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
            {config.workspaces.map((w) => (
              <ListItem
                key={w.id}
                active={selected === w.id}
                onClick={() => setSelected(w.id)}
                left={
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-panel-2 text-muted">
                    <Layers className="h-3.5 w-3.5" />
                  </span>
                }
                title={w.name}
                subtitle={`${config.llms.find((l) => l.id === w.llmId)?.name ?? "no model"} · ${w.mcpServerIds.length} servers · ${w.skillIds.length} skills`}
                right={config.activeWorkspaceId === w.id ? <CheckCircle2 className="h-3.5 w-3.5 text-accent" /> : undefined}
              />
            ))}
          </div>
        </>
      }
      detail={current ? <WorkspaceForm key={current.id} initial={current} onDuplicate={() => create(current)} /> : <Empty icon={<Layers className="h-5 w-5" />} title="No workspace" />}
    />
  );
}

function WorkspaceForm({ initial, onDuplicate }: { initial: Workspace; onDuplicate: () => void }) {
  const config = useStore((s) => s.config);
  const mcp = useStore((s) => s.mcp);
  const skills = useStore((s) => s.skills);
  const saveConfig = useStore((s) => s.saveConfig);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const [draft, setDraft] = useState<Workspace>(initial);
  const [starters, setStarters] = useState((initial.starterPrompts ?? []).join("\n"));
  const built: Workspace = useMemo(() => {
    const out: any = { ...draft, starterPrompts: starters.split("\n").map((s) => s.trim()).filter(Boolean) };
    if (!out.systemPrompt) delete out.systemPrompt;
    if (!out.llmId) delete out.llmId;
    if (!out.agentId) delete out.agentId;
    if (!out.maxSteps) delete out.maxSteps;
    if (!out.requireApproval) delete out.requireApproval;
    if (out.generativeUi && typeof out.generativeUi === "object") {
      const g: any = { ...out.generativeUi };
      for (const k of Object.keys(g)) {
        const v = g[k];
        if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)) delete g[k];
      }
      if (g.theme) {
        g.theme = Object.fromEntries(Object.entries(g.theme).filter(([, v]) => v !== undefined && v !== ""));
        if (Object.keys(g.theme).length === 0) delete g.theme;
      }
      out.generativeUi = Object.keys(g).length === 0 ? undefined : g.enabled === false && Object.keys(g).length === 1 ? false : g;
      if (out.generativeUi === undefined) delete out.generativeUi;
    }
    return out;
  }, [draft, starters]);
  const dirty = JSON.stringify(built) !== JSON.stringify({ ...initial, starterPrompts: initial.starterPrompts ?? [] });
  const toggle = (key: "mcpServerIds" | "skillIds", id: string) =>
    setDraft((d) => ({ ...d, [key]: d[key].includes(id) ? d[key].filter((x) => x !== id) : [...d[key], id] }));
  const active = config.activeWorkspaceId === initial.id;

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1">
        <Section
          title={initial.name}
          description="A workspace bundles a model, tools, skills and a system prompt — perfect for switching between demos."
          right={
            active ? (
              <Badge tone="accent">Active</Badge>
            ) : (
              <Button size="xs" variant="outline" onClick={() => setActiveWorkspace(initial.id)}>
                Switch to this
              </Button>
            )
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="Model">
              <Select value={draft.llmId ?? ""} onChange={(e) => setDraft({ ...draft, llmId: e.target.value || undefined })}>
                <option value="">— none —</option>
                {config.llms.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} · {l.model}
                  </option>
                ))}
              </Select>
            </Field>
            {config.agents.length > 0 && (
              <Field label="Agent" hint="Chat with a remote agent instead of the model. MCP servers are shared with AG-UI agents that accept tools.">
                <Select value={draft.agentId ?? ""} onChange={(e) => setDraft({ ...draft, agentId: e.target.value || undefined })}>
                  <option value="">— none (use the model) —</option>
                  {config.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.protocol === "a2a" ? "A2A" : "AG-UI"}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="System prompt" className="sm:col-span-2">
              <Textarea rows={5} value={draft.systemPrompt ?? ""} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })} placeholder="You are a helpful assistant…" />
            </Field>
            <Field label="Starter prompts" className="sm:col-span-2" hint="One per line. Shown as one-click chips on an empty chat — great for demos.">
              <Textarea rows={4} value={starters} onChange={(e) => setStarters(e.target.value)} />
            </Field>
            <Field label="Ask before every tool call" hint="Safe mode for live demos: the model waits for your OK before any MCP tool runs.">
              <div className="flex items-center gap-2 text-[12.5px] text-muted">
                <Switch checked={Boolean(draft.requireApproval)} onChange={(v) => setDraft({ ...draft, requireApproval: v || undefined })} />
                <ShieldCheck className="h-3.5 w-3.5" /> per-server rules still apply when off
              </div>
            </Field>
            <Field label="Max agent steps" hint="Upper bound on model ↔ tool round-trips per message.">
              <Input type="number" min={1} max={100} value={draft.maxSteps ?? ""} onChange={(e) => setDraft({ ...draft, maxSteps: e.target.value ? Number(e.target.value) : undefined })} placeholder="12" />
            </Field>
          </div>
        </Section>
        <GenerativeUiSection value={draft.generativeUi} onChange={(generativeUi) => setDraft({ ...draft, generativeUi })} />
        <Section title="MCP servers" description="Tools from these servers are available to the model in this workspace.">
          {config.mcpServers.length === 0 ? (
            <p className="text-[13px] text-muted">No servers yet — add one under MCP servers.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {config.mcpServers.map((s) => {
                const on = draft.mcpServerIds.includes(s.id);
                const st = mcp[s.id];
                return (
                  <button
                    key={s.id}
                    onClick={() => toggle("mcpServerIds", s.id)}
                    className={cn("flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors", on ? "border-accent/50 bg-accent-soft/60" : "border-line hover:bg-panel-2")}
                  >
                    <input type="checkbox" readOnly checked={on} className="pointer-events-none accent-[var(--accent)]" />
                    <StatusDot status={st?.status ?? "idle"} />
                    <span className="flex-1 truncate text-[13px] font-medium">{s.name}</span>
                    {st?.status === "connected" && <span className="font-mono text-[11px] text-subtle">{st.tools.length} tools</span>}
                  </button>
                );
              })}
            </div>
          )}
        </Section>
        <Section title="Skills">
          {config.skills.length === 0 ? (
            <p className="text-[13px] text-muted">No skills yet — add one under Skills.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {config.skills.map((s) => {
                const on = draft.skillIds.includes(s.id);
                const l = skills.find((x) => x.id === s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => toggle("skillIds", s.id)}
                    className={cn("flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors", on ? "border-accent/50 bg-accent-soft/60" : "border-line hover:bg-panel-2")}
                  >
                    <input type="checkbox" readOnly checked={on} className="pointer-events-none accent-[var(--accent)]" />
                    <Sparkles className="h-3.5 w-3.5 text-violet" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{l?.name ?? s.name ?? s.id}</span>
                      <span className="block truncate text-[11.5px] text-muted">{l?.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Section>
      </div>
      <FormFooter>
        <Button
          variant="danger"
          size="sm"
          disabled={config.workspaces.length <= 1}
          icon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={async () => {
            if (!confirm(`Delete workspace "${initial.name}"?`)) return;
            const rest = config.workspaces.filter((w) => w.id !== initial.id);
            await saveConfig(
              { ...config, workspaces: rest, activeWorkspaceId: active ? rest[0]!.id : config.activeWorkspaceId },
              "Workspace deleted",
            );
          }}
        >
          Delete
        </Button>
        <Button variant="ghost" size="sm" icon={<Copy className="h-3.5 w-3.5" />} onClick={onDuplicate}>
          Duplicate
        </Button>
        <span className="flex-1" />
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || !draft.name.trim()}
          onClick={async () => {
            const ok = await saveConfig({ ...config, workspaces: config.workspaces.map((w) => (w.id === initial.id ? built : w)) }, "Workspace saved");
            if (ok) for (const id of built.mcpServerIds) void useStore.getState().connectServer(id);
          }}
        >
          Save changes
        </Button>
      </FormFooter>
    </div>
  );
}

function GenerativeUiSection({ value, onChange }: { value: Workspace["generativeUi"]; onChange: (v: Workspace["generativeUi"]) => void }) {
  const catalogs = useStore((s) => s.catalogs);
  const openSettings = useStore((s) => s.openSettings);
  const g: GenerativeUiConfig = typeof value === "object" && value ? value : value === false ? { enabled: false } : {};
  const enabled = g.enabled !== false;
  const patch = (p: Partial<GenerativeUiConfig>) => onChange({ ...g, ...p });
  const custom = catalogs.filter((c) => c.source !== "builtin");
  const selected = new Set(g.catalogIds ?? []);
  const available = [
    ...(g.standard !== false ? Object.keys(catalogs.find((c) => c.source === "builtin")?.components ?? {}) : []),
    ...custom.filter((c) => selected.has(c.id)).flatMap((c) => Object.keys(c.components)),
  ];
  const denied = new Set(g.deny ?? []);
  const theme = g.theme ?? {};

  return (
    <Section
      title="Generative UI"
      description="Let the model answer with forms, cards and buttons (A2UI). Choose its components, name and style."
      right={<Switch checked={enabled} onChange={(v) => patch({ enabled: v ? undefined : false })} label="Enable generative UI" />}
    >
      {!enabled ? (
        <p className="text-[13px] text-muted">Off. The model won't get a UI tool (MCP Apps and A2UI from MCP servers still render).</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tool name" hint="What the model calls. Rename it to match your production agent.">
            <Input mono value={g.toolName ?? ""} onChange={(e) => patch({ toolName: e.target.value || undefined })} placeholder="render_ui" />
          </Field>
          <Field label="Validation" hint="Send UI errors back so the model fixes them itself.">
            <div className="flex h-9 items-center gap-2 text-[12.5px] text-muted">
              <Switch checked={g.repair !== false} onChange={(v) => patch({ repair: v ? undefined : false })} /> Self-repair
              <span className="w-3" />
              <Switch checked={g.examples !== false} onChange={(v) => patch({ examples: v ? undefined : false })} /> Include examples
            </div>
          </Field>
          <Field label="Catalogs" className="sm:col-span-2" hint="The standard catalog plus any of yours. Add catalogs under Generative UI.">
            <div className="flex flex-wrap gap-1.5">
              <ChipToggle on={g.standard !== false} onClick={() => patch({ standard: g.standard === false ? undefined : false })}>
                A2UI standard
              </ChipToggle>
              {custom.map((c) => (
                <ChipToggle
                  key={c.id}
                  on={selected.has(c.id)}
                  onClick={() => patch({ catalogIds: selected.has(c.id) ? [...selected].filter((x) => x !== c.id) : [...selected, c.id] })}
                >
                  <LayoutTemplate className="h-3 w-3" /> {c.name}
                </ChipToggle>
              ))}
              <button className="rounded-full border border-dashed border-line px-2.5 py-0.5 text-[12.5px] text-muted hover:text-fg" onClick={() => openSettings("genui")}>
                <Plus className="mr-0.5 inline h-3 w-3" /> Add catalog
              </button>
            </div>
          </Field>
          {available.length > 0 && (
            <Field label="Components" className="sm:col-span-2" hint="Click to hide a component from the model.">
              <div className="flex flex-wrap gap-1">
                {available.map((name) => (
                  <button
                    key={name}
                    onClick={() => patch({ deny: denied.has(name) ? [...denied].filter((d) => d !== name) : [...denied, name] })}
                    className={cn("rounded-md border px-1.5 py-0.5 font-mono text-[11.5px] transition-colors", denied.has(name) ? "border-line text-subtle line-through" : "border-line-strong text-fg hover:bg-panel-2")}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </Field>
          )}
          <Field label="Extra instructions" className="sm:col-span-2" hint="Appended to the tool description, e.g. when to prefer which component.">
            <Textarea rows={3} value={g.instructions ?? ""} onChange={(e) => patch({ instructions: e.target.value || undefined })} placeholder="Prefer Cards for results. Only use forms when you need 3+ fields." />
          </Field>
          <Field label="Accent color">
            <div className="flex gap-2">
              <input type="color" value={theme.primaryColor ?? "#b8622c"} onChange={(e) => patch({ theme: { ...theme, primaryColor: e.target.value } })} className="h-9 w-10 cursor-pointer rounded-lg border border-line bg-panel" />
              <Input mono value={theme.primaryColor ?? ""} onChange={(e) => patch({ theme: { ...theme, primaryColor: e.target.value || undefined } })} placeholder="(Moka default)" />
            </div>
          </Field>
          <Field label="Corner radius (px)">
            <Input type="number" min={0} max={40} value={theme.radius ?? ""} onChange={(e) => patch({ theme: { ...theme, radius: e.target.value === "" ? undefined : Number(e.target.value) } })} placeholder="12" />
          </Field>
          <Field label="Font">
            <Input value={theme.font ?? ""} onChange={(e) => patch({ theme: { ...theme, font: e.target.value || undefined } })} placeholder="Inter" />
          </Field>
          <Field label="Agent name on UIs" hint="Shown above each surface, e.g. your product's assistant name.">
            <Input value={theme.agentDisplayName ?? ""} onChange={(e) => patch({ theme: { ...theme, agentDisplayName: e.target.value || undefined } })} placeholder="Acme Assistant" />
          </Field>
          <Field label="Density">
            <div className="flex h-9 items-center gap-2 text-[12.5px] text-muted">
              <Switch checked={theme.density === "compact"} onChange={(v) => patch({ theme: { ...theme, density: v ? "compact" : undefined } })} /> Compact
            </div>
          </Field>
        </div>
      )}
    </Section>
  );
}

function ChipToggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[12.5px] transition-colors", on ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:bg-panel-2")}
    >
      {on && <CheckCircle2 className="h-3 w-3" />}
      {children}
    </button>
  );
}
