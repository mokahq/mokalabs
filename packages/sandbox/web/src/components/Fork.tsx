import { ChevronLeft, ChevronRight, Columns2, GitFork, Pencil, RotateCcw, Shuffle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { forkFromStep, forkWithArguments, forkWithReply, forkWithResult, partSteps, turnRange, type ForkPlan } from "../timetravel";
import type { Branch, Part, UiMessage } from "../types";
import { Markdown } from "./Markdown";
import { Badge, Button, IconButton, Modal, Textarea, cn, formatMs, formatNumber } from "./ui";

type Edit = { kind: "result" | "arguments" | "reply"; partIndex: number };

/** The turn's model messages for the reply with this id (time-travel needs them to fork). */
function useTurn(messageId: string): unknown[] {
  const session = useStore((s) => s.session);
  return useMemo(() => {
    const index = session.messages.findIndex((m) => m.id === messageId);
    if (index < 0) return [];
    const [start, end] = turnRange(session.messages, session.modelMessages, index);
    return session.modelMessages.slice(start, end);
  }, [session.messages, session.modelMessages, messageId]);
}

const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "");

/**
 * ⑂ next to a step of a reply: run it again from there with a change: a tool's
 * result or arguments, the model's text, another model, or just again. The
 * model's thinking can't be edited.
 */
export function ForkMenu({ message, partIndex }: { message: UiMessage; partIndex: number }) {
  const config = useStore((s) => s.config);
  const fork = useStore((s) => s.fork);
  const turn = useTurn(message.id);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState(false);
  const [edit, setEdit] = useState<Edit>();
  const ref = useRef<HTMLDivElement>(null);
  const part = message.parts[partIndex]!;
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && (setOpen(false), setModels(false));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (setOpen(false), setModels(false));
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  // A reply without model messages (an old error, a remote agent) can't be forked.
  if (!turn.length || part.type === "attachment") return null;
  const step = partSteps(message.parts, turn)[partIndex]! + 1;
  const run = (plan: ForkPlan, llmId?: string) => {
    setOpen(false);
    setModels(false);
    void fork(message.id, plan, llmId);
  };
  const item = "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-panel-2";
  return (
    <div ref={ref} className="relative">
      <IconButton label={`Fork from step ${step}`} className={cn("h-6 w-6", open && "bg-panel-2 text-fg")} onClick={() => setOpen(!open)}>
        <GitFork className="h-3.5 w-3.5" />
      </IconButton>
      {open && (
        <div role="menu" className="animate-in absolute top-7 left-0 z-30 w-60 rounded-xl border border-line bg-panel p-1 shadow-soft">
          <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">Fork from step {step}</div>
          {part.type === "tool" && (
            <>
              <button role="menuitem" className={item} onClick={() => (setOpen(false), setEdit({ kind: "result", partIndex }))}>
                <Pencil className="h-3.5 w-3.5 text-muted" /> Edit result…
              </button>
              <button role="menuitem" className={item} onClick={() => (setOpen(false), setEdit({ kind: "arguments", partIndex }))}>
                <Pencil className="h-3.5 w-3.5 text-muted" /> Edit arguments…
              </button>
            </>
          )}
          {part.type === "text" && (
            <button role="menuitem" className={item} onClick={() => (setOpen(false), setEdit({ kind: "reply", partIndex }))}>
              <Pencil className="h-3.5 w-3.5 text-muted" /> Edit reply…
            </button>
          )}
          <button role="menuitem" className={item} onClick={() => run(forkFromStep(message, turn, partIndex))}>
            <RotateCcw className="h-3.5 w-3.5 text-muted" /> Retry from here
          </button>
          <button role="menuitem" className={item} onClick={() => setModels(!models)}>
            <Shuffle className="h-3.5 w-3.5 text-muted" /> Run from here with…
            <ChevronRight className={cn("ml-auto h-3.5 w-3.5 text-subtle transition-transform", models && "rotate-90")} />
          </button>
          {models &&
            config.llms.map((l) => (
              <button key={l.id} role="menuitem" className={cn(item, "pl-8")} onClick={() => run(forkFromStep(message, turn, partIndex, { id: l.id, label: l.model }), l.id)}>
                <span className="truncate">{l.name}</span>
                <span className="truncate font-mono text-[11px] text-subtle">{l.model}</span>
              </button>
            ))}
        </div>
      )}
      {edit && <ForkDialog message={message} turn={turn} edit={edit} onClose={() => setEdit(undefined)} onFork={(plan) => (setEdit(undefined), void fork(message.id, plan))} />}
    </div>
  );
}

function ForkDialog({ message, turn, edit, onClose, onFork }: { message: UiMessage; turn: unknown[]; edit: Edit; onClose: () => void; onFork: (plan: ForkPlan) => void }) {
  const part = message.parts[edit.partIndex]! as Part;
  const initial = part.type === "tool" ? (edit.kind === "result" ? asText(part.output) : JSON.stringify(part.input ?? {}, null, 2)) : part.type === "text" ? part.text : "";
  const [text, setText] = useState(initial);
  const [asError, setAsError] = useState(part.type === "tool" && part.isError === true);
  const [error, setError] = useState<string>();
  const final = edit.kind === "reply" && forkWithReply(message, turn, edit.partIndex, "").done;
  const title = edit.kind === "result" ? `Edit the result of ${part.type === "tool" ? part.tool : ""}` : edit.kind === "arguments" ? `Edit the arguments of ${part.type === "tool" ? part.tool : ""}` : "Edit the reply";
  const description =
    edit.kind === "result"
      ? "The model continues as if the tool had returned this. The tool doesn't run again."
      : edit.kind === "arguments"
        ? "Moka runs the tool again with these arguments, then the model continues."
        : final
          ? "Saved as a new branch of this reply; nothing runs. Your next message continues from it."
          : "The model continues from your version. Its thinking at this step is dropped (thinking can't be edited).";
  const submit = () => {
    if (part.type === "tool" && edit.kind === "arguments") {
      let input: unknown;
      try {
        input = JSON.parse(text);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
      } catch {
        setError("Arguments must be a JSON object.");
        return;
      }
      onFork(forkWithArguments(message, turn, part.id, input));
    } else if (part.type === "tool") onFork(forkWithResult(message, turn, part.id, text, asError));
    else onFork(forkWithReply(message, turn, edit.partIndex, text));
  };
  return (
    <Modal open onClose={onClose} title={title} description={description} className="max-w-2xl">
      <div className="space-y-3 px-5 py-4">
        <Textarea autoFocus mono={edit.kind !== "reply"} rows={edit.kind === "reply" ? 8 : 10} value={text} onChange={(e) => (setText(e.target.value), setError(undefined))} />
        {edit.kind === "result" && (
          <label className="flex items-center gap-2 text-[13px] text-muted">
            <input type="checkbox" checked={asError} onChange={(e) => setAsError(e.target.checked)} className="accent-[var(--accent)]" />
            Return it as an error (what if the tool had failed?)
          </label>
        )}
        {error && <p className="text-[12.5px] text-err">{error}</p>}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-5 py-3">
        <span className="text-[12px] text-subtle">The original reply stays; this becomes a new branch.</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" icon={<GitFork className="h-3.5 w-3.5" />} disabled={!text.trim() && edit.kind !== "result"} onClick={submit}>
          {final ? "Save as branch" : "Fork and run"}
        </Button>
      </div>
    </Modal>
  );
}

/** Between the parts a fork shares with its original and the new ones. */
export function ForkDivider({ message }: { message: UiMessage }) {
  if (!message.fork) return null;
  return (
    <div className="flex items-center gap-2 py-1 text-[11.5px] text-subtle">
      <span className="h-px flex-1 bg-line" />
      <GitFork className="h-3 w-3 text-accent" />
      <span>
        Forked at step {message.fork.step} · <span className="text-muted">{message.fork.label}</span>
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/** ‹ 2 / 3 › under a reply with branches, and Compare. */
export function BranchBar({ message }: { message: UiMessage }) {
  const showBranch = useStore((s) => s.showBranch);
  const streaming = useStore((s) => s.streaming);
  const [comparing, setComparing] = useState(false);
  const branches = message.branches;
  if (!branches || branches.length < 2) return null;
  const at = message.branch ?? 0;
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-muted">
      <IconButton label="Previous branch" className="h-5 w-5" disabled={streaming || at === 0} onClick={() => showBranch(message.id, at - 1)}>
        <ChevronLeft className="h-3 w-3" />
      </IconButton>
      <span className="font-mono tabular-nums">
        {at + 1} / {branches.length}
      </span>
      <IconButton label="Next branch" className="h-5 w-5" disabled={streaming || at === branches.length - 1} onClick={() => showBranch(message.id, at + 1)}>
        <ChevronRight className="h-3 w-3" />
      </IconButton>
      <span className="max-w-48 truncate">{branches[at]?.label}</span>
      <button className="ml-1 inline-flex items-center gap-1 rounded px-1 hover:text-fg" disabled={streaming} aria-label="Compare branches" title="Compare branches side by side" onClick={() => setComparing(true)}>
        <Columns2 className="h-3 w-3" /> Compare
      </button>
      {comparing && <CompareBranches branches={branches.map((b, i) => (i === at ? { ...b, message: { ...message, branches: undefined } } : b))} onClose={() => setComparing(false)} />}
    </span>
  );
}

type Step = { kind: "tool"; tool: string; input: unknown; output?: unknown; isError?: boolean; edited?: string } | { kind: "text"; text: string; edited?: boolean };

function stepsOf(message: UiMessage): Step[] {
  return message.parts.flatMap((p): Step[] =>
    p.type === "tool" ? [{ kind: "tool", tool: p.tool, input: p.input, output: p.output, isError: p.isError, edited: p.edited }] : p.type === "text" && p.text.trim() ? [{ kind: "text", text: p.text, edited: p.edited }] : [],
  );
}

const key = (s: Step | undefined) => (!s ? "" : s.kind === "tool" ? `${s.tool}\u0000${JSON.stringify(s.input)}\u0000${s.isError ? 1 : 0}` : `text\u0000${s.text.trim()}`);

/** Branches side by side: their tool calls and answers in order, what differs highlighted, with time and tokens. */
function CompareBranches({ branches, onClose }: { branches: Branch[]; onClose: () => void }) {
  const lanes = branches.map((b) => ({ branch: b, steps: stepsOf(b.message) }));
  // A step differs when the branches don't all have the same thing at that position.
  const differs = (i: number) => new Set(lanes.map((l) => key(l.steps[i]))).size > 1;
  return (
    <Modal open onClose={onClose} title="Compare branches" description="Each branch's tool calls and answer, in order. Steps that differ between branches are highlighted." className="max-w-6xl">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid gap-px bg-line" style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(260px, 1fr))` }}>
          {lanes.map(({ branch, steps }, b) => {
            const meta = branch.message.meta ?? {};
            const tools = steps.filter((s) => s.kind === "tool").length;
            return (
              <div key={b} className="min-w-0 bg-panel">
                <div className="sticky top-0 z-10 border-b border-line bg-panel px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-subtle">{b + 1}</span>
                    <span className="truncate text-[13px] font-medium">{branch.label}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[11px] text-subtle">
                    {meta.model && <span>{meta.model}</span>}
                    {meta.durationMs !== undefined && <span>{formatMs(meta.durationMs)}</span>}
                    {meta.usage?.totalTokens !== undefined && <span>{formatNumber(meta.usage.totalTokens)} tok</span>}
                    <span>
                      {tools} tool call{tools === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
                <div className="space-y-2 p-3">
                  {steps.map((s, i) => (
                    <div key={i} className={cn("rounded-lg border px-3 py-2 text-[12.5px]", differs(i) ? "border-warn/50 bg-warn/5" : "border-line")}>
                      {s.kind === "tool" ? (
                        <>
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-medium">{s.tool}</span>
                            {s.isError && <Badge tone="err">error</Badge>}
                            {s.edited && <Badge tone="violet">✎ edited {s.edited}</Badge>}
                          </div>
                          <div className="mt-1 truncate font-mono text-[11.5px] text-muted" title={JSON.stringify(s.input)}>
                            {JSON.stringify(s.input)}
                          </div>
                          {s.output !== undefined && <div className="mt-1 line-clamp-3 font-mono text-[11px] text-subtle">→ {asText(s.output)}</div>}
                        </>
                      ) : (
                        <>
                          {s.edited && <Badge tone="violet">✎ edited</Badge>}
                          <Markdown text={s.text} className="text-[13px]" />
                        </>
                      )}
                    </div>
                  ))}
                  {branch.message.meta?.error && <p className="text-[12.5px] text-err">{branch.message.meta.error}</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex justify-end border-t border-line px-5 py-3">
        <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
