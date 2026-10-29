import { Check, ClipboardCopy, FlaskConical, Pencil, Play, Plus, Sparkles, Square, Trash2, Wand2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { api, streamTests } from "../api";
import { uid } from "../runner";
import { useStore } from "../store";
import type { TestResult, ToolTest } from "../types";
import { ImprovePanel } from "./Improve";
import { Badge, Button, Empty, IconButton, JsonView, Select, Spinner, Textarea, cn, formatMs, formatNumber } from "./ui";

type ToolMode = "run" | "read-only" | "none";

const MODES: Record<ToolMode, { label: string; hint: string }> = {
  "read-only": { label: "Run read-only tools", hint: "Tools marked read-only really run; tools that may write don't (the model is told so)." },
  run: { label: "Run every tool", hint: "Every tool really runs, writes included. Only on test data!" },
  none: { label: "Run no tools", hint: "Only checks which tools the model picks and with what arguments." },
};

const label = (t: ToolTest) => t.name || t.prompt;

/** One cell of the grid: a test on a model, over its runs. */
function cellOf(results: TestResult[], testId: string, llmId: string) {
  const rs = results.filter((r) => r.testId === testId && r.llmId === llmId);
  return { runs: rs, passed: rs.filter((r) => r.passed).length };
}

/**
 * Tool tests: prompts with the tools a model should (and shouldn't) call,
 * run on several models at once. Saved in the workspace (moka.json), so
 * `moka test` runs the same tests in CI.
 */
export function TestsView() {
  const config = useStore((s) => s.config);
  const workspace = useStore((s) => s.workspace());
  const saveConfig = useStore((s) => s.saveConfig);
  const mcp = useStore((s) => s.mcp);
  const toast = useStore((s) => s.toast);
  const set = useStore((s) => s.set);
  const events = useStore((s) => s.events);
  const tests = workspace.tests ?? [];

  const [models, setModels] = useState<string[]>(() => [workspace.llmId ?? config.llms[0]?.id].filter((m): m is string => !!m));
  const [runs, setRuns] = useState(1);
  const [mode, setMode] = useState<ToolMode>("read-only");
  const results = useStore((s) => s.testResults);
  const setResults = (update: (prev: TestResult[]) => TestResult[]) => useStore.setState((s) => ({ testResults: update(s.testResults) }));
  const [running, setRunning] = useState<{ total: number } | undefined>();
  const [editing, setEditing] = useState<string | "new" | undefined>();
  const [open, setOpen] = useState<{ testId: string; llmId: string }>();
  const [suggesting, setSuggesting] = useState(false);
  const [improving, setImproving] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);

  const tools = useMemo(
    () =>
      [...new Set(workspace.mcpServerIds.flatMap((id) => (mcp[id]?.status === "connected" ? mcp[id]!.tools.map((t) => t.name) : [])))].sort(),
    [workspace.mcpServerIds, mcp],
  );
  const llmName = (id: string) => config.llms.find((l) => l.id === id)?.name ?? id;
  const llmModel = (id: string) => config.llms.find((l) => l.id === id)?.model ?? "";

  const saveTests = async (next: ToolTest[]) =>
    saveConfig({ ...config, workspaces: config.workspaces.map((w) => (w.id === workspace.id ? { ...w, tests: next.length ? next : undefined } : w)) });

  const run = async (only?: string[]) => {
    if (!models.length || running) return;
    const ids = only ?? tests.map((t) => t.id);
    controller.current = new AbortController();
    setResults((prev) => prev.filter((r) => !ids.includes(r.testId) || !models.includes(r.llmId)));
    setRunning({ total: ids.length * models.length * runs });
    try {
      for await (const r of streamTests({ workspaceId: workspace.id, llmIds: models, runs, toolMode: mode, testIds: ids }, controller.current.signal)) {
        setResults((prev) => [...prev, r]);
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") toast(e?.message ?? "Tests failed to run", "error");
    } finally {
      setRunning(undefined);
    }
  };

  const suggest = async () => {
    setSuggesting(true);
    try {
      const { tests: proposed } = await api<{ tests: Omit<ToolTest, "id">[] }>("/api/tests/suggest", { body: { workspaceId: workspace.id, count: 6 } });
      await saveTests([...tests, ...proposed.map((t) => ({ ...t, id: uid("t") }))]);
      toast(`Added ${proposed.length} suggested tests. Check them before trusting the results.`, "success");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't suggest tests", "error");
    } finally {
      setSuggesting(false);
    }
  };

  const scorecard = () => {
    const head = `| Test | ${models.map((m) => `${llmName(m)} (${llmModel(m)})`).join(" | ")} |`;
    const rows = tests.map((t) => `| ${label(t).replace(/\|/g, "\\|")} | ${models.map((m) => {
      const c = cellOf(results, t.id, m);
      return c.runs.length ? `${c.passed === c.runs.length ? "✅" : c.passed ? "⚠️" : "❌"} ${c.passed}/${c.runs.length}` : "–";
    }).join(" | ")} |`);
    const total = `| **Passed** | ${models.map((m) => {
      const rs = results.filter((r) => r.llmId === m);
      return rs.length ? `**${Math.round((rs.filter((r) => r.passed).length / rs.length) * 100)}%**` : "–";
    }).join(" | ")} |`;
    void navigator.clipboard.writeText([head, `|---|${models.map(() => "---|").join("")}`, ...rows, total, "", `_Tool tests run with [Moka](https://mokalabs.dev): ${tests.length} tests, ${runs} run${runs === 1 ? "" : "s"} each._`].join("\n"));
    toast("Scorecard copied as Markdown", "success");
  };

  const detail = open ? cellOf(results, open.testId, open.llmId) : undefined;
  const failing = results.some((r) => !r.passed && models.includes(r.llmId));

  if (improving) return <ImprovePanel models={models} runs={runs} mode={mode} baseline={results} onClose={() => setImproving(false)} />;
  const openTest = open ? tests.find((t) => t.id === open.testId) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <FlaskConical className="h-4 w-4 text-accent" />
        <h1 className="text-[15px] font-semibold">Tool tests</h1>
        <span className="text-[13px] text-muted">· {workspace.name}</span>
        <span className="flex-1" />
        <Select value={mode} onChange={(e) => setMode(e.target.value as ToolMode)} title={MODES[mode].hint} className="h-8 w-auto text-[12.5px]">
          {(Object.keys(MODES) as ToolMode[]).map((m) => (
            <option key={m} value={m}>
              {MODES[m].label}
            </option>
          ))}
        </Select>
        <Select value={String(runs)} onChange={(e) => setRuns(Number(e.target.value))} title="Models aren't deterministic: run each test several times" className="h-8 w-auto text-[12.5px]">
          {[1, 3, 5].map((n) => (
            <option key={n} value={n}>
              {n} run{n === 1 ? "" : "s"} each
            </option>
          ))}
        </Select>
        {results.length > 0 && (
          <Button size="sm" variant="ghost" icon={<ClipboardCopy className="h-3.5 w-3.5" />} onClick={scorecard}>
            Copy scorecard
          </Button>
        )}
        {!running && tests.length > 0 && (
          <Button
            size="sm"
            variant={failing ? "outline" : "ghost"}
            icon={<Wand2 className="h-3.5 w-3.5" />}
            disabled={!models.length || !tools.length}
            title="Propose better tool descriptions from the failures, and prove them on these tests"
            onClick={() => setImproving(true)}
          >
            Improve
          </Button>
        )}
        {running ? (
          <Button size="sm" variant="outline" icon={<Square className="h-3.5 w-3.5" />} onClick={() => controller.current?.abort()}>
            Stop
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={<Play className="h-3.5 w-3.5" />} disabled={!tests.length || !models.length} onClick={() => void run()}>
            Run {tests.length} test{tests.length === 1 ? "" : "s"}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-5 py-2 text-[12.5px]">
        <span className="mr-1 text-muted">Models</span>
        {config.llms.map((l) => {
          const on = models.includes(l.id);
          return (
            <button
              key={l.id}
              onClick={() => setModels(on ? models.filter((m) => m !== l.id) : [...models, l.id])}
              className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5", on ? "border-accent/50 bg-accent-soft text-accent" : "border-line text-muted hover:text-fg")}
            >
              {on && <Check className="h-3 w-3" />}
              {l.name} <span className="text-subtle">{l.model}</span>
            </button>
          );
        })}
        {running && (
          <span className="ml-auto inline-flex items-center gap-2 text-muted">
            <Spinner className="text-accent" />
            {results.filter((r) => models.includes(r.llmId)).length} / {running.total}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tests.length === 0 && editing !== "new" ? (
          <div className="flex h-full items-center justify-center p-6">
            <Empty
              icon={<FlaskConical className="h-5 w-5" />}
              title="Test how models use your tools"
              action={
                <div className="flex gap-2">
                  <Button variant="primary" icon={suggesting ? <Spinner /> : <Sparkles className="h-4 w-4" />} disabled={suggesting || !tools.length} onClick={() => void suggest()}>
                    Suggest tests
                  </Button>
                  <Button variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing("new")}>
                    Write one
                  </Button>
                </div>
              }
            >
              Write prompts with the tools a model should (or shouldn't) call, then run them on several models at once. Tests are saved in your moka.json, and <code className="font-mono">moka test</code> runs them in CI.
              {!tools.length && <span className="mt-2 block text-warn">Connect this workspace's MCP servers first.</span>}
            </Empty>
          </div>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead className="sticky top-0 z-10 bg-panel">
              <tr className="border-b border-line text-left text-[11px] tracking-wide text-subtle uppercase">
                <th className="px-5 py-2 font-medium">Test</th>
                {models.map((m) => (
                  <th key={m} className="w-40 px-3 py-2 text-center font-medium normal-case">
                    <div className="truncate text-[12px] text-fg">{llmName(m)}</div>
                    <div className="truncate font-mono text-[10.5px]">{llmModel(m)}</div>
                  </th>
                ))}
                <th className="w-20" />
              </tr>
            </thead>
            <tbody>
              {tests.map((t) =>
                editing === t.id ? (
                  <tr key={t.id} className="border-b border-line">
                    <td colSpan={models.length + 2} className="px-5 py-3">
                      <TestEditor test={t} tools={tools} onCancel={() => setEditing(undefined)} onSave={(next) => void saveTests(tests.map((x) => (x.id === t.id ? next : x))).then(() => setEditing(undefined))} />
                    </td>
                  </tr>
                ) : (
                  <tr key={t.id} className="group border-b border-line hover:bg-panel-2/40">
                    <td className="px-5 py-2.5">
                      <div className="font-medium">{label(t)}</div>
                      {t.name && <div className="truncate text-[12px] text-muted">{t.prompt}</div>}
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(t.expectTools ?? []).map((n) => (
                          <Badge key={`e${n}`} tone="ok">
                            calls {n}
                          </Badge>
                        ))}
                        {(t.forbidTools ?? []).map((n) => (
                          <Badge key={`f${n}`} tone="err">
                            not {n}
                          </Badge>
                        ))}
                        {Object.keys(t.expectArgs ?? {}).length > 0 && <Badge tone="info">args</Badge>}
                        {(t.answerIncludes ?? []).length > 0 && <Badge tone="violet">answer</Badge>}
                      </div>
                    </td>
                    {models.map((m) => {
                      const c = cellOf(results, t.id, m);
                      const pending = running && c.runs.length < runs;
                      const tone = !c.runs.length ? "" : c.passed === c.runs.length ? "bg-ok/10 text-ok" : c.passed ? "bg-warn/10 text-warn" : "bg-err/10 text-err";
                      return (
                        <td key={m} className="px-3 py-2 text-center">
                          <button
                            disabled={!c.runs.length}
                            onClick={() => setOpen(open?.testId === t.id && open.llmId === m ? undefined : { testId: t.id, llmId: m })}
                            className={cn("inline-flex min-w-16 items-center justify-center gap-1 rounded-lg px-2 py-1 font-mono text-[12px]", tone, open?.testId === t.id && open.llmId === m && "ring-1 ring-accent")}
                          >
                            {c.runs.length ? (c.passed === c.runs.length ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />) : null}
                            {c.runs.length ? `${c.passed}/${c.runs.length}` : pending ? <Spinner className="text-accent" /> : <span className="text-subtle">–</span>}
                            {pending && c.runs.length > 0 && <Spinner className="text-accent" />}
                          </button>
                        </td>
                      );
                    })}
                    <td className="px-2 text-right whitespace-nowrap opacity-0 group-hover:opacity-100">
                      <IconButton label="Run this test" className="h-7 w-7" disabled={!!running} onClick={() => void run([t.id])}>
                        <Play className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton label="Edit" className="h-7 w-7" onClick={() => setEditing(t.id)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton label="Delete" className="h-7 w-7" onClick={() => void saveTests(tests.filter((x) => x.id !== t.id))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconButton>
                    </td>
                  </tr>
                ),
              )}
              {editing === "new" && (
                <tr className="border-b border-line">
                  <td colSpan={models.length + 2} className="px-5 py-3">
                    <TestEditor tools={tools} onCancel={() => setEditing(undefined)} onSave={(next) => void saveTests([...tests, next]).then(() => setEditing(undefined))} />
                  </td>
                </tr>
              )}
              {results.length > 0 && (
                <tr className="bg-panel-2/40 text-[12px]">
                  <td className="px-5 py-2.5 font-medium">Passed</td>
                  {models.map((m) => {
                    const rs = results.filter((r) => r.llmId === m);
                    const pct = rs.length ? Math.round((rs.filter((r) => r.passed).length / rs.length) * 100) : undefined;
                    const tokens = rs.map((r) => r.usage?.totalTokens).filter((n): n is number => typeof n === "number");
                    return (
                      <td key={m} className="px-3 py-2.5 text-center">
                        {pct === undefined ? (
                          <span className="text-subtle">–</span>
                        ) : (
                          <>
                            <div className={cn("text-[15px] font-semibold", pct === 100 ? "text-ok" : pct >= 50 ? "text-warn" : "text-err")}>{pct}%</div>
                            <div className="font-mono text-[10.5px] text-subtle">
                              avg {formatMs(rs.reduce((n, r) => n + r.durationMs, 0) / rs.length)}
                              {tokens.length ? ` · ${formatNumber(Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length))} tok` : ""}
                            </div>
                          </>
                        )}
                      </td>
                    );
                  })}
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        )}
        {tests.length > 0 && editing !== "new" && (
          <div className="flex gap-2 px-5 py-3">
            <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing("new")}>
              Add test
            </Button>
            <Button size="sm" variant="ghost" icon={suggesting ? <Spinner /> : <Sparkles className="h-3.5 w-3.5" />} disabled={suggesting || !tools.length} onClick={() => void suggest()}>
              Suggest more
            </Button>
          </div>
        )}

        {detail && openTest && (
          <div className="mx-5 mb-5 rounded-xl border border-line bg-panel">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              <span className="font-medium">{label(openTest)}</span>
              <span className="text-muted">
                on {llmName(open!.llmId)} <span className="font-mono text-[12px]">{llmModel(open!.llmId)}</span>
              </span>
              <span className="flex-1" />
              <IconButton label="Close" className="h-7 w-7" onClick={() => setOpen(undefined)}>
                <X className="h-3.5 w-3.5" />
              </IconButton>
            </div>
            <div className="divide-y divide-line">
              {detail.runs.map((r) => (
                <div key={r.runId} className="space-y-2 px-4 py-3">
                  <div className="flex items-center gap-2 text-[12.5px]">
                    <Badge tone={r.passed ? "ok" : "err"}>{r.passed ? "passed" : "failed"}</Badge>
                    {runs > 1 && <span className="text-muted">run {r.run}</span>}
                    <span className="font-mono text-[11px] text-subtle">
                      {formatMs(r.durationMs)}
                      {r.usage?.totalTokens ? ` · ${formatNumber(r.usage.totalTokens)} tokens` : ""}
                    </span>
                    <span className="flex-1" />
                    {events.some((e) => e.runId === r.runId) && (
                      <button className="text-[12px] text-muted hover:text-fg" onClick={() => useStore.getState().inspect(events.find((e) => e.runId === r.runId)?.id)}>
                        Inspect run →
                      </button>
                    )}
                  </div>
                  {r.reasons.map((reason, i) => (
                    <p key={i} className="text-[12.5px] text-err">
                      {reason}
                    </p>
                  ))}
                  {r.calls.length > 0 ? (
                    r.calls.map((c, i) => (
                      <div key={i}>
                        <div className="mb-1 font-mono text-[12px]">
                          {c.tool} <span className="text-subtle">{c.server}</span>
                        </div>
                        <JsonView value={c.input} maxHeight="10rem" />
                      </div>
                    ))
                  ) : (
                    <p className="text-[12.5px] text-muted">No tool calls.</p>
                  )}
                  {r.text && <p className="line-clamp-4 text-[12.5px] whitespace-pre-wrap text-muted">{r.text}</p>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TestEditor({ test, tools, onSave, onCancel }: { test?: ToolTest; tools: string[]; onSave: (t: ToolTest) => void; onCancel: () => void }) {
  const [name, setName] = useState(test?.name ?? "");
  const [prompt, setPrompt] = useState(test?.prompt ?? "");
  const [expect, setExpect] = useState<string[]>(test?.expectTools ?? []);
  const [forbid, setForbid] = useState<string[]>(test?.forbidTools ?? []);
  const [args, setArgs] = useState(test?.expectArgs ? JSON.stringify(test.expectArgs, null, 2) : "");
  const [answer, setAnswer] = useState((test?.answerIncludes ?? []).join(", "));
  const [error, setError] = useState<string>();

  const toggle = (list: string[], setList: (l: string[]) => void, tool: string, other: string[], setOther: (l: string[]) => void) => {
    setList(list.includes(tool) ? list.filter((t) => t !== tool) : [...list, tool]);
    if (other.includes(tool)) setOther(other.filter((t) => t !== tool));
  };

  const save = () => {
    let expectArgs: ToolTest["expectArgs"];
    if (args.trim()) {
      try {
        expectArgs = JSON.parse(args);
        if (!expectArgs || typeof expectArgs !== "object" || Array.isArray(expectArgs)) throw new Error();
      } catch {
        setError('Arguments must be a JSON object by tool name, e.g. {"get_time": {"timezone": "Asia/Tokyo"}}');
        return;
      }
    }
    const answerIncludes = answer.split(",").map((a) => a.trim()).filter(Boolean);
    onSave({
      id: test?.id ?? uid("t"),
      ...(name.trim() ? { name: name.trim() } : {}),
      prompt: prompt.trim(),
      ...(expect.length ? { expectTools: expect } : {}),
      ...(forbid.length ? { forbidTools: forbid } : {}),
      ...(expectArgs && Object.keys(expectArgs).length ? { expectArgs } : {}),
      ...(answerIncludes.length ? { answerIncludes } : {}),
    });
  };

  const chips = (list: string[], tone: "ok" | "err", onToggle: (t: string) => void) => (
    <div className="flex flex-wrap gap-1">
      {tools.map((t) => (
        <button
          key={t}
          onClick={() => onToggle(t)}
          className={cn(
            "rounded-md border px-1.5 py-0.5 font-mono text-[11.5px]",
            list.includes(t) ? (tone === "ok" ? "border-ok/40 bg-ok/10 text-ok" : "border-err/40 bg-err/10 text-err") : "border-line text-muted hover:text-fg",
          )}
        >
          {t}
        </button>
      ))}
      {!tools.length && <span className="text-[12px] text-subtle">Connect the workspace's servers to pick tools.</span>}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-[1fr_2fr]">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className="h-9 rounded-lg border border-line bg-panel px-3 text-[13px] placeholder:text-subtle focus:outline-none" />
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="The user's request, e.g. What time is it in Tokyo?" rows={2} autoFocus />
      </div>
      <div>
        <div className="mb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">Must call</div>
        {chips(expect, "ok", (t) => toggle(expect, setExpect, t, forbid, setForbid))}
      </div>
      <div>
        <div className="mb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">Must not call</div>
        {chips(forbid, "err", (t) => toggle(forbid, setForbid, t, expect, setExpect))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">With arguments (optional)</div>
          <Textarea mono value={args} onChange={(e) => setArgs(e.target.value)} placeholder={'{"get_time": {"timezone": "Asia/Tokyo"}}'} rows={3} />
          <p className="mt-1 text-[11.5px] text-subtle">Partial match; strings ignore case.</p>
        </div>
        <div>
          <div className="mb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">Answer mentions (optional)</div>
          <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Tokyo, 42" className="h-9 w-full rounded-lg border border-line bg-panel px-3 text-[13px] placeholder:text-subtle focus:outline-none" />
          <p className="mt-1 text-[11.5px] text-subtle">Comma-separated; ignores case.</p>
        </div>
      </div>
      {error && <p className="text-[12.5px] text-err">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={!prompt.trim()} onClick={save}>
          Save test
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
