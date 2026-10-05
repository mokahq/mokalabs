import { Braces, Eye, EyeOff, FileText, FileCode2, MessageSquareText, Play, Plug, RefreshCw, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { McpAppFrame } from "./McpAppFrame";
import { useStore } from "../store";
import { expandTemplate, templateVariables } from "../uriTemplate";
import type { JsonSchema, McpTool } from "../types";
import { Badge, Button, Empty, Field, Input, JsonView, Select, StatusDot, Switch, Tabs, Textarea, cn, formatMs } from "./ui";

type Item = { kind: "tool"; name: string } | { kind: "resource"; uri: string } | { kind: "template"; uriTemplate: string } | { kind: "prompt"; name: string };

export function ToolRunner() {
  const config = useStore((s) => s.config);
  const mcp = useStore((s) => s.mcp);
  const target = useStore((s) => s.toolTarget);
  const connectServer = useStore((s) => s.connectServer);
  const openSettings = useStore((s) => s.openSettings);
  const [serverId, setServerId] = useState<string | undefined>(target?.serverId ?? config.mcpServers[0]?.id);
  const [item, setItem] = useState<Item | undefined>(target?.tool ? { kind: "tool", name: target.tool } : undefined);

  useEffect(() => {
    if (target) {
      setServerId(target.serverId);
      if (target.tool) setItem({ kind: "tool", name: target.tool });
    }
  }, [target]);

  const state = serverId ? mcp[serverId] : undefined;
  useEffect(() => {
    // Also bring back a server that dropped (crashed or exited), like the chat does.
    if (serverId && (!state || state.status === "idle" || state.status === "disconnected")) void connectServer(serverId);
  }, [serverId, state, connectServer]);

  if (config.mcpServers.length === 0) {
    return (
      <Empty
        icon={<Plug className="h-5 w-5" />}
        title="No MCP servers yet"
        action={
          <Button variant="primary" onClick={() => openSettings("mcp")}>
            Add a server
          </Button>
        }
      >
        Add a server to browse and call its tools, resources and prompts directly — no model required.
      </Empty>
    );
  }

  const tool = item?.kind === "tool" ? state?.tools.find((t) => t.name === item.name) : undefined;

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-72 shrink-0 flex-col border-r border-line">
        <div className="space-y-2 border-b border-line p-3">
          <Select
            value={serverId}
            onChange={(e) => {
              setServerId(e.target.value);
              setItem(undefined);
            }}
          >
            {config.mcpServers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <StatusDot status={state?.status ?? "idle"} />
            <span className="flex-1 truncate">{state?.status === "error" || state?.status === "disconnected" ? state.error : state?.status ?? "idle"}</span>
            <button className="text-subtle hover:text-fg" onClick={() => serverId && connectServer(serverId, true)} title="Reconnect">
              <RefreshCw className={cn("h-3.5 w-3.5", state?.status === "connecting" && "animate-spin")} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <Group title="Tools" count={state?.tools.length}>
            {state?.tools.map((t) => (
              <Row key={t.name} active={item?.kind === "tool" && item.name === t.name} onClick={() => setItem({ kind: "tool", name: t.name })} icon={<Wrench className="h-3.5 w-3.5" />} title={t.name} subtitle={t.description} />
            ))}
          </Group>
          <Group title="Resources" count={state?.resources.length}>
            {state?.resources.map((r) => (
              <Row
                key={r.uri}
                active={item?.kind === "resource" && item.uri === r.uri}
                onClick={() => setItem({ kind: "resource", uri: r.uri })}
                icon={state?.subscriptions?.includes(r.uri) ? <Eye className="h-3.5 w-3.5 text-info" /> : <FileText className="h-3.5 w-3.5" />}
                title={r.title ?? r.name ?? r.uri}
                subtitle={r.uri}
              />
            ))}
          </Group>
          <Group title="Resource templates" count={state?.resourceTemplates?.length}>
            {state?.resourceTemplates?.map((t) => (
              <Row
                key={t.uriTemplate}
                active={item?.kind === "template" && item.uriTemplate === t.uriTemplate}
                onClick={() => setItem({ kind: "template", uriTemplate: t.uriTemplate })}
                icon={<FileCode2 className="h-3.5 w-3.5" />}
                title={t.title ?? t.name ?? t.uriTemplate}
                subtitle={t.uriTemplate}
              />
            ))}
          </Group>
          <Group title="Prompts" count={state?.prompts.length}>
            {state?.prompts.map((p) => (
              <Row key={p.name} active={item?.kind === "prompt" && item.name === p.name} onClick={() => setItem({ kind: "prompt", name: p.name })} icon={<MessageSquareText className="h-3.5 w-3.5" />} title={p.name} subtitle={p.description} />
            ))}
          </Group>
        </div>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {!serverId || !item ? (
          <Empty icon={<Wrench className="h-5 w-5" />} title="Pick a tool, resource or prompt">
            Call MCP capabilities directly with generated forms. Every call shows up in the inspector.
          </Empty>
        ) : item.kind === "tool" && tool ? (
          <ToolForm key={`${serverId}/${tool.name}`} serverId={serverId} tool={tool} />
        ) : item.kind === "resource" ? (
          <ResourceView key={item.uri} serverId={serverId} uri={item.uri} />
        ) : item.kind === "template" ? (
          <TemplateView key={item.uriTemplate} serverId={serverId} uriTemplate={item.uriTemplate} onOpen={(uri) => setItem({ kind: "resource", uri })} />
        ) : item.kind === "prompt" ? (
          <PromptView key={item.name} serverId={serverId} name={item.name} />
        ) : null}
      </div>
    </div>
  );
}

function Group({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  if (!count) return null;
  return (
    <div className="mb-3">
      <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">
        {title} · {count}
      </div>
      {children}
    </div>
  );
}

function Row({ active, onClick, icon, title, subtitle }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <button onClick={onClick} className={cn("flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left", active ? "bg-accent-soft" : "hover:bg-panel-2")}>
      <span className={cn("mt-0.5", active ? "text-accent" : "text-subtle")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[12.5px]">{title}</span>
        {subtitle && <span className="block truncate text-[11px] text-muted">{subtitle}</span>}
      </span>
    </button>
  );
}

function defaults(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.default !== undefined) out[key] = prop.default;
  }
  return out;
}

function typeOf(prop: JsonSchema): string {
  const t = Array.isArray(prop.type) ? prop.type.find((x) => x !== "null") : prop.type;
  if (t) return t;
  if (prop.enum) return "string";
  if (prop.anyOf) return typeOf(prop.anyOf.find((p) => p.type !== "null") ?? {});
  return "json";
}

function ToolForm({ serverId, tool }: { serverId: string; tool: McpTool }) {
  const schema = tool.inputSchema ?? {};
  const props = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  const [values, setValues] = useState<Record<string, unknown>>(() => defaults(schema));
  const [raw, setRaw] = useState(props.length === 0 ? "{}" : "");
  const [mode, setMode] = useState<"form" | "json">("form");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ result?: any; error?: string; durationMs?: number }>();
  const [jsonErrors, setJsonErrors] = useState<Record<string, string>>({});

  const args = useMemo(() => {
    if (mode === "json") {
      try {
        return JSON.parse(raw || "{}");
      } catch {
        return undefined;
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if (v !== "" && v !== undefined) out[k] = v;
    return out;
  }, [mode, raw, values]);

  const run = async () => {
    if (!args) return;
    setRunning(true);
    setResult(undefined);
    try {
      setResult(await api(`/api/mcp/${serverId}/call`, { body: { tool: tool.name, args } }));
    } catch (e: any) {
      setResult({ error: e?.message });
    } finally {
      setRunning(false);
    }
  };

  const content: any[] = result?.result?.content ?? [];
  const appUri = tool._meta?.ui?.resourceUri ?? tool._meta?.["ui/resourceUri"];
  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Wrench className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-mono text-[15px] font-semibold">{tool.name}</h2>
          {tool.description && <p className="mt-1 text-[13px] whitespace-pre-wrap text-muted">{tool.description}</p>}
          {tool.annotations && (
            <div className="mt-2 flex flex-wrap gap-1">
              {Object.entries(tool.annotations)
                .filter(([, v]) => v === true)
                .map(([k]) => (
                  <Badge key={k} tone="info">
                    {k.replace(/Hint$/, "")}
                  </Badge>
                ))}
            </div>
          )}
        </div>
        <Tabs
          size="sm"
          value={mode}
          onChange={(m) => {
            if (m === "json") setRaw(JSON.stringify(args ?? {}, null, 2));
            setMode(m);
          }}
          items={[
            { value: "form", label: "Form" },
            { value: "json", label: "JSON", icon: <Braces className="h-3 w-3" /> },
          ]}
        />
      </div>

      <div className="mt-5 rounded-xl border border-line bg-panel p-4">
        {mode === "json" ? (
          <Textarea mono rows={10} value={raw} onChange={(e) => setRaw(e.target.value)} />
        ) : props.length === 0 ? (
          <p className="text-[13px] text-muted">This tool takes no arguments.</p>
        ) : (
          <div className="grid gap-4">
            {props.map(([key, prop]) => {
              const type = typeOf(prop);
              const label = `${key}${required.has(key) ? " *" : ""}`;
              const hint = [prop.description, type !== "string" ? type : ""].filter(Boolean).join(" · ");
              const value = values[key];
              const setValue = (v: unknown) => setValues((s) => ({ ...s, [key]: v }));
              if (prop.enum) {
                return (
                  <Field key={key} label={label} hint={prop.description}>
                    <Select value={String(value ?? "")} onChange={(e) => setValue(e.target.value || undefined)}>
                      <option value="">—</option>
                      {prop.enum.map((o) => (
                        <option key={String(o)} value={String(o)}>
                          {String(o)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                );
              }
              if (type === "boolean") {
                return (
                  <Field key={key} label={label} hint={prop.description}>
                    <Switch checked={!!value} onChange={setValue} />
                  </Field>
                );
              }
              if (type === "number" || type === "integer") {
                return (
                  <Field key={key} label={label} hint={hint}>
                    <Input type="number" value={value === undefined ? "" : String(value)} onChange={(e) => setValue(e.target.value === "" ? undefined : Number(e.target.value))} />
                  </Field>
                );
              }
              if (type === "string") {
                const long = /(content|body|text|query|code|prompt|markdown)/i.test(key);
                return (
                  <Field key={key} label={label} hint={prop.description}>
                    {long ? (
                      <Textarea rows={3} value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} />
                    ) : (
                      <Input value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} />
                    )}
                  </Field>
                );
              }
              return (
                <Field key={key} label={label} hint={hint} error={jsonErrors[key]}>
                  <Textarea
                    mono
                    rows={3}
                    defaultValue={value === undefined ? "" : JSON.stringify(value, null, 2)}
                    placeholder={type === "array" ? "[]" : "{}"}
                    onChange={(e) => {
                      try {
                        setValue(e.target.value.trim() ? JSON.parse(e.target.value) : undefined);
                        setJsonErrors((s) => ({ ...s, [key]: "" }));
                      } catch {
                        setJsonErrors((s) => ({ ...s, [key]: "Invalid JSON" }));
                      }
                    }}
                  />
                </Field>
              );
            })}
          </div>
        )}
        <div className="mt-4 flex items-center gap-2">
          <Button variant="primary" size="sm" loading={running} disabled={!args} icon={<Play className="h-3.5 w-3.5" />} onClick={run}>
            Run tool
          </Button>
          {!args && <span className="text-[12px] text-err">Invalid JSON arguments</span>}
        </div>
      </div>

      {result && (
        <div className="animate-in mt-5">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[13px] font-semibold">Result</span>
            {result.error || result.result?.isError ? <Badge tone="err">error</Badge> : <Badge tone="ok">ok</Badge>}
            {result.durationMs !== undefined && <span className="font-mono text-[11px] text-subtle">{formatMs(result.durationMs)}</span>}
          </div>
          {appUri && !result.error && (
            <div className="mb-3">
              <McpAppFrame ui={{ kind: "mcp-app", serverId, resourceUri: appUri }} toolName={tool.name} input={args} raw={result.result} running={false} />
            </div>
          )}
          {result.error ? (
            <JsonView value={result.error} />
          ) : (
            <div className="space-y-2">
              {content.map((c, i) =>
                c.type === "text" ? (
                  <JsonView key={i} value={c.text} />
                ) : c.type === "image" ? (
                  <img key={i} src={`data:${c.mimeType};base64,${c.data}`} className="max-h-96 rounded-lg border border-line" alt="" />
                ) : (
                  <JsonView key={i} value={c} />
                ),
              )}
              {result.result?.structuredContent !== undefined && (
                <div>
                  <div className="mb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">Structured content</div>
                  <JsonView value={result.result.structuredContent} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResourceView({ serverId, uri }: { serverId: string; uri: string }) {
  const state = useStore((s) => s.mcp[serverId]);
  const toast = useStore((s) => s.toast);
  const events = useStore((s) => s.events);
  const updates = useMemo(
    () => events.filter((e) => e.kind === "resource.updated" && e.serverId === serverId && (e.data as { uri?: string })?.uri === uri),
    [events, serverId, uri],
  );
  const [result, setResult] = useState<any>();
  const [error, setError] = useState<string>();
  const [loadedAt, setLoadedAt] = useState<number>();
  const [flash, setFlash] = useState(false);
  const watching = Boolean(state?.subscriptions?.includes(uri));
  const meta = state?.resources.find((r) => r.uri === uri);
  const lastUpdate = updates.at(-1);

  const load = async (highlight = false) => {
    try {
      const r = await api(`/api/mcp/${serverId}/resource`, { body: { uri } });
      setResult(r.result);
      setError(undefined);
      setLoadedAt(Date.now());
      if (highlight) {
        setFlash(true);
        setTimeout(() => setFlash(false), 900);
      }
    } catch (e: any) {
      setError(e?.message);
    }
  };

  useEffect(() => {
    void load();
  }, [serverId, uri]);

  // Re-read whenever the server says this resource changed.
  useEffect(() => {
    if (lastUpdate && watching) void load(true);
  }, [lastUpdate?.id]);

  const toggleWatch = async () => {
    try {
      await api(`/api/mcp/${encodeURIComponent(serverId)}/subscribe`, { body: { uri, subscribe: !watching } });
      await useStore.getState().refreshMcp();
      toast(watching ? "Stopped watching" : "Watching for updates", "success");
    } catch (e: any) {
      toast(e?.message ?? "Could not change subscription", "error");
    }
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {meta?.title || meta?.name ? <div className="text-[15px] font-semibold">{meta.title ?? meta.name}</div> : null}
          <h2 className="font-mono text-[13px] break-all text-muted">{uri}</h2>
          {meta?.description && <p className="mt-1 text-[13px] text-muted">{meta.description}</p>}
        </div>
        <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => load(true)}>
          Reload
        </Button>
        {state?.canSubscribe ? (
          <Button size="sm" variant={watching ? "primary" : "outline"} icon={watching ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />} onClick={toggleWatch}>
            {watching ? "Watching" : "Watch"}
          </Button>
        ) : (
          <span className="pt-1.5 text-[11.5px] text-subtle" title="The server doesn't advertise resources.subscribe">
            no live updates
          </span>
        )}
      </div>
      {watching && (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-muted">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-info" />
          Subscribed · {updates.length} update{updates.length === 1 ? "" : "s"} received
          {lastUpdate ? ` · last ${new Date(lastUpdate.ts).toLocaleTimeString()}` : ""}
        </div>
      )}
      <div className={cn("mt-4 rounded-xl transition-shadow duration-700", flash && "ring-2 ring-info/60")}>
        {error ? (
          <JsonView value={error} />
        ) : result ? (
          <div className="space-y-2">
            {(result.contents ?? []).map((c: any, i: number) => (
              <JsonView key={i} value={c.text ?? c} maxHeight="70vh" />
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-muted">Loading…</p>
        )}
      </div>
      {loadedAt && <p className="mt-2 text-[11px] text-subtle">Read at {new Date(loadedAt).toLocaleTimeString()}</p>}
    </div>
  );
}

function TemplateView({ serverId, uriTemplate, onOpen }: { serverId: string; uriTemplate: string; onOpen: (uri: string) => void }) {
  const meta = useStore((s) => s.mcp[serverId]?.resourceTemplates?.find((t) => t.uriTemplate === uriTemplate));
  const names = useMemo(() => templateVariables(uriTemplate), [uriTemplate]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ uri: string; data?: any; error?: string }>();
  const [loading, setLoading] = useState(false);
  const uri = expandTemplate(uriTemplate, values);
  const complete = names.every((n) => values[n]);

  const read = async () => {
    setLoading(true);
    try {
      const r = await api(`/api/mcp/${serverId}/resource`, { body: { uri } });
      setResult({ uri, data: r.result });
    } catch (e: any) {
      setResult({ uri, error: e?.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      {(meta?.title || meta?.name) && <div className="text-[15px] font-semibold">{meta?.title ?? meta?.name}</div>}
      <h2 className="font-mono text-[13px] break-all text-muted">{uriTemplate}</h2>
      {meta?.description && <p className="mt-1 text-[13px] text-muted">{meta.description}</p>}
      <form
        className="mt-5 space-y-4 rounded-xl border border-line bg-panel p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (complete) void read();
        }}
      >
        {names.map((name, i) => (
          <Field key={name} label={name}>
            <Input autoFocus={i === 0} value={values[name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))} />
          </Field>
        ))}
        <div className="rounded-lg bg-panel-2/60 px-3 py-2 font-mono text-[12px] break-all">{uri}</div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" loading={loading} disabled={!complete} icon={<Play className="h-3.5 w-3.5" />}>
            Read resource
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!complete} icon={<Eye className="h-3.5 w-3.5" />} onClick={() => onOpen(uri)}>
            Open (and watch)
          </Button>
        </div>
      </form>
      {result && (
        <div className="animate-in mt-5 space-y-2">
          <div className="font-mono text-[12px] text-muted">{result.uri}</div>
          {result.error ? <JsonView value={result.error} /> : (result.data?.contents ?? []).map((c: any, i: number) => <JsonView key={i} value={c.text ?? c} maxHeight="60vh" />)}
        </div>
      )}
    </div>
  );
}

function PromptView({ serverId, name }: { serverId: string; name: string }) {
  const prompt = useStore((s) => s.mcp[serverId]?.prompts.find((p) => p.name === name));
  const send = useStore((s) => s.send);
  const set = useStore((s) => s.set);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any>();
  const [error, setError] = useState<string>();
  const text = (result?.messages ?? [])
    .map((m: any) => (m.content?.type === "text" ? m.content.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h2 className="font-mono text-[15px] font-semibold">{name}</h2>
      {prompt?.description && <p className="mt-1 text-[13px] text-muted">{prompt.description}</p>}
      <div className="mt-5 space-y-3 rounded-xl border border-line bg-panel p-4">
        {(prompt?.arguments ?? []).map((a) => (
          <Field key={a.name} label={`${a.name}${a.required ? " *" : ""}`} hint={a.description}>
            <Input value={args[a.name] ?? ""} onChange={(e) => setArgs({ ...args, [a.name]: e.target.value })} />
          </Field>
        ))}
        <Button
          variant="primary"
          size="sm"
          onClick={async () => {
            setError(undefined);
            try {
              setResult((await api(`/api/mcp/${serverId}/prompt`, { body: { name, args } })).result);
            } catch (e: any) {
              setError(e?.message);
            }
          }}
        >
          Get prompt
        </Button>
      </div>
      {error && <p className="mt-3 text-[12.5px] text-err">{error}</p>}
      {result && (
        <div className="mt-5 space-y-2">
          <JsonView value={result} />
          {text && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                set({ view: "chat" });
                void send(text);
              }}
            >
              Send to chat
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
