import { Clock, Coins, GitCompareArrows, Hammer, Plus, Timer, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { runTurn, uid } from "../runner";
import { useStore } from "../store";
import type { UiMessage } from "../types";
import { Composer, ToolCard } from "./Chat";
import { Markdown } from "./Markdown";
import { ToolUi } from "./ToolUi";
import { Button, Empty, IconButton, Select, Spinner, cn, formatMs, formatNumber } from "./ui";

interface Lane {
  id: string;
  llmId: string;
  history: unknown[];
  turns: Array<{ prompt: string; reply?: UiMessage }>;
}

/** Run the same prompt against several models side by side, with the same tools. */
export function CompareView() {
  const config = useStore((s) => s.config);
  const workspace = useStore((s) => s.workspace());
  const openSettings = useStore((s) => s.openSettings);
  const initial = (
    workspace.agentId
      ? [`agent:${workspace.agentId}`, workspace.llmId ?? config.llms[0]?.id]
      : [workspace.llmId ?? config.llms[0]?.id, config.llms.find((l) => l.id !== workspace.llmId)?.id ?? config.agents.map((a) => `agent:${a.id}`)[0] ?? config.llms[0]?.id]
  ).filter(Boolean) as string[];
  const [lanes, setLanes] = useState<Lane[]>(() => initial.map((llmId) => ({ id: uid("lane"), llmId, history: [], turns: [] })));
  const [running, setRunning] = useState(0);
  const controllers = useRef<AbortController[]>([]);

  if (config.llms.length === 0 && config.agents.length === 0) {
    return (
      <Empty icon={<GitCompareArrows className="h-5 w-5" />} title="Add models to compare" action={<Button variant="primary" onClick={() => openSettings("models")}>Add a model</Button>}>
        Compare runs one prompt against several models with the same MCP tools and skills, then shows latency, tokens and tool usage side by side.
      </Empty>
    );
  }

  const send = async (prompt: string) => {
    controllers.current = lanes.map(() => new AbortController());
    setRunning(lanes.length);
    await Promise.all(
      lanes.map(async (lane, index) => {
        const history = [...lane.history, { role: "user", content: prompt }];
        setLanes((ls) => ls.map((l) => (l.id === lane.id ? { ...l, turns: [...l.turns, { prompt }] } : l)));
        const result = await runTurn({
          modelMessages: history,
          workspaceId: workspace.id,
          llmId: lane.llmId,
          signal: controllers.current[index]!.signal,
          onUpdate: (reply) =>
            setLanes((ls) => ls.map((l) => (l.id === lane.id ? { ...l, turns: l.turns.map((t, i) => (i === l.turns.length - 1 ? { ...t, reply } : t)) } : l))),
        });
        setLanes((ls) =>
          ls.map((l) =>
            l.id === lane.id
              ? { ...l, history: [...history, ...result.responseMessages], turns: l.turns.map((t, i) => (i === l.turns.length - 1 ? { ...t, reply: result.message } : t)) }
              : l,
          ),
        );
        setRunning((n) => n - 1);
      }),
    );
  };

  const stop = () => controllers.current.forEach((c) => c.abort());
  const reset = () => setLanes((ls) => ls.map((l) => ({ ...l, history: [], turns: [] })));
  const busy = running > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <GitCompareArrows className="h-4 w-4 text-accent" />
        <span className="text-[13px] font-medium">Compare</span>
        <span className="text-[12px] text-muted">· same prompt, same tools ({workspace.name}), different models</span>
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={reset} disabled={busy}>
          Clear
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={busy || lanes.length >= 4}
          icon={<Plus className="h-3 w-3" />}
          onClick={() =>
            setLanes((ls) => {
              const targets = [...config.llms.map((l) => l.id), ...config.agents.map((a) => `agent:${a.id}`)];
              return [...ls, { id: uid("lane"), llmId: targets[ls.length % targets.length]!, history: [], turns: [] }];
            })
          }
        >
          Add lane
        </Button>
      </div>
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(0, 1fr))` }}>
        {lanes.map((lane) => (
          <LaneView
            key={lane.id}
            lane={lane}
            busy={busy}
            canRemove={lanes.length > 1}
            onModel={(llmId) => setLanes((ls) => ls.map((l) => (l.id === lane.id ? { ...l, llmId, history: [], turns: [] } : l)))}
            onRemove={() => setLanes((ls) => ls.filter((l) => l.id !== lane.id))}
          />
        ))}
      </div>
      <Composer compact busy={busy} onSend={send} onStop={stop} placeholder="Ask every model at once…" />
    </div>
  );
}

function LaneView({ lane, busy, canRemove, onModel, onRemove }: { lane: Lane; busy: boolean; canRemove: boolean; onModel: (id: string) => void; onRemove: () => void }) {
  const config = useStore((s) => s.config);
  const last = lane.turns[lane.turns.length - 1]?.reply;
  const totals = lane.turns.reduce(
    (acc, t) => {
      acc.tokens += t.reply?.meta?.usage?.totalTokens ?? 0;
      acc.time += t.reply?.meta?.durationMs ?? 0;
      acc.tools += t.reply?.parts.filter((p) => p.type === "tool").length ?? 0;
      return acc;
    },
    { tokens: 0, time: 0, tools: 0 },
  );
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lane.turns]);

  return (
    <div className="flex min-h-0 flex-col border-r border-line last:border-r-0">
      <div className="flex items-center gap-2 border-b border-line bg-panel-2/40 px-3 py-2">
        <div className="min-w-0 flex-1">
          <Select value={lane.llmId} disabled={busy} onChange={(e) => onModel(e.target.value)} className="h-8 text-[13px]">
            {config.llms.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} · {l.model}
              </option>
            ))}
            {config.agents.map((a) => (
              <option key={a.id} value={`agent:${a.id}`}>
                {a.name} · {a.protocol === "a2a" ? "A2A agent" : "AG-UI agent"}
              </option>
            ))}
          </Select>
        </div>
        {canRemove && (
          <IconButton label="Remove lane" onClick={onRemove} disabled={busy}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      <div className="flex gap-3 border-b border-line px-3 py-1.5 font-mono text-[11px] text-muted">
        <span className="inline-flex items-center gap-1" title="Total time">
          <Clock className="h-3 w-3" /> {formatMs(totals.time) || "–"}
        </span>
        <span className="inline-flex items-center gap-1" title="Time to first token (last turn)">
          <Timer className="h-3 w-3" /> {formatMs(last?.meta?.firstTokenMs) || "–"}
        </span>
        <span className="inline-flex items-center gap-1" title="Tokens">
          <Coins className="h-3 w-3" /> {formatNumber(totals.tokens || undefined)}
        </span>
        <span className="inline-flex items-center gap-1" title="Tool calls">
          <Hammer className="h-3 w-3" /> {totals.tools}
        </span>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {lane.turns.length === 0 && <p className="pt-10 text-center text-[13px] text-subtle">Waiting for a prompt…</p>}
        {lane.turns.map((turn, i) => (
          <div key={i} className="space-y-3">
            <div className="ml-auto w-fit max-w-[90%] rounded-2xl rounded-br-md bg-accent-soft px-3 py-2 text-[14px] whitespace-pre-wrap">{turn.prompt}</div>
            {!turn.reply || (turn.reply.parts.length === 0 && !turn.reply.meta?.error) ? (
              <div className="flex items-center gap-2 text-[13px]">
                <Spinner className="text-accent" />
                <span className="shimmer">Thinking…</span>
              </div>
            ) : (
              <div className="space-y-2.5 text-[14px]">
                {turn.reply.parts.map((p, j) =>
                  p.type === "text" ? (
                    <Markdown key={j} text={p.text} />
                  ) : p.type === "tool" ? (
                    <div key={j} className="space-y-2">
                      <ToolCard part={p} />
                      {p.ui && <ToolUi part={p} interactive={false} />}
                    </div>
                  ) : null,
                )}
                {turn.reply.meta?.error && <p className={cn("rounded-lg border border-err/30 bg-err/5 px-3 py-2 text-[13px] text-err")}>{turn.reply.meta.error}</p>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
