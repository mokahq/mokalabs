import { ArrowLeft, ArrowRight, Check, ClipboardCopy, Code2, ShieldAlert, Sparkles, Square, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, streamImprove } from "../api";
import { useStore } from "../store";
import type { Diagnosis, DiagnosisKind, ImproveEvent, McpTool, Proposal, ProposalVerdict, ProposedChange, TestResult, VariantScore } from "../types";
import { Highlighted } from "./Code";
import { Badge, Button, cn, IconButton, Select, Spinner, Textarea } from "./ui";

type ToolMode = "run" | "read-only" | "none";
type Verdict = Extract<ImproveEvent, { type: "verdict" }>;

const STEPS = ["Baseline", "Diagnosis", "Proposals", "Verify", "Review"] as const;
const PHASE_STEP: Record<Extract<ImproveEvent, { type: "phase" }>["phase"], number> = { baseline: 0, diagnosis: 1, holdout: 2, proposals: 2, verify: 3, verdict: 4 };
const KIND: Record<DiagnosisKind, string> = {
  "wrong-tool": "Wrong tool",
  "missed-call": "Missed call",
  "wrong-args": "Wrong argument",
  "forbidden-call": "Called when it shouldn't",
  answer: "Answer",
  error: "Error",
};
const HOLDOUT = 2;

/** Word-level diff (LCS), for showing what a proposal changes in a description. */
export function wordDiff(before: string, after: string): Array<{ text: string; kind: "same" | "add" | "del" }> {
  const a = before.split(/(\s+)/).filter(Boolean);
  const b = after.split(/(\s+)/).filter(Boolean);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: Array<{ text: string; kind: "same" | "add" | "del" }> = [];
  const push = (text: string, kind: "same" | "add" | "del") => (out.at(-1)?.kind === kind ? (out.at(-1)!.text += text) : out.push({ text, kind }));
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) push(a[i++]!, "same"), j++;
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) push(a[i++]!, "del");
    else push(b[j++]!, "add");
  }
  while (i < a.length) push(a[i++]!, "del");
  while (j < b.length) push(b[j++]!, "add");
  return out;
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <p className="text-[13px] leading-relaxed whitespace-pre-wrap">
      {wordDiff(before, after).map((part, i) => (
        <span key={i} className={cn(part.kind === "add" && "rounded-sm bg-ok/15 text-ok", part.kind === "del" && "rounded-sm bg-err/10 text-err line-through decoration-err/50")}>
          {part.text}
        </span>
      ))}
    </p>
  );
}

function Stepper({ step, done }: { step: number; done: boolean }) {
  return (
    <ol className="flex items-center gap-1.5 text-[12px]">
      {STEPS.map((s, i) => {
        const state = i < step || (done && i === step) ? "done" : i === step ? "now" : "next";
        return (
          <li key={s} className="flex items-center gap-1.5">
            {i > 0 && <span className={cn("h-px w-5", i <= step ? "bg-accent/60" : "bg-line")} />}
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
                state === "done" && "border-accent/30 bg-accent-soft text-accent",
                state === "now" && "border-accent text-fg",
                state === "next" && "border-line text-subtle",
              )}
            >
              {state === "done" ? <Check className="h-3 w-3" /> : state === "now" && !done ? <Spinner className="h-3 w-3 text-accent" /> : <span className="font-mono text-[10.5px]">{i + 1}</span>}
              {s}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const changeKey = (c: Pick<ProposedChange, "serverId" | "tool">) => `${c.serverId}\u0000${c.tool}`;
const pct = (passed: number, total: number) => (total ? Math.round((passed / total) * 100) : 0);

/**
 * Improve: diagnoses why tests fail, has a strong model propose better tool
 * wording, verifies each proposal on the tests plus paraphrased prompts it
 * never saw, and lets you keep what works (as toolOverrides, Markdown, or code).
 */
export function ImprovePanel({ models, runs, mode, baseline, onClose }: { models: string[]; runs: number; mode: ToolMode; baseline: TestResult[]; onClose: () => void }) {
  const config = useStore((s) => s.config);
  const workspace = useStore((s) => s.workspace());
  const mcp = useStore((s) => s.mcp);
  const saveConfig = useStore((s) => s.saveConfig);
  const toast = useStore((s) => s.toast);
  const tests = workspace.tests ?? [];

  const [improverId, setImproverId] = useState<string>();
  const [count, setCount] = useState(2);
  const [stage, setStage] = useState<"setup" | "running" | "review">("setup");
  const [step, setStep] = useState(0);
  const [start, setStart] = useState<Extract<ImproveEvent, { type: "start" }>>();
  const [done, setDone] = useState(0);
  const [diagnosis, setDiagnosis] = useState<Diagnosis[]>();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [verdict, setVerdict] = useState<Verdict>();
  const [message, setMessage] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, ProposedChange>>({});
  const [editing, setEditing] = useState<string>();
  const [code, setCode] = useState<{ ts: string; python: string; markdown: string; lang: "ts" | "python" }>();
  const controller = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    void api<{ improverId?: string }>(`/api/improve/improver?workspaceId=${encodeURIComponent(workspace.id)}`).then((r) => setImproverId((id) => id ?? r.improverId)).catch(() => {});
    return () => controller.current?.abort();
  }, [workspace.id]);

  const known = useMemo(() => {
    const rs = baseline.filter((r) => models.includes(r.llmId));
    return tests.every((t) => models.every((m) => rs.some((r) => r.testId === t.id && r.llmId === m))) ? rs : [];
  }, [baseline, models, tests]);
  const perPass = tests.length * models.length * runs;
  const estimate = (known.length ? 0 : perPass) + perPass * HOLDOUT + count * perPass * (1 + HOLDOUT);
  const llm = (id: string) => config.llms.find((l) => l.id === id);

  const toolOf = (serverId: string, name: string): McpTool | undefined => mcp[serverId]?.tools.find((t) => t.name === name);
  const savedOverride = (serverId: string, tool: string) => config.mcpServers.find((s) => s.id === serverId)?.toolOverrides?.[tool];
  const currentDescription = (c: ProposedChange) => savedOverride(c.serverId, c.tool)?.description ?? toolOf(c.serverId, c.tool)?.description ?? "";
  const currentParam = (c: ProposedChange, name: string) =>
    savedOverride(c.serverId, c.tool)?.params?.[name]?.description ?? ((toolOf(c.serverId, c.tool)?.inputSchema as any)?.properties?.[name]?.description as string | undefined) ?? "";

  const run = async () => {
    controller.current = new AbortController();
    setStage("running");
    setStep(0);
    setDone(0);
    setDiagnosis(undefined);
    setProposals([]);
    setVerdict(undefined);
    setMessage(undefined);
    try {
      for await (const event of streamImprove({ workspaceId: workspace.id, llmIds: models, runs, toolMode: mode, improverId, proposals: count, ...(known.length ? { baseline: known } : {}) }, controller.current.signal)) {
        switch (event.type) {
          case "start":
            setStart(event);
            break;
          case "phase":
            setStep(PHASE_STEP[event.phase]);
            break;
          case "result":
            setDone((n) => n + 1);
            break;
          case "diagnosis":
            setDiagnosis(event.diagnosis);
            break;
          case "proposals":
            setProposals(event.proposals);
            break;
          case "verdict":
            setVerdict(event);
            setSelected(event.winner ?? event.verdicts[0]?.variant);
            break;
          case "done":
            setMessage(event.message);
            break;
          case "error":
            throw new Error(event.message);
        }
      }
      setStage("review");
    } catch (e: any) {
      if (e?.name === "AbortError") setStage("setup");
      else {
        toast(e?.message ?? "Improve failed", "error");
        setStage("setup");
      }
    }
  };

  const proposal = proposals.find((p) => p.id === selected);
  const scored = verdict?.verdicts.find((v) => v.variant === selected);
  const kept = (proposal?.changes ?? []).filter((c) => !rejected.has(changeKey(c))).map((c) => edits[changeKey(c)] ?? c);

  const apply = async () => {
    const servers = config.mcpServers.map((s) => {
      const mine = kept.filter((c) => c.serverId === s.id);
      if (!mine.length) return s;
      const overrides = { ...s.toolOverrides };
      for (const c of mine) {
        const prev = overrides[c.tool] ?? {};
        const params = { ...prev.params };
        for (const [name, p] of Object.entries(c.params ?? {})) params[name] = { ...params[name], ...p };
        overrides[c.tool] = { ...prev, ...(c.description ? { description: c.description } : {}), ...(Object.keys(params).length ? { params } : {}) };
      }
      return { ...s, toolOverrides: overrides };
    });
    await saveConfig({ ...config, mcpServers: servers });
    toast(`Saved ${kept.length} change${kept.length === 1 ? "" : "s"} as Moka's wording. Chats and tests use it now; undo any time in Settings → MCP.`, "success");
    onClose();
  };

  const loadCode = async () => {
    const r = await api<{ ts: string; python: string; markdown: string }>("/api/improve/code", { body: { changes: kept, workspaceId: workspace.id, before: verdict?.baseline, after: scored } });
    return r;
  };
  const copyMarkdown = async () => {
    const r = await loadCode();
    await navigator.clipboard.writeText(r.markdown);
    toast("Changes copied as Markdown", "success");
  };

  const progress = start ? Math.min(100, Math.round((done / Math.max(1, start.estimatedRuns)) * 100)) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <IconButton label="Back to tests" className="h-7 w-7" onClick={() => (stage === "running" ? controller.current?.abort() : onClose())}>
          <ArrowLeft className="h-4 w-4" />
        </IconButton>
        <Wand2 className="h-4 w-4 text-accent" />
        <h1 className="text-[15px] font-semibold">Improve tool wording</h1>
        <span className="text-[13px] text-muted">· {workspace.name}</span>
        <span className="flex-1" />
        {stage !== "setup" && <Stepper step={stage === "review" ? 4 : step} done={stage === "review"} />}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {stage === "setup" && (
          <div className="mx-auto max-w-2xl space-y-5 px-5 py-8">
            <div>
              <h2 className="text-[17px] font-semibold">Make your tools easier for models to use</h2>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
                Moka looks at why tests fail, asks a strong model for better descriptions, and runs every proposal on your tests plus paraphrased prompts the proposer never sees. Only wording changes; your server stays as it is until you decide.
              </p>
            </div>
            <div className="grid gap-4 rounded-xl border border-line bg-panel p-4 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-[11px] font-medium tracking-wide text-subtle uppercase">Proposals written by</span>
                <Select value={improverId ?? ""} onChange={(e) => setImproverId(e.target.value)} className="h-9 text-[13px]">
                  {config.llms.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name} · {l.model}
                    </option>
                  ))}
                </Select>
                <span className="block text-[11.5px] text-subtle">Preselected: your strongest model. Rewriting descriptions is hard for small models.</span>
              </label>
              <label className="space-y-1.5">
                <span className="text-[11px] font-medium tracking-wide text-subtle uppercase">Alternatives to try</span>
                <Select value={String(count)} onChange={(e) => setCount(Number(e.target.value))} className="h-9 text-[13px]">
                  {[1, 2, 3].map((n) => (
                    <option key={n} value={n}>
                      {n} proposal{n === 1 ? "" : "s"}
                    </option>
                  ))}
                </Select>
                <span className="block text-[11.5px] text-subtle">
                  Tested on {models.map((m) => llm(m)?.name ?? m).join(", ")} · {runs} run{runs === 1 ? "" : "s"} each
                </span>
              </label>
            </div>
            <div className="flex items-start gap-3 rounded-xl border border-line bg-panel-2/40 px-4 py-3 text-[13px]">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <div>
                <div>
                  About <b>{estimate}</b> test runs and 2 calls to the proposer.
                  {known.length > 0 && <span className="text-muted"> Your latest results are reused as the baseline.</span>}
                </div>
                {runs === 1 && <div className="mt-1 text-warn">With 1 run per test the scores are noisy. 3 runs give a fairer verdict.</div>}
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" icon={<Wand2 className="h-4 w-4" />} disabled={!tests.length || !models.length || !improverId} onClick={() => void run()}>
                Start
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {stage === "running" && (
          <div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
            <div className="rounded-xl border border-line bg-panel p-4">
              <div className="mb-2 flex items-center gap-2 text-[13px]">
                <span className="font-medium">{STEPS[step]}</span>
                {start && (
                  <span className="text-muted">
                    · proposals by {start.improver.name} <span className="font-mono text-[11.5px]">{start.improver.model}</span>
                  </span>
                )}
                <span className="flex-1" />
                <span className="font-mono text-[12px] text-muted">
                  {done} / ≈{start?.estimatedRuns ?? estimate} runs
                </span>
                <Button size="sm" variant="outline" icon={<Square className="h-3.5 w-3.5" />} onClick={() => controller.current?.abort()}>
                  Stop
                </Button>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
                <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${progress}%` }} />
              </div>
            </div>
            {diagnosis && <DiagnosisList diagnosis={diagnosis} name={(id) => llm(id)?.name ?? id} test={(id) => tests.find((t) => t.id === id)?.name ?? tests.find((t) => t.id === id)?.prompt ?? id} />}
            {proposals.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-[11px] font-medium tracking-wide text-subtle uppercase">Proposals being verified</h3>
                {proposals.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-[13px]">
                    <Badge tone="accent">{p.id}</Badge>
                    {p.summary}
                    <span className="text-subtle">· {p.changes.length} change{p.changes.length === 1 ? "" : "s"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {stage === "review" && (
          <div className="px-5 py-5">
            {!verdict ? (
              <div className="mx-auto max-w-xl rounded-xl border border-line bg-panel p-6 text-center">
                <Check className="mx-auto mb-2 h-6 w-6 text-ok" />
                <p className="text-[14px]">{message ?? "Nothing to improve."}</p>
                <Button className="mt-4" variant="outline" onClick={onClose}>
                  Back to tests
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  {verdict.verdicts.map((v) => (
                    <button
                      key={v.variant}
                      onClick={() => setSelected(v.variant)}
                      className={cn("inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px]", selected === v.variant ? "border-accent bg-accent-soft" : "border-line hover:bg-panel-2/60")}
                    >
                      <span className="font-mono text-[12px]">{v.variant}</span>
                      <span className="max-w-64 truncate">{proposals.find((p) => p.id === v.variant)?.summary}</span>
                      {v.variant === verdict.winner ? <Badge tone="ok">best</Badge> : v.accepted ? <Badge tone="info">passes checks</Badge> : <Badge tone="err">rejected</Badge>}
                    </button>
                  ))}
                  {!verdict.winner && <span className="text-[12.5px] text-warn">No proposal beat the current wording; you can still look at them.</span>}
                </div>

                {proposal && scored && (
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                    <div className="space-y-3">
                      {proposal.changes.map((c) => {
                        const key = changeKey(c);
                        const shown = edits[key] ?? c;
                        const off = rejected.has(key);
                        return (
                          <div key={key} className={cn("rounded-xl border border-line bg-panel", off && "opacity-55")}>
                            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                              <span className="font-mono text-[13px] font-medium">{c.tool}</span>
                              <span className="truncate text-[12px] text-subtle">{mcp[c.serverId]?.name ?? c.serverId}</span>
                              <span className="flex-1" />
                              <Button size="sm" variant="ghost" onClick={() => setEditing(editing === key ? undefined : key)}>
                                {editing === key ? "Done" : "Edit"}
                              </Button>
                              <Button
                                size="sm"
                                variant={off ? "outline" : "ghost"}
                                icon={off ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                                onClick={() => setRejected((prev) => { const next = new Set(prev); off ? next.delete(key) : next.add(key); return next; })}
                              >
                                {off ? "Keep" : "Drop"}
                              </Button>
                            </div>
                            <div className="space-y-3 px-4 py-3">
                              <p className="text-[12.5px] text-muted italic">{c.reason}</p>
                              {shown.description !== undefined &&
                                (editing === key ? (
                                  <Textarea value={shown.description} rows={3} onChange={(e) => setEdits((prev) => ({ ...prev, [key]: { ...shown, description: e.target.value } }))} />
                                ) : (
                                  <Diff before={currentDescription(c)} after={shown.description} />
                                ))}
                              {Object.entries(shown.params ?? {}).map(([name, p]) => (
                                <div key={name} className="rounded-lg bg-panel-2/50 px-3 py-2">
                                  <div className="mb-1 font-mono text-[12px] text-fg">{name}</div>
                                  {editing === key ? (
                                    <Textarea
                                      value={p.description ?? ""}
                                      rows={2}
                                      onChange={(e) => setEdits((prev) => ({ ...prev, [key]: { ...shown, params: { ...shown.params, [name]: { ...p, description: e.target.value } } } }))}
                                    />
                                  ) : (
                                    p.description !== undefined && <Diff before={currentParam(c, name)} after={p.description} />
                                  )}
                                  {p.examples?.length ? (
                                    <div className="mt-1.5 flex flex-wrap gap-1">
                                      {p.examples.map((e, i) => (
                                        <code key={i} className="rounded bg-ok/10 px-1.5 py-0.5 font-mono text-[11.5px] text-ok">
                                          {JSON.stringify(e)}
                                        </code>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <Scores baseline={verdict.baseline} after={scored} name={(id) => (llm(id) ? `${llm(id)!.name} · ${llm(id)!.model}` : id)} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {stage === "review" && proposal && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-panel px-5 py-3">
          <span className="text-[12.5px] text-muted">
            {kept.length} of {proposal.changes.length} change{proposal.changes.length === 1 ? "" : "s"} kept
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" icon={<ClipboardCopy className="h-3.5 w-3.5" />} disabled={!kept.length} onClick={() => void copyMarkdown()}>
            Copy changes
          </Button>
          <Button size="sm" variant="ghost" icon={<Code2 className="h-3.5 w-3.5" />} disabled={!kept.length} onClick={() => void loadCode().then((r) => setCode({ ...r, lang: "ts" }))}>
            Copy as code
          </Button>
          <Button size="sm" variant="primary" icon={<ArrowRight className="h-3.5 w-3.5" />} disabled={!kept.length} onClick={() => void apply()}>
            Try it in Moka
          </Button>
        </div>
      )}

      {code && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => setCode(undefined)} />
          <div role="dialog" className="animate-in relative flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-soft">
            <div className="flex items-center gap-2 border-b border-line px-5 py-3">
              <h2 className="text-[15px] font-semibold">Put it in your server</h2>
              <span className="flex-1" />
              {(["ts", "python"] as const).map((l) => (
                <button key={l} onClick={() => setCode({ ...code, lang: l })} className={cn("rounded-md px-2.5 py-1 text-[12.5px]", code.lang === l ? "bg-accent-soft text-accent" : "text-muted hover:text-fg")}>
                  {l === "ts" ? "TypeScript SDK" : "Python FastMCP"}
                </button>
              ))}
              <IconButton label="Close" className="h-7 w-7" onClick={() => setCode(undefined)}>
                <X className="h-4 w-4" />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-panel-2/40 px-5 py-4 text-[12px] leading-relaxed">
              <Highlighted code={code[code.lang]} lang={code.lang === "ts" ? "ts" : "python"} wrap />
            </div>
            <div className="flex items-center gap-2 border-t border-line px-5 py-3">
              <span className="text-[12px] text-subtle">Generated from the strings, not by a model. Types and handlers stay yours.</span>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="primary"
                icon={<ClipboardCopy className="h-3.5 w-3.5" />}
                onClick={() => void navigator.clipboard.writeText(code[code.lang]).then(() => toast("Code copied", "success"))}
              >
                Copy
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DiagnosisList({ diagnosis, name, test }: { diagnosis: Diagnosis[]; name: (id: string) => string; test: (id: string) => string }) {
  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-medium tracking-wide text-subtle uppercase">Why tests fail</h3>
      {diagnosis.length === 0 && <p className="text-[13px] text-muted">No failures.</p>}
      {diagnosis.map((d, i) => {
        const failed = d.models.reduce((n, m) => n + m.failed, 0);
        const of = d.models.reduce((n, m) => n + m.runs, 0);
        return (
          <div key={i} className="flex items-start gap-3 rounded-lg border border-line bg-panel px-3 py-2.5 text-[13px]">
            <Badge tone={d.kind === "forbidden-call" || d.kind === "error" ? "err" : "warn"}>{KIND[d.kind]}</Badge>
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[12.5px]">{d.detail}</div>
              <div className="mt-0.5 truncate text-[12px] text-subtle">
                {test(d.testId)} · {d.models.map((m) => name(m.llmId)).join(", ")}
              </div>
            </div>
            <span className="font-mono text-[12px] whitespace-nowrap text-muted">
              {failed} of {of} runs
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Scores({ baseline, after, name }: { baseline: VariantScore; after: ProposalVerdict; name: (id: string) => string }) {
  const row = (label: string, b: [number, number], a: [number, number]) => {
    const delta = pct(a[0], a[1]) - pct(b[0], b[1]);
    return (
      <tr key={label} className="border-b border-line last:border-0">
        <td className="py-2 pr-2 text-[13px]">{label}</td>
        <td className="py-2 text-right font-mono text-[12.5px] text-muted">{`${b[0]}/${b[1]}`}</td>
        <td className="px-1 py-2 text-center text-subtle">→</td>
        <td className="py-2 font-mono text-[12.5px]">{`${a[0]}/${a[1]}`}</td>
        <td className={cn("py-2 text-right font-mono text-[12px]", delta > 0 ? "text-ok" : delta < 0 ? "text-err" : "text-subtle")}>
          {delta > 0 ? "+" : ""}
          {delta} pts
        </td>
      </tr>
    );
  };
  const tokensDelta = after.tokens.after - after.tokens.before;
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-panel p-4">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-[13px] font-semibold">Before → after</h3>
          <span className="flex-1" />
          {after.accepted ? <Badge tone="ok">passes every check</Badge> : <Badge tone="err">rejected</Badge>}
        </div>
        <table className="w-full">
          <tbody>
            {after.perModel.map((m) => {
              const b = baseline.perModel.find((x) => x.llmId === m.llmId);
              return row(name(m.llmId), [b?.passed ?? 0, b?.total ?? 0], [m.passed, m.total]);
            })}
            {after.holdoutTotal > 0 && row("Unseen prompts", [baseline.holdoutPassed, baseline.holdoutTotal], [after.holdoutPassed, after.holdoutTotal])}
          </tbody>
        </table>
        <p className="mt-2 text-[11.5px] text-subtle">Per model: every run, your tests and the unseen prompts. Unseen prompts are paraphrases of your tests the proposer never saw, so wording that only games your tests doesn't win.</p>
      </div>
      <div className="rounded-xl border border-line bg-panel p-4 text-[13px]">
        <div className="flex items-center justify-between">
          <span className="text-muted">Tokens for the changed tools</span>
          <span className="font-mono text-[12.5px]">
            {after.tokens.before} → {after.tokens.after}{" "}
            <span className={cn(tokensDelta > after.tokens.before / 2 ? "text-warn" : "text-subtle")}>
              ({tokensDelta >= 0 ? "+" : ""}
              {tokensDelta})
            </span>
          </span>
        </div>
        {after.regressions.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[11px] font-medium tracking-wide text-err uppercase">Regressions</div>
            {after.regressions.map((r, i) => (
              <p key={i} className="text-[12.5px] text-err">
                {r}
              </p>
            ))}
          </div>
        )}
        {after.findings.length > 0 && (
          <div className="mt-3 space-y-1">
            {after.findings.map((f, i) => (
              <p key={i} className="flex items-start gap-1.5 text-[12.5px] text-warn">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {f.title} <span className="text-subtle">({f.where})</span>
              </p>
            ))}
          </div>
        )}
        {after.notes.length > 0 && (
          <ul className="mt-3 list-disc space-y-0.5 pl-4 text-[12.5px] text-muted">
            {after.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
