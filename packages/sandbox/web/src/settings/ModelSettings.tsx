import { CheckCircle2, ChevronRight, Cpu, KeyRound, Plus, RefreshCw, Star, Trash2, XCircle, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Badge, Button, Empty, Field, Input, KeyValueEditor, Select, Switch, Textarea, cn } from "../components/ui";
import { uid } from "../runner";
import { useStore } from "../store";
import type { LlmProfile, ProviderKind, ProviderPreset } from "../types";
import { FormFooter, ListItem, MasterDetail, Section } from "./Settings";

const PROVIDER_LABEL: Record<ProviderKind, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Gemini",
  azure: "Azure OpenAI",
  ollama: "Ollama",
  "openai-compatible": "OpenAI-compatible",
};

export function ModelSettings() {
  const config = useStore((s) => s.config);
  const [selected, setSelected] = useState<string | "new" | undefined>(config.llms[0]?.id ?? "new");

  useEffect(() => {
    if (selected && selected !== "new" && !config.llms.some((l) => l.id === selected)) setSelected(config.llms[0]?.id ?? "new");
  }, [config.llms, selected]);

  const current = config.llms.find((l) => l.id === selected);
  const workspace = useStore((s) => s.workspace());

  return (
    <MasterDetail
      list={
        <>
          <div className="p-3">
            <Button className="w-full" variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setSelected("new")}>
              Add model
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
            {config.llms.map((llm) => (
              <ListItem
                key={llm.id}
                active={selected === llm.id}
                onClick={() => setSelected(llm.id)}
                left={<ProviderIcon provider={llm.provider} />}
                title={llm.name}
                subtitle={llm.model}
                right={workspace.llmId === llm.id ? <Star className="h-3.5 w-3.5 fill-accent text-accent" /> : undefined}
              />
            ))}
          </div>
        </>
      }
      detail={
        selected === "new" ? (
          <PresetPicker onCreated={(id) => setSelected(id)} />
        ) : current ? (
          <ModelForm key={current.id} initial={current} />
        ) : (
          <Empty icon={<Cpu className="h-5 w-5" />} title="No model selected" />
        )
      }
    />
  );
}

export function ProviderIcon({ provider }: { provider: ProviderKind }) {
  const letters: Record<ProviderKind, string> = { openai: "OA", anthropic: "A", google: "G", azure: "Az", ollama: "Ol", "openai-compatible": "API" };
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-panel-2 font-mono text-[10px] font-semibold text-muted">
      {letters[provider]}
    </span>
  );
}

function PresetPicker({ onCreated }: { onCreated: (id: string) => void }) {
  const presets = useStore((s) => s.presets);
  const env = useStore((s) => s.env);
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);

  const create = async (preset: ProviderPreset) => {
    const taken = new Set(config.llms.map((l) => l.id));
    let id = preset.id;
    for (let i = 2; taken.has(id); i++) id = `${preset.id}-${i}`;
    let envKey = preset.envKey;
    if (preset.id === "google" && envKey && !env[envKey] && env.GEMINI_API_KEY) envKey = "GEMINI_API_KEY";
    const llm: LlmProfile = {
      id,
      name: preset.label.replace(/ \(local\)$/, ""),
      provider: preset.provider,
      model: preset.defaultModel || "model-name",
      apiKey: envKey && env[envKey] ? `env:${envKey}` : undefined,
      baseURL: preset.baseURL && preset.baseURL !== "https://" ? preset.baseURL : undefined,
      resourceName: preset.id === "azure" && env.AZURE_RESOURCE_NAME ? "env:AZURE_RESOURCE_NAME" : undefined,
    };
    const workspaces = config.workspaces.map((w) => (w.id === config.activeWorkspaceId && !w.llmId ? { ...w, llmId: id } : w));
    if (await saveConfig({ ...config, llms: [...config.llms, llm], workspaces }, `Added ${llm.name}`)) onCreated(id);
  };

  return (
    <div className="p-6">
      <h3 className="text-[15px] font-semibold">Add a model</h3>
      <p className="mt-1 text-[13px] text-muted">Pick a provider. Everything is editable afterwards: base URL, headers, keys, parameters.</p>
      <div className="mt-5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {presets.map((p) => {
          const detected = p.envKey && (env[p.envKey] || (p.id === "google" && env.GEMINI_API_KEY));
          return (
            <button
              key={p.id}
              onClick={() => create(p)}
              className="group flex items-start gap-3 rounded-xl border border-line bg-panel p-3.5 text-left transition-all hover:-translate-y-px hover:border-accent/40 hover:shadow-soft"
            >
              <ProviderIcon provider={p.provider} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px] font-medium">
                  {p.label}
                  {detected && (
                    <Badge tone="ok">
                      <KeyRound className="h-2.5 w-2.5" /> key found
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[11.5px] text-muted">{p.id === "custom" ? "vLLM, LiteLLM, corporate gateways…" : p.defaultModel}</div>
              </div>
              <ChevronRight className="mt-1 h-4 w-4 text-subtle transition-transform group-hover:translate-x-0.5" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ModelForm({ initial }: { initial: LlmProfile }) {
  const config = useStore((s) => s.config);
  const env = useStore((s) => s.env);
  const saveConfig = useStore((s) => s.saveConfig);
  const workspace = useStore((s) => s.workspace());
  const setWorkspaceModel = useStore((s) => s.setWorkspaceModel);
  const [draft, setDraft] = useState<LlmProfile>(initial);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; latencyMs: number; text?: string; error?: string }>();
  const [advanced, setAdvanced] = useState(Boolean(initial.headers || initial.temperature !== undefined || initial.maxOutputTokens || initial.providerOptions));
  const [optionsText, setOptionsText] = useState(initial.providerOptions ? JSON.stringify(initial.providerOptions, null, 2) : "");
  const [optionsError, setOptionsError] = useState<string>();

  const initialOptions = initial.providerOptions ? JSON.stringify(initial.providerOptions, null, 2) : "";
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initial) || optionsText !== initialOptions,
    [draft, initial, optionsText, initialOptions],
  );
  const patch = (p: Partial<LlmProfile>) => {
    setDraft((d) => ({ ...d, ...p }));
    setTest(undefined);
  };

  const envSuggestions = Object.entries(env).filter(([, v]) => v).map(([k]) => k);
  const needsBase = draft.provider === "openai-compatible";
  const showBase = draft.provider !== "azure" || !!draft.baseURL;

  const clean = (d: LlmProfile): LlmProfile => {
    const out: any = { ...d };
    for (const k of Object.keys(out)) if (out[k] === "" || out[k] === undefined) delete out[k];
    if (out.headers && Object.keys(out.headers).length === 0) delete out.headers;
    return out;
  };

  const save = async () => {
    let providerOptions: Record<string, unknown> | undefined;
    if (optionsText.trim()) {
      try {
        providerOptions = JSON.parse(optionsText);
        setOptionsError(undefined);
      } catch {
        setOptionsError("Invalid JSON");
        return;
      }
    }
    const next = clean({ ...draft, providerOptions });
    await saveConfig({ ...config, llms: config.llms.map((l) => (l.id === initial.id ? next : l)) }, "Model saved");
  };

  const remove = async () => {
    if (!confirm(`Delete "${initial.name}"?`)) return;
    await saveConfig(
      {
        ...config,
        llms: config.llms.filter((l) => l.id !== initial.id),
        workspaces: config.workspaces.map((w) => (w.llmId === initial.id ? { ...w, llmId: undefined } : w)),
      },
      "Model deleted",
    );
  };

  const runTest = async () => {
    setTesting(true);
    setTest(undefined);
    try {
      setTest(await api("/api/llm/test", { body: { profile: clean(draft) } }));
    } catch (error: any) {
      setTest({ ok: false, latencyMs: 0, error: error?.message });
    } finally {
      setTesting(false);
    }
  };

  const fetchModels = async () => {
    setLoadingModels(true);
    setModelsError(undefined);
    try {
      const res = await api<{ models: string[]; error?: string }>("/api/llm/models", { body: { profile: clean(draft) } });
      setModels(res.models);
      if (res.error) setModelsError(res.error);
      else if (res.models.length === 0) setModelsError("No models returned");
    } catch (error: any) {
      setModelsError(error?.message);
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1">
        <Section
          title={draft.name || "Model"}
          description={`${PROVIDER_LABEL[draft.provider]} · id: ${draft.id}`}
          right={
            workspace.llmId === initial.id ? (
              <Badge tone="accent">
                <Star className="h-3 w-3 fill-current" /> Default in {workspace.name}
              </Badge>
            ) : (
              <Button size="xs" variant="outline" icon={<Star className="h-3 w-3" />} onClick={() => setWorkspaceModel(initial.id)}>
                Use in {workspace.name}
              </Button>
            )
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Display name">
              <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
            </Field>
            <Field label="Provider">
              <Select value={draft.provider} onChange={(e) => patch({ provider: e.target.value as ProviderKind })}>
                {Object.entries(PROVIDER_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={draft.provider === "azure" ? "Deployment name" : "Model"}
              className="sm:col-span-2"
              error={modelsError}
              right={
                draft.provider !== "azure" && (
                  <button type="button" onClick={fetchModels} className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline">
                    <RefreshCw className={cn("h-3 w-3", loadingModels && "animate-spin")} /> Fetch models
                  </button>
                )
              }
              hint={models.length > 0 ? `${models.length} models available — start typing to filter` : undefined}
            >
              <Input mono list={`models-${initial.id}`} value={draft.model} onChange={(e) => patch({ model: e.target.value })} placeholder="e.g. gpt-5-mini" />
              <datalist id={`models-${initial.id}`}>
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            <Field
              label="API key"
              className="sm:col-span-2"
              hint={
                <>
                  Paste a key, or reference an environment variable with <code className="font-mono text-accent">env:NAME</code> (recommended — never written to disk).
                  {envSuggestions.length > 0 && (
                    <span className="mt-1.5 flex flex-wrap gap-1">
                      {envSuggestions.map((k) => (
                        <button key={k} type="button" onClick={() => patch({ apiKey: `env:${k}` })}>
                          <Badge tone={draft.apiKey === `env:${k}` ? "accent" : "neutral"}>env:{k}</Badge>
                        </button>
                      ))}
                    </span>
                  )}
                </>
              }
            >
              <Input
                mono
                type={draft.apiKey && !draft.apiKey.startsWith("env:") && !draft.apiKey.startsWith("${") ? "password" : "text"}
                value={draft.apiKey ?? ""}
                onChange={(e) => patch({ apiKey: e.target.value })}
                placeholder={draft.provider === "ollama" ? "Not needed for local Ollama" : "sk-… or env:OPENAI_API_KEY"}
                autoComplete="off"
              />
            </Field>
            {showBase && (
              <Field
                label={needsBase ? "Base URL" : "Base URL (optional)"}
                className="sm:col-span-2"
                hint={needsBase ? "Any OpenAI-compatible /v1 endpoint: vLLM, LiteLLM, LM Studio, OpenRouter, your gateway…" : "Override to route through a proxy or gateway."}
              >
                <Input mono value={draft.baseURL ?? ""} onChange={(e) => patch({ baseURL: e.target.value })} placeholder="https://api.example.com/v1" />
              </Field>
            )}
            {draft.provider === "azure" && (
              <>
                <Field label="Resource name" hint="From https://<resource>.openai.azure.com — or env:AZURE_RESOURCE_NAME">
                  <Input mono value={draft.resourceName ?? ""} onChange={(e) => patch({ resourceName: e.target.value })} />
                </Field>
                <Field label="API version (optional)">
                  <Input mono value={draft.apiVersion ?? ""} onChange={(e) => patch({ apiVersion: e.target.value })} placeholder="v1" />
                </Field>
              </>
            )}
          </div>
        </Section>

        <Section
          title="Advanced"
          description="Headers, sampling and provider-specific options."
          right={<Switch checked={advanced} onChange={setAdvanced} label="Show advanced" />}
        >
          {advanced ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={`Temperature${draft.temperature !== undefined ? ` · ${draft.temperature}` : ""}`} hint="Leave unset for the provider default.">
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={draft.temperature ?? 1}
                    onChange={(e) => patch({ temperature: Number(e.target.value) })}
                    className="flex-1 accent-[var(--accent)]"
                  />
                  {draft.temperature !== undefined && (
                    <Button size="xs" variant="ghost" onClick={() => patch({ temperature: undefined })}>
                      Reset
                    </Button>
                  )}
                </div>
              </Field>
              <Field label="Max output tokens">
                <Input
                  type="number"
                  min={1}
                  value={draft.maxOutputTokens ?? ""}
                  onChange={(e) => patch({ maxOutputTokens: e.target.value ? Number(e.target.value) : undefined })}
                  placeholder="provider default"
                />
              </Field>
              {draft.provider === "openai" && (
                <Field label="Use Chat Completions API" hint="Default is the Responses API. Enable for older models or gateways.">
                  <Switch checked={!!draft.useChatApi} onChange={(v) => patch({ useChatApi: v || undefined })} />
                </Field>
              )}
              <Field label="Custom headers" className="sm:col-span-2" hint="Sent with every request — e.g. gateway auth, org or tracing headers. Values support env:NAME.">
                <KeyValueEditor value={draft.headers} onChange={(headers) => patch({ headers })} keyPlaceholder="Header" />
              </Field>
              <Field
                label="Provider options (JSON)"
                className="sm:col-span-2"
                error={optionsError}
                hint={
                  <>
                    Passed as AI SDK <code className="font-mono">providerOptions</code>, e.g.{" "}
                    <code className="font-mono">{`{"openai":{"reasoningEffort":"low"}}`}</code>
                  </>
                }
              >
                <Textarea mono rows={4} value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder="{}" />
              </Field>
            </div>
          ) : (
            <p className="text-[12.5px] text-subtle">Hidden. Toggle to edit headers, temperature, token limits and provider options.</p>
          )}
        </Section>

        {test && (
          <div className="px-6 pt-5">
            <div className={cn("flex items-start gap-3 rounded-xl border px-4 py-3 text-[13px]", test.ok ? "border-ok/30 bg-ok/5" : "border-err/30 bg-err/5")}>
              {test.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-ok" /> : <XCircle className="mt-0.5 h-4 w-4 text-err" />}
              <div className="min-w-0">
                <p className="font-medium">{test.ok ? `Connected in ${test.latencyMs}ms` : "Connection failed"}</p>
                <p className="mt-0.5 break-words text-muted">{test.ok ? `Model replied: “${test.text?.trim()}”` : test.error}</p>
              </div>
            </div>
          </div>
        )}
      </div>
      <FormFooter>
        <Button variant="danger" size="sm" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={remove}>
          Delete
        </Button>
        <span className="flex-1" />
        <Button variant="outline" size="sm" loading={testing} icon={<Zap className="h-3.5 w-3.5" />} onClick={runTest}>
          Test
        </Button>
        <Button variant="primary" size="sm" disabled={!dirty} onClick={save}>
          Save changes
        </Button>
      </FormFooter>
    </div>
  );
}

export function newModelId(): string {
  return uid("llm");
}
