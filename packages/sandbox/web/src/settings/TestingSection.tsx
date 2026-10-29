import { Circle, Plus, Trash2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Input, Select, Switch, cn } from "../components/ui";
import { useStore } from "../store";
import type { FaultKind, FaultRule, Faults, McpServerConfig } from "../types";

const FAILS: Record<FaultKind | "", string> = {
  "": "No failure (delay only)",
  error: "JSON-RPC error",
  "tool-error": "Tool error (isError)",
  hang: "No reply (times out)",
  crash: "Connection closes",
  malformed: "Malformed result",
};

const delayText = (d: FaultRule["delayMs"]) => (d === undefined ? "" : Array.isArray(d) ? `${d[0]}-${d[1]}` : String(d));
function parseDelay(text: string): FaultRule["delayMs"] {
  const [a, b] = text.split(/\s*[-–]\s*/).map((n) => Number(n));
  if (!text.trim() || !Number.isFinite(a)) return undefined;
  return b !== undefined && Number.isFinite(b) ? [Math.min(a!, b), Math.max(a!, b)] : a;
}

/**
 * Record & faults for one server: write its traffic to a recording (replay it
 * later with moka:mock), and inject delays and failures into tool calls.
 * Both apply right away, without reconnecting.
 */
export function TestingSection({ server, tools }: { server: McpServerConfig; tools: string[] }) {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const [draft, setDraft] = useState<Faults>(server.faults ?? { rules: [] });
  useEffect(() => setDraft(server.faults ?? { rules: [] }), [JSON.stringify(server.faults ?? null)]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(server.faults ?? { rules: [] });

  const update = (patch: Partial<McpServerConfig>, message: string) =>
    saveConfig({ ...config, mcpServers: config.mcpServers.map((s) => (s.id === server.id ? { ...s, ...patch } : s)) }, message);
  const rule = (i: number, patch: Partial<FaultRule>) => setDraft((d) => ({ ...d, rules: d.rules.map((r, j) => (j === i ? clean({ ...r, ...patch }) : r)) }));
  const clean = (r: FaultRule): FaultRule => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) as FaultRule;
  const active = server.faults && server.faults.enabled !== false && server.faults.rules.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-xl border border-line px-4 py-3">
        <Circle className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", server.record ? "fill-err text-err" : "text-subtle")} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Record traffic</div>
          <p className="text-[12px] text-muted">
            Every message to and from this server goes to <code className="font-mono">~/.moka/recordings/{server.id}/</code>. Replay a recording as a server in the Proxy view, or anywhere with{" "}
            <code className="font-mono">npx @mokalabs/sandbox mock file.jsonl</code>. Headers and env aren't written; arguments and results are.
          </p>
        </div>
        <Switch checked={!!server.record} onChange={(on) => void update({ record: on || undefined }, on ? "Recording this server" : "Recording stopped")} label="Record traffic" />
      </div>

      <div className="rounded-xl border border-line">
        <div className="flex items-start gap-3 px-4 py-3">
          <Zap className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", active ? "text-warn" : "text-subtle")} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Fault injection</div>
            <p className="text-[12px] text-muted">Slow down or break tool calls on purpose, to see how models cope. Injected faults are marked ⚡ in the inspector.</p>
          </div>
          {draft.rules.length > 0 && <Switch checked={draft.enabled !== false} onChange={(on) => setDraft((d) => ({ ...d, enabled: on ? undefined : false }))} label="Faults on" />}
        </div>
        {draft.rules.length > 0 && (
          <div className="space-y-2 border-t border-line px-4 py-3">
            {draft.rules.map((r, i) => (
              <div key={i} className="grid items-center gap-2 sm:grid-cols-[1.4fr_0.7fr_0.9fr_1.3fr_auto]">
                <Select value={r.tools?.[0] ?? ""} onChange={(e) => rule(i, { tools: e.target.value ? [e.target.value] : undefined })} className="h-8 text-[12.5px]" aria-label="Tool">
                  <option value="">Every tool</option>
                  {[...new Set([...tools, ...(r.tools ?? [])])].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
                <label className="flex items-center gap-1 text-[12px] text-muted">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={r.rate === undefined ? 100 : Math.round(r.rate * 100)}
                    onChange={(e) => rule(i, { rate: e.target.value === "" || Number(e.target.value) >= 100 ? undefined : Math.max(0, Number(e.target.value)) / 100 })}
                    className="h-8 text-[12.5px]"
                    aria-label="Share of calls (%)"
                  />
                  %
                </label>
                <Input defaultValue={delayText(r.delayMs)} onBlur={(e) => rule(i, { delayMs: parseDelay(e.target.value) })} placeholder="delay ms, e.g. 500-3000" className="h-8 text-[12.5px]" aria-label="Delay (ms)" />
                <Select value={r.fail ?? ""} onChange={(e) => rule(i, { fail: (e.target.value || undefined) as FaultKind | undefined })} className="h-8 text-[12.5px]" aria-label="Failure">
                  {(Object.keys(FAILS) as Array<FaultKind | "">).map((k) => (
                    <option key={k} value={k}>
                      {FAILS[k]}
                    </option>
                  ))}
                </Select>
                <Button size="xs" variant="ghost" icon={<Trash2 className="h-3 w-3" />} onClick={() => setDraft((d) => ({ ...d, rules: d.rules.filter((_, j) => j !== i) }))} aria-label="Remove rule" />
              </div>
            ))}
            <label className="flex items-center gap-2 pt-1 text-[12px] text-muted">
              Seed
              <Input
                type="number"
                value={draft.seed ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, seed: e.target.value === "" ? undefined : Math.round(Number(e.target.value)) }))}
                placeholder="random"
                className="h-7 w-28 text-[12px]"
              />
              <span className="text-subtle">Same seed, same faults every run.</span>
            </label>
          </div>
        )}
        <div className="flex gap-2 border-t border-line px-4 py-2.5">
          <Button size="xs" variant="ghost" icon={<Plus className="h-3 w-3" />} onClick={() => setDraft((d) => ({ ...d, rules: [...d.rules, { rate: 0.3, fail: "error" }] }))}>
            Add rule
          </Button>
          <span className="flex-1" />
          {dirty && (
            <Button size="xs" variant="primary" onClick={() => void update({ faults: draft.rules.length ? draft : undefined }, draft.rules.length ? "Faults saved; they apply to the next calls" : "Faults removed")}>
              Save faults
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
