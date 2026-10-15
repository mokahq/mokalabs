import { AlertTriangle, Gauge } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { BudgetItem, ContextBudget } from "../types";
import { Badge, Modal, Switch, cn, formatNumber } from "./ui";

/** Context sizes people commonly run local models with, to put the total in perspective. */
const LOCAL_CONTEXT = 8192;
/** Past this many tools, models pick the right one less reliably. */
const MANY_TOOLS = 40;

/** The current workspace's context budget, refreshed when servers connect or the config changes. */
export function useBudget(): ContextBudget | undefined {
  const workspaceId = useStore((s) => s.workspace().id);
  const config = useStore((s) => s.config);
  // Only re-fetch when a server's status or tool list changes, not on every MCP event.
  const mcpKey = useStore((s) =>
    Object.values(s.mcp)
      .map((m) => `${m.id}:${m.status}:${m.tools.length}`)
      .join("|"),
  );
  const [budget, setBudget] = useState<ContextBudget>();
  useEffect(() => {
    let cancelled = false;
    api<ContextBudget>(`/api/budget?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((b) => !cancelled && setBudget(b))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, config, mcpKey]);
  return budget;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** The badge on the empty chat: tools, servers and what they cost per request. */
export function BudgetBadge({ toolCount, servers }: { toolCount: number; servers: number }) {
  const budget = useBudget();
  const set = useStore((s) => s.set);
  const heavy = budget && (budget.total > LOCAL_CONTEXT / 2 || toolCount > MANY_TOOLS);
  return (
    <button onClick={() => set({ budgetOpen: true })} title="What the model reads before every message">
      <Badge tone={heavy ? "warn" : "info"}>
        {heavy ? <AlertTriangle className="h-3 w-3" /> : <Gauge className="h-3 w-3" />} {toolCount} tools · {servers} servers
        {budget ? ` · ≈${formatTokens(budget.total)} tokens` : ""}
      </Badge>
    </button>
  );
}

/**
 * Where the tokens go before the first message: system prompt, skills, server
 * instructions and every tool definition, biggest first, with a switch to hide
 * a tool from the model.
 */
export function BudgetDialog() {
  const open = useStore((s) => s.budgetOpen);
  const set = useStore((s) => s.set);
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const openSettings = useStore((s) => s.openSettings);
  const workspace = useStore((s) => s.workspace());
  const budget = useBudget();

  const groups = useMemo(() => {
    const map = new Map<string, { source: string; tokens: number; items: BudgetItem[] }>();
    for (const item of budget?.items ?? []) {
      const g = map.get(item.source) ?? { source: item.source, tokens: 0, items: [] };
      g.items.push(item);
      if (!item.hidden) g.tokens += item.tokens;
      map.set(item.source, g);
    }
    for (const g of map.values()) g.items.sort((a, b) => b.tokens - a.tokens);
    return [...map.values()].sort((a, b) => b.tokens - a.tokens);
  }, [budget]);

  const toggle = async (item: BudgetItem, visible: boolean) => {
    if (!item.serverId) return;
    await saveConfig({
      ...config,
      mcpServers: config.mcpServers.map((s) => {
        if (s.id !== item.serverId) return s;
        const hidden = new Set(s.disabledTools ?? []);
        if (visible) hidden.delete(item.name);
        else hidden.add(item.name);
        return { ...s, disabledTools: hidden.size ? [...hidden] : undefined };
      }),
    });
  };

  const tools = budget?.items.filter((i) => i.kind === "tool" && !i.hidden).length ?? 0;
  const max = Math.max(1, ...(budget?.items.map((i) => i.tokens) ?? [1]));
  const share = budget ? Math.round((budget.total / LOCAL_CONTEXT) * 100) : 0;

  return (
    <Modal open={open} onClose={() => set({ budgetOpen: false })} className="max-w-2xl" title="Context budget" description={`What the model reads in ${workspace.name} before every message`}>
      <div className="min-h-0 overflow-y-auto px-5 py-4">
        {!budget ? (
          <p className="text-[13px] text-muted">Measuring…</p>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight">≈{formatNumber(budget.total)}</span>
              <span className="text-[13px] text-muted">tokens per request, from {tools} tools and the system prompt</span>
            </div>
            <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-panel-2">
              {groups.map((g, i) => (
                <div key={g.source} title={`${g.source}: ≈${formatNumber(g.tokens)} tokens`} className={cn("h-full", BAR_COLORS[i % BAR_COLORS.length])} style={{ width: `${(g.tokens / Math.max(1, budget.total)) * 100}%` }} />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted">
              {groups.map((g, i) => (
                <span key={g.source} className="inline-flex items-center gap-1">
                  <span className={cn("h-2 w-2 rounded-full", BAR_COLORS[i % BAR_COLORS.length])} /> {g.source} ≈{formatTokens(g.tokens)}
                </span>
              ))}
            </div>

            {(budget.total > LOCAL_CONTEXT / 2 || tools > MANY_TOOLS) && (
              <div className="mt-4 flex gap-2 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2.5 text-[12.5px]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                <div>
                  {budget.total > LOCAL_CONTEXT / 2 && (
                    <p>
                      That's {share}% of an 8K context window, before the conversation starts. Local models are often run with 8K–32K.
                    </p>
                  )}
                  {tools > MANY_TOOLS && <p>{tools} tools: models choose the right tool less reliably past about {MANY_TOOLS}.</p>}
                  <p className="mt-1 text-muted">Hide the tools this workspace doesn't need. Hidden tools still work in the Tools view.</p>
                </div>
              </div>
            )}

            <div className="mt-4 space-y-4">
              {groups.map((g) => (
                <div key={g.source}>
                  <div className="mb-1 flex items-center text-[11px] font-medium tracking-wide text-subtle uppercase">
                    <span className="flex-1">{g.source}</span>
                    <span className="font-mono normal-case">≈{formatNumber(g.tokens)}</span>
                  </div>
                  <div className="divide-y divide-line rounded-xl border border-line">
                    {g.items.map((item) => (
                      <div key={`${item.kind}:${item.name}`} className={cn("flex items-center gap-3 px-3 py-1.5", item.hidden && "opacity-50")}>
                        <span className={cn("w-44 shrink-0 truncate text-[12.5px]", item.kind === "tool" && "font-mono")} title={item.name}>
                          {item.name}
                        </span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-2">
                          <div className="h-full rounded-full bg-accent/70" style={{ width: `${(item.tokens / max) * 100}%` }} />
                        </div>
                        <span className="w-14 shrink-0 text-right font-mono text-[11.5px] text-muted">{formatTokens(item.tokens)}</span>
                        <span className="w-9 shrink-0">
                          {item.kind === "tool" && item.serverId ? (
                            <Switch checked={!item.hidden} onChange={(v) => void toggle(item, v)} label={`Show ${item.name} to the model`} />
                          ) : item.source === "generative UI" ? (
                            <button className="text-[11px] text-subtle hover:text-fg" title="Generative UI is a workspace setting" onClick={() => (set({ budgetOpen: false }), openSettings("workspaces"))}>
                              Edit
                            </button>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {budget.notConnected.length > 0 && <p className="mt-4 text-[12px] text-muted">Not counted (not connected): {budget.notConnected.map((s) => s.name).join(", ")}.</p>}
            <p className="mt-4 text-[11.5px] text-subtle">
              Estimated at about 4 characters per token; each model's tokenizer counts a little differently. The inspector shows the exact input tokens of each step.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

const BAR_COLORS = ["bg-accent", "bg-info", "bg-violet", "bg-ok", "bg-warn", "bg-err"];
