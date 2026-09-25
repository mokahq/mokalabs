import { CheckCircle2, Plus, Trash2, Workflow, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Badge, Button, Empty, Field, Input, KeyValueEditor, Switch, Tabs, cn, formatMs } from "../components/ui";
import { useStore } from "../store";
import type { AgentConfig, AgentProtocol } from "../types";
import { FormFooter, ListItem, MasterDetail, Section } from "./Settings";

interface TestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  text?: string;
  events?: string[];
  card?: {
    name?: string;
    description?: string;
    url?: string;
    version?: string;
    capabilities?: { streaming?: boolean; extensions?: Array<{ uri: string }> };
    skills?: Array<{ id?: string; name?: string; description?: string; examples?: string[] }>;
  };
}

const PRESETS: Array<{ label: string; hint: string; agent: Omit<AgentConfig, "id"> }> = [
  { label: "Moka demo agent · A2A", hint: "Run `npx @mokalabs/sandbox demo-agent` first", agent: { name: "Demo agent (A2A)", protocol: "a2a", url: "http://localhost:4100/.well-known/agent-card.json" } },
  { label: "Moka demo agent · AG-UI", hint: "Same demo agent, AG-UI endpoint", agent: { name: "Demo agent (AG-UI)", protocol: "ag-ui", url: "http://localhost:4100/agui", shareTools: true } },
  { label: "LangGraph (AG-UI)", hint: "ag-ui-langgraph / CopilotKit runtime endpoint", agent: { name: "LangGraph agent", protocol: "ag-ui", url: "http://localhost:8000/agent", shareTools: true } },
  { label: "Any A2A agent", hint: "Paste its agent card URL", agent: { name: "A2A agent", protocol: "a2a", url: "https://example.com/.well-known/agent-card.json" } },
];

export function AgentSettings() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [selected, setSelected] = useState<string | "new">(config.agents[0]?.id ?? "new");
  useEffect(() => {
    if (selected !== "new" && !config.agents.some((a) => a.id === selected)) setSelected(config.agents[0]?.id ?? "new");
  }, [config.agents, selected]);

  const add = async (preset: Omit<AgentConfig, "id">) => {
    const taken = new Set(config.agents.map((a) => a.id));
    const baseId = preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    let id = baseId;
    for (let i = 2; taken.has(id); i++) id = `${baseId}-${i}`;
    if (await saveConfig({ ...config, agents: [...config.agents, { ...preset, id }] }, "Agent added")) setSelected(id);
  };

  const current = config.agents.find((a) => a.id === selected);
  return (
    <MasterDetail
      list={
        <>
          <div className="p-3">
            <Button className="w-full" variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setSelected("new")}>
              Connect an agent
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
            {config.agents.map((a) => (
              <ListItem
                key={a.id}
                active={selected === a.id}
                onClick={() => setSelected(a.id)}
                left={
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-panel-2 text-violet">
                    <Workflow className="h-3.5 w-3.5" />
                  </span>
                }
                title={a.name}
                subtitle={`${a.protocol === "a2a" ? "A2A" : "AG-UI"} · ${a.url.replace(/^https?:\/\//, "")}`}
              />
            ))}
          </div>
        </>
      }
      detail={
        current ? (
          <AgentForm key={current.id} initial={current} />
        ) : (
          <div className="p-6">
            <h3 className="text-[15px] font-semibold">Connect a remote agent</h3>
            <p className="mt-1 mb-5 max-w-2xl text-[13px] text-muted">
              Chat with an agent you already built instead of a raw model. Moka gives it the chat UI, generative UI (A2UI) and the inspector. <b>A2A</b> agents keep their own conversation state. <b>AG-UI</b> agents (LangGraph,
              CopilotKit, Mastra…) can also call this workspace's MCP tools as frontend tools.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {PRESETS.map((p) => (
                <button key={p.label} onClick={() => add(p.agent)} className="rounded-xl border border-line bg-panel px-4 py-3 text-left transition-colors hover:border-accent/40">
                  <div className="text-[13.5px] font-medium">{p.label}</div>
                  <div className="mt-0.5 text-[12px] text-muted">{p.hint}</div>
                </button>
              ))}
            </div>
            {config.agents.length === 0 && (
              <div className="mt-6">
                <Empty icon={<Workflow className="h-5 w-5" />} title="No agents yet">
                  Pick a preset above, then edit its URL.
                </Empty>
              </div>
            )}
          </div>
        )
      }
    />
  );
}

function AgentForm({ initial }: { initial: AgentConfig }) {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const setWorkspaceModel = useStore((s) => s.setWorkspaceModel);
  const workspace = useStore((s) => s.workspace());
  const [draft, setDraft] = useState<AgentConfig>(initial);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult>();
  const built = useMemo(() => {
    const out: any = { ...draft };
    if (!out.headers || Object.keys(out.headers).length === 0) delete out.headers;
    if (out.protocol !== "ag-ui" || !out.shareTools) delete out.shareTools;
    return out as AgentConfig;
  }, [draft]);
  const dirty = JSON.stringify(built) !== JSON.stringify(initial);
  const valid = draft.name.trim() && /^https?:\/\//.test(draft.url);
  const patch = (p: Partial<AgentConfig>) => setDraft((d) => ({ ...d, ...p }));
  const active = workspace.agentId === initial.id;

  const test = async () => {
    setTesting(true);
    setResult(undefined);
    try {
      setResult(await api<TestResult>("/api/agents/test", { body: { agent: built } }));
    } catch (e: any) {
      setResult({ ok: false, latencyMs: 0, error: e?.message });
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Remove "${initial.name}"?`)) return;
    await saveConfig(
      {
        ...config,
        agents: config.agents.filter((a) => a.id !== initial.id),
        workspaces: config.workspaces.map((w) => {
          if (w.agentId !== initial.id) return w;
          const { agentId: _gone, ...rest } = w;
          return rest;
        }),
      },
      "Agent removed",
    );
  };

  const a2ui = result?.card?.capabilities?.extensions?.some((e) => e.uri.includes("a2ui"));
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1">
        <Section
          title={initial.name}
          description={draft.protocol === "a2a" ? "Agent2Agent (JSON-RPC over HTTP, streaming with SSE)" : "AG-UI (event stream over SSE)"}
          right={
            active ? (
              <Badge tone="accent">Used by {workspace.name}</Badge>
            ) : (
              <Button size="xs" variant="outline" onClick={() => setWorkspaceModel(`agent:${initial.id}`)}>
                Use in {workspace.name}
              </Button>
            )
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
            </Field>
            <Field label="Protocol">
              <Tabs<AgentProtocol>
                value={draft.protocol}
                onChange={(protocol) => patch({ protocol })}
                items={[
                  { value: "a2a", label: "A2A" },
                  { value: "ag-ui", label: "AG-UI" },
                ]}
              />
            </Field>
            <Field
              label={draft.protocol === "a2a" ? "Agent card or endpoint URL" : "Run endpoint URL"}
              className="sm:col-span-2"
              hint={draft.protocol === "a2a" ? "e.g. https://agent.example.com/.well-known/agent-card.json (Moka reads the card to find the endpoint)" : "The URL you POST RunAgentInput to, e.g. http://localhost:8000/agent"}
            >
              <Input mono value={draft.url} onChange={(e) => patch({ url: e.target.value })} />
            </Field>
            <Field label="Headers" className="sm:col-span-2" hint="e.g. Authorization: Bearer ${AGENT_TOKEN}. Values support env:NAME and ${NAME}.">
              <KeyValueEditor value={draft.headers} onChange={(headers) => patch({ headers })} keyPlaceholder="Header" />
            </Field>
            {draft.protocol === "ag-ui" && (
              <Field label="Share tools with the agent" className="sm:col-span-2" hint="Offer this workspace's MCP tools and the render tool as AG-UI frontend tools. Moka runs the calls (with approvals) and continues the run.">
                <Switch checked={Boolean(draft.shareTools)} onChange={(v) => patch({ shareTools: v })} />
              </Field>
            )}
          </div>
        </Section>
        {result && (
          <Section title="Test result">
            <div className={cn("rounded-xl border px-4 py-3 text-[13px]", result.ok ? "border-ok/30 bg-ok/5" : "border-err/30 bg-err/5")}>
              <div className="flex items-center gap-2 font-medium">
                {result.ok ? <CheckCircle2 className="h-4 w-4 text-ok" /> : <XCircle className="h-4 w-4 text-err" />}
                {result.ok ? "Reachable" : "Failed"} · {formatMs(result.latencyMs)}
              </div>
              {result.error && <p className="mt-1 text-muted">{result.error}</p>}
              {result.card && (
                <div className="mt-3 space-y-2">
                  <div>
                    <span className="font-medium">{result.card.name ?? "Agent"}</span>
                    {result.card.version && <span className="ml-1.5 text-subtle">v{result.card.version}</span>}
                    {result.card.description && <p className="text-muted">{result.card.description}</p>}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Badge tone={result.card.capabilities?.streaming === false ? "neutral" : "ok"}>{result.card.capabilities?.streaming === false ? "no streaming" : "streaming"}</Badge>
                    {a2ui && <Badge tone="violet">A2UI extension</Badge>}
                    {result.card.url && <Badge className="font-mono">{result.card.url}</Badge>}
                  </div>
                  {(result.card.skills ?? []).length > 0 && (
                    <ul className="space-y-1">
                      {result.card.skills!.map((s, i) => (
                        <li key={s.id ?? i}>
                          <span className="font-medium">{s.name ?? s.id}</span>
                          {s.description && <span className="text-muted"> · {s.description}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {result.events && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {result.events.map((e) => (
                    <Badge key={e} className="font-mono">
                      {e}
                    </Badge>
                  ))}
                </div>
              )}
              {result.text && <p className="mt-2 text-muted">“{result.text}”</p>}
            </div>
          </Section>
        )}
      </div>
      <FormFooter>
        <Button variant="danger" size="sm" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={remove}>
          Remove
        </Button>
        <span className="flex-1" />
        <Button variant="outline" size="sm" loading={testing} disabled={!valid} onClick={test}>
          Test
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || !valid}
          onClick={() => saveConfig({ ...config, agents: config.agents.map((a) => (a.id === initial.id ? built : a)) }, "Agent saved")}
        >
          Save changes
        </Button>
      </FormFooter>
    </div>
  );
}
