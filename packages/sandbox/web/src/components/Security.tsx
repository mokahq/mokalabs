import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { SecurityFinding, ServerSecurity, ToolChange } from "../types";
import { Badge, Button, cn } from "./ui";

/** The security check of every connected server in the current workspace, by server id. */
export function useSecurity(): Map<string, ServerSecurity> {
  const workspaceId = useStore((s) => s.workspace().id);
  const config = useStore((s) => s.config);
  const mcpKey = useStore((s) =>
    Object.values(s.mcp)
      .map((m) => `${m.id}:${m.status}:${m.tools.length}`)
      .join("|"),
  );
  const version = useStore((s) => s.securityVersion);
  const [servers, setServers] = useState<Map<string, ServerSecurity>>(new Map());
  useEffect(() => {
    let cancelled = false;
    api<{ servers: ServerSecurity[] }>(`/api/security?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then(({ servers }) => !cancelled && setServers(new Map(servers.map((s) => [s.serverId, s]))))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, config, mcpKey, version]);
  return servers;
}

export function summary(report?: ServerSecurity): { level: "high" | "medium" | "info" | "ok"; text: string } {
  if (!report) return { level: "ok", text: "" };
  const high = report.findings.filter((f) => f.severity === "high").length;
  const medium = report.findings.filter((f) => f.severity === "medium").length;
  const changed = report.changes.filter((c) => c.kind === "changed").length;
  const parts = [high && `${high} high`, medium && `${medium} medium`, changed && `${changed} changed tool${changed === 1 ? "" : "s"}`].filter(Boolean) as string[];
  if (high || changed) return { level: "high", text: parts.join(", ") };
  if (medium) return { level: "medium", text: parts.join(", ") };
  if (report.findings.length || report.changes.length) return { level: "info", text: `${report.findings.length + report.changes.length} notes` };
  return { level: "ok", text: "No issues found" };
}

/** A shield next to a server in the sidebar when its security check found something. */
export function SecurityMark({ report }: { report?: ServerSecurity }) {
  const { level, text } = summary(report);
  if (level === "ok" || level === "info") return null;
  return (
    <span title={`Security check: ${text}`} className={cn("inline-flex", level === "high" ? "text-err" : "text-warn")}>
      <ShieldAlert className="h-3.5 w-3.5" />
    </span>
  );
}

const TONE = { high: "err", medium: "warn", info: "neutral" } as const;

function Finding({ finding }: { finding: SecurityFinding }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        <Badge tone={TONE[finding.severity]}>{finding.severity}</Badge>
        <span className="text-[13px] font-medium">{finding.title}</span>
        <span className="ml-auto truncate font-mono text-[11px] text-subtle">{finding.where}</span>
      </div>
      <p className="mt-1 text-[12px] text-muted">{finding.detail}</p>
      {finding.evidence && (
        <p className="mt-1.5 rounded-lg bg-panel-2/70 px-2.5 py-1.5 font-mono text-[11.5px] break-words text-muted">
          …{finding.evidence.before}
          <mark className={cn("rounded px-0.5", finding.severity === "high" ? "bg-err/20 text-err" : "bg-warn/20 text-warn")}>{finding.evidence.match}</mark>
          {finding.evidence.after}…
        </p>
      )}
    </div>
  );
}

function Change({ change }: { change: ToolChange }) {
  const since = change.since ? new Date(change.since).toLocaleDateString() : undefined;
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        <Badge tone={change.kind === "changed" ? "err" : "neutral"}>{change.kind}</Badge>
        <span className="font-mono text-[12.5px] font-medium">{change.tool}</span>
        {since && change.kind !== "added" && <span className="ml-auto text-[11px] text-subtle">trusted since {since}</span>}
      </div>
      {change.kind === "changed" && (
        <div className="mt-2 grid grid-cols-2 gap-2 text-[11.5px]">
          <div>
            <div className="mb-0.5 text-[10.5px] font-medium tracking-wide text-subtle uppercase">Before</div>
            <pre className="max-h-40 overflow-auto rounded-lg bg-panel-2/70 p-2 font-mono whitespace-pre-wrap text-muted">{change.before?.description || "(no description)"}</pre>
          </div>
          <div>
            <div className="mb-0.5 text-[10.5px] font-medium tracking-wide text-subtle uppercase">Now</div>
            <pre className="max-h-40 overflow-auto rounded-lg bg-err/5 p-2 font-mono whitespace-pre-wrap">{change.after?.description || "(no description)"}</pre>
          </div>
          {change.before?.schema !== change.after?.schema && <p className="col-span-2 text-subtle">Its input schema changed too.</p>}
        </div>
      )}
    </div>
  );
}

/** Settings → MCP servers: what the security check found for this server, and trusting changed tools. */
export function SecuritySection({ serverId }: { serverId: string }) {
  const report = useSecurity().get(serverId);
  const bump = useStore((s) => s.bumpSecurity);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  if (!report) return null;
  const { level, text } = summary(report);
  const trust = async () => {
    setBusy(true);
    try {
      await api(`/api/security/${encodeURIComponent(serverId)}/trust`, { body: {} });
      bump();
      toast("Trusted the current tools", "success");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <div className={cn("flex items-center gap-2 text-[13px]", level === "high" ? "text-err" : level === "medium" ? "text-warn" : "text-ok")}>
        {level === "ok" ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
        <span className="font-medium">{text}</span>
      </div>
      {(report.findings.length > 0 || report.changes.length > 0) && (
        <div className="divide-y divide-line rounded-xl border border-line">
          {report.changes.map((c) => (
            <Change key={`${c.kind}:${c.tool}`} change={c} />
          ))}
          {report.findings.map((f, i) => (
            <Finding key={i} finding={f} />
          ))}
        </div>
      )}
      {report.changes.length > 0 && (
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void trust()}>
            Trust the current tools
          </Button>
          <span className="text-[12px] text-muted">Only if you expected these changes, e.g. after updating the server.</span>
        </div>
      )}
      <p className="text-[11.5px] text-subtle">
        Checks what the model reads: tool and parameter descriptions, server instructions and prompts. It looks for hidden instructions, invisible characters, requests for secrets, tools shadowing other servers' tools, and tools that changed since you first connected. It's a heuristic: a clean result isn't a guarantee.
      </p>
    </div>
  );
}
