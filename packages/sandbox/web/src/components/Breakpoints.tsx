import { CircleDot, Pause, Play, Plus, Square, StepForward, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { uid } from "../runner";
import { useStore } from "../store";
import type { Breakpoint, BreakpointPhase, Interaction } from "../types";
import { Badge, Button, IconButton, JsonView, Select, Switch, Textarea, cn } from "./ui";

type Paused = Extract<Interaction, { kind: "breakpoint" }>;

const PHASES: Record<BreakpointPhase, string> = {
  "before-tool": "Before a tool runs",
  "after-tool": "After a tool returns",
  error: "On a tool error",
  "model-step": "Before each model step",
};

const OPS = { eq: "is", ne: "is not", contains: "contains", gt: ">", lt: "<", exists: "is set" } as const;

/** The workspace's breakpoints, and a way to save them (they live in moka.json, so a repro carries them). */
function useBreakpoints() {
  const config = useStore((s) => s.config);
  const workspace = useStore((s) => s.workspace());
  const saveConfig = useStore((s) => s.saveConfig);
  const save = (patch: { breakpoints?: Breakpoint[]; breakpointsActive?: boolean }, message?: string) =>
    saveConfig({ ...config, workspaces: config.workspaces.map((w) => (w.id === workspace.id ? { ...w, ...patch } : w)) }, message);
  return { list: workspace.breakpoints ?? [], active: workspace.breakpointsActive !== false, save };
}

export function describeBreakpoint(b: Breakpoint): string {
  if (b.on === "model-step") return "Before each model step";
  const what = b.tool ? b.tool : "any tool";
  const when = b.when ? ` when ${b.when.arg} ${OPS[b.when.op]}${b.when.op === "exists" ? "" : ` ${JSON.stringify(b.when.value)}`}` : "";
  return `${b.on === "before-tool" ? "Before" : b.on === "after-tool" ? "After" : "On an error in"} ${what}${when}`;
}

/** A red dot on a tool card: pause before this tool runs, next time. */
export function ToolBreakDot({ tool }: { tool: string }) {
  const { list, save } = useBreakpoints();
  const existing = list.find((b) => b.on === "before-tool" && b.tool === tool && !b.when);
  return (
    <button
      title={existing ? `Remove the breakpoint before ${tool}` : `Pause before ${tool} runs (breakpoint)`}
      aria-label={existing ? `Remove breakpoint before ${tool}` : `Add breakpoint before ${tool}`}
      onClick={(e) => {
        e.stopPropagation();
        void save(
          { breakpoints: existing ? list.filter((b) => b !== existing) : [...list, { id: uid("bp"), on: "before-tool", tool }] },
          existing ? `Breakpoint before ${tool} removed` : `Chats will pause before ${tool} runs`,
        );
      }}
      className={cn("grid h-4 w-4 place-items-center rounded-full", existing ? "opacity-100" : "opacity-0 group-hover/part:opacity-70 hover:!opacity-100 focus-visible:opacity-100")}
    >
      <span className={cn("h-2.5 w-2.5 rounded-full", existing ? "bg-err" : "border border-err/70")} />
    </button>
  );
}

/** Breakpoints for the workspace, in the inspector: list, add, turn off. */
export function BreakpointsPanel({ onClose }: { onClose: () => void }) {
  const { list, active, save } = useBreakpoints();
  const mcp = useStore((s) => s.mcp);
  const workspace = useStore((s) => s.workspace());
  const tools = useMemo(() => [...new Set(workspace.mcpServerIds.flatMap((id) => mcp[id]?.tools.map((t) => t.name) ?? []))].sort(), [workspace.mcpServerIds, mcp]);
  const [draft, setDraft] = useState<{ on: BreakpointPhase; tool: string; arg: string; op: keyof typeof OPS; value: string }>({ on: "before-tool", tool: "", arg: "", op: "eq", value: "" });
  const add = () => {
    let value: unknown = draft.value;
    try {
      value = JSON.parse(draft.value);
    } catch {
      // a plain string
    }
    const bp: Breakpoint = {
      id: uid("bp"),
      on: draft.on,
      ...(draft.on !== "model-step" && draft.tool ? { tool: draft.tool } : {}),
      ...(draft.on !== "model-step" && draft.arg.trim() ? { when: { arg: draft.arg.trim(), op: draft.op, ...(draft.op === "exists" ? {} : { value }) } } : {}),
    };
    void save({ breakpoints: [...list, bp] }, `Breakpoint added: ${describeBreakpoint(bp)}`);
    setDraft({ ...draft, arg: "", value: "" });
  };
  return (
    <div className="space-y-2 border-b border-line bg-panel-2/40 px-3 py-2.5 text-[12.5px]">
      <div className="flex items-center gap-2">
        <CircleDot className="h-3.5 w-3.5 text-err" />
        <span className="font-semibold">Breakpoints</span>
        <span className="text-subtle">· {workspace.name}</span>
        <span className="flex-1" />
        <Switch checked={active} onChange={(on) => void save({ breakpointsActive: on ? undefined : false }, on ? "Breakpoints on" : "Breakpoints off: chats run without stopping")} label="Stop at breakpoints" />
        <IconButton label="Close breakpoints" className="h-6 w-6" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {list.length === 0 && <p className="text-muted">None yet. Chats pause where you add one; tests and Improve never pause.</p>}
      {list.map((b) => (
        <div key={b.id} className={cn("flex items-center gap-2 rounded-lg border border-line bg-panel px-2 py-1.5", (b.enabled === false || !active) && "opacity-55")}>
          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", b.enabled === false ? "border border-err/60" : "bg-err")} />
          <span className="min-w-0 flex-1 truncate">{describeBreakpoint(b)}</span>
          <Switch checked={b.enabled !== false} onChange={(on) => void save({ breakpoints: list.map((x) => (x.id === b.id ? { ...x, enabled: on ? undefined : false } : x)) })} label="Enabled" />
          <IconButton label="Remove" className="h-6 w-6" onClick={() => void save({ breakpoints: list.filter((x) => x.id !== b.id) })}>
            <Trash2 className="h-3 w-3" />
          </IconButton>
        </div>
      ))}
      <div className="grid grid-cols-2 gap-1.5">
        <Select value={draft.on} onChange={(e) => setDraft({ ...draft, on: e.target.value as BreakpointPhase })} className="h-8 text-[12px]" aria-label="When">
          {(Object.keys(PHASES) as BreakpointPhase[]).map((p) => (
            <option key={p} value={p}>
              {PHASES[p]}
            </option>
          ))}
        </Select>
        <Select value={draft.tool} disabled={draft.on === "model-step"} onChange={(e) => setDraft({ ...draft, tool: e.target.value })} className="h-8 text-[12px]" aria-label="Tool">
          <option value="">Any tool</option>
          {tools.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        {draft.on !== "model-step" && (
          <div className="col-span-2 flex items-center gap-1.5">
            <span className="text-subtle">if</span>
            <input value={draft.arg} onChange={(e) => setDraft({ ...draft, arg: e.target.value })} placeholder="argument (optional)" className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-panel px-2 font-mono text-[12px] placeholder:font-sans placeholder:text-subtle focus:outline-none" />
            <Select value={draft.op} onChange={(e) => setDraft({ ...draft, op: e.target.value as keyof typeof OPS })} className="h-8 w-auto text-[12px]" aria-label="Comparison">
              {(Object.keys(OPS) as Array<keyof typeof OPS>).map((o) => (
                <option key={o} value={o}>
                  {OPS[o]}
                </option>
              ))}
            </Select>
            {draft.op !== "exists" && (
              <input value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} placeholder="value" className="h-8 w-24 rounded-lg border border-line bg-panel px-2 font-mono text-[12px] placeholder:font-sans placeholder:text-subtle focus:outline-none" />
            )}
          </div>
        )}
      </div>
      <Button size="xs" variant="outline" icon={<Plus className="h-3 w-3" />} onClick={add}>
        Add breakpoint
      </Button>
    </div>
  );
}

const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "");

/**
 * The bar over the composer while a chat is paused at a breakpoint: what it
 * stopped on, the data to edit, and Continue (F8), Step (F10), Skip, Fail, Stop.
 */
export function PausedBar() {
  const interactions = useStore((s) => s.interactions);
  const paused = useMemo(() => Object.values(interactions).filter((i): i is Paused => i.kind === "breakpoint").sort((a, b) => a.createdAt - b.createdAt)[0], [interactions]);
  if (!paused) return null;
  return <PausedAt key={paused.id} paused={paused} />;
}

function PausedAt({ paused }: { paused: Paused }) {
  const respond = useStore((s) => s.respond);
  const config = useStore((s) => s.config);
  const workspace = useStore((s) => s.workspace());
  const editable = paused.phase === "before-tool" ? JSON.stringify(paused.input ?? {}, null, 2) : paused.phase === "after-tool" ? (paused.output ?? "") : paused.phase === "error" ? "" : undefined;
  const [text, setText] = useState(editable ?? "");
  const [llmId, setLlmId] = useState(config.llms.find((l) => l.model === paused.model)?.id ?? workspace.llmId ?? "");
  const [error, setError] = useState<string>();
  const changed = editable !== undefined && text !== editable;
  const breakpoint = (workspace.breakpoints ?? []).find((b) => b.id === paused.breakpointId);

  const decide = (action: "continue" | "step" | "skip" | "fail" | "stop") => {
    const decision: Record<string, unknown> = { action };
    if ((action === "continue" || action === "step") && changed) {
      if (paused.phase === "before-tool") {
        try {
          decision.input = JSON.parse(text);
        } catch {
          setError("Arguments must be valid JSON.");
          return;
        }
      } else decision.output = text;
    }
    if (paused.phase === "error" && (action === "continue" || action === "step") && text.trim()) decision.output = text;
    if (paused.phase === "model-step" && llmId && config.llms.find((l) => l.id === llmId)?.model !== paused.model) decision.llmId = llmId;
    void respond(paused.id, decision);
  };

  // F8 continue, F10 step: the shortcuts debuggers use.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F8") (e.preventDefault(), decide("continue"));
      if (e.key === "F10") (e.preventDefault(), decide("step"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const title =
    paused.phase === "model-step" ? (
      <>
        Paused before model step {paused.step} <span className="text-muted">· {paused.model}</span>
      </>
    ) : (
      <>
        Paused {paused.phase === "before-tool" ? "before" : paused.phase === "after-tool" ? "after" : "on an error in"} <span className="font-mono">{paused.tool}</span> <span className="text-muted">· {paused.serverName}</span>
      </>
    );
  return (
    <div className="animate-in mx-auto mb-2 w-full max-w-3xl overflow-hidden rounded-xl border border-err/40 bg-panel shadow-soft" role="region" aria-label="Paused at a breakpoint">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-err/5 px-3 py-2 text-[13px]">
        <Pause className="h-3.5 w-3.5 text-err" />
        <span className="font-medium">{title}</span>
        {breakpoint ? <Badge tone="err">{describeBreakpoint(breakpoint)}</Badge> : <Badge>stepping</Badge>}
      </div>
      <div className="space-y-2 px-3 py-2.5">
        {paused.phase === "model-step" ? (
          <div className="grid gap-2 md:grid-cols-[1fr_auto]">
            <div>
              <div className="mb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">About to send {paused.messages?.length ?? 0} messages</div>
              <JsonView value={paused.messages ?? []} maxHeight="9rem" />
            </div>
            <label className="text-[12px] text-muted">
              <span className="mb-1 block text-[11px] font-medium tracking-wide text-subtle uppercase">Model for this step</span>
              <Select value={llmId} onChange={(e) => setLlmId(e.target.value)} className="h-8 text-[12.5px]">
                {config.llms.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} · {l.model}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        ) : (
          <>
            {paused.phase === "error" && <p className="rounded-lg bg-err/5 px-2.5 py-1.5 font-mono text-[12px] text-err">{paused.error}</p>}
            {paused.phase !== "before-tool" && paused.input !== undefined && (
              <div className="truncate font-mono text-[11.5px] text-subtle" title={asText(paused.input)}>
                arguments: {JSON.stringify(paused.input)}
              </div>
            )}
            <div>
              <div className="mb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">
                {paused.phase === "before-tool" ? "Arguments (edit to change what runs)" : paused.phase === "after-tool" ? "Result (edit to change what the model sees)" : "A result to use instead of the error (optional)"}
              </div>
              <Textarea mono rows={paused.phase === "before-tool" ? 4 : 5} value={text} onChange={(e) => (setText(e.target.value), setError(undefined))} />
              {paused.phase === "before-tool" && changed && <p className="mt-1 text-[11.5px] text-subtle">The tool runs with these; the model's own message keeps the arguments it chose.</p>}
              {error && <p className="mt-1 text-[12px] text-err">{error}</p>}
            </div>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
        <Button size="xs" variant="ghost" icon={<Square className="h-3 w-3" />} onClick={() => decide("stop")}>
          Stop
        </Button>
        {paused.phase === "before-tool" && (
          <Button size="xs" variant="ghost" onClick={() => decide("skip")} title="Don't run the tool; the model is told it was skipped">
            Skip
          </Button>
        )}
        {(paused.phase === "before-tool" || paused.phase === "after-tool") && (
          <Button size="xs" variant="ghost" onClick={() => decide("fail")} title="The tool fails, as if it had returned an error">
            Fail
          </Button>
        )}
        <span className="flex-1" />
        <Button size="xs" variant="outline" icon={<StepForward className="h-3 w-3" />} onClick={() => decide("step")} title="Continue, and pause at the next tool call or model step (F10)">
          Step <kbd className="ml-1 font-mono text-[10px] text-subtle">F10</kbd>
        </Button>
        <Button size="xs" variant="primary" icon={<Play className="h-3 w-3" />} onClick={() => decide("continue")} title="Continue (F8)">
          {changed ? "Continue with edits" : "Continue"} <kbd className="ml-1 font-mono text-[10px] opacity-70">F8</kbd>
        </Button>
      </div>
    </div>
  );
}
