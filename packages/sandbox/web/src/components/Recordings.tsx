import { Circle, Play, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { RecordingFile } from "../types";
import { Button, IconButton } from "./ui";

/** Add a recording (or a proxy session log) as a server that answers from it, and connect it in this workspace. */
export function useReplay() {
  return useCallback(async (file: string, name: string) => {
    const { config, workspace, saveConfig, toast } = useStore.getState();
    const ws = workspace();
    const base = `mock-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "server"}`;
    let id = base;
    for (let n = 2; config.mcpServers.some((s) => s.id === id); n++) id = `${base}-${n}`;
    const ok = await saveConfig(
      {
        ...config,
        mcpServers: [...config.mcpServers, { id, name: `${name} (replay)`, transport: "stdio", command: "moka:mock", args: [file] }],
        workspaces: config.workspaces.map((w) => (w.id === ws.id ? { ...w, mcpServerIds: [...w.mcpServerIds, id] } : w)),
      },
      `Added "${name} (replay)": it answers from the recording, in ${ws.name}`,
    );
    if (ok) void useStore.getState().connectServer(id);
    else toast("Couldn't add the replay server", "error");
  }, []);
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Recordings written by servers with Record on (Settings → MCP), newest first. */
export function Recordings() {
  const [list, setList] = useState<RecordingFile[]>([]);
  const config = useStore((s) => s.config);
  const replay = useReplay();
  const load = useCallback(() => api<{ recordings: RecordingFile[] }>("/api/recordings").then((r) => setList(r.recordings)).catch(() => {}), []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  const recording = config.mcpServers.filter((s) => s.record);
  if (!list.length && !recording.length) return null;
  const name = (server: string) => config.mcpServers.find((s) => s.id === server)?.name ?? server;
  return (
    <div className="mt-2">
      <div className="px-1 pb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">Moka recordings</div>
      {recording.map((s) => (
        <div key={s.id} className="flex items-center gap-2 px-2 py-1 text-[12px] text-err">
          <Circle className="h-2 w-2 shrink-0 fill-err" /> recording {s.name}
        </div>
      ))}
      {list.slice(0, 20).map((r) => (
        <div key={r.file} className="group flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-panel-2">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[12px]">{name(r.server)}</div>
            <div className="text-[11px] text-subtle">
              {new Date(r.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {size(r.size)}
            </div>
          </div>
          <Button size="xs" variant="ghost" icon={<Play className="h-3 w-3" />} onClick={() => void replay(r.file, name(r.server))} title="Add as a server that answers from this recording">
            Replay
          </Button>
          <IconButton label="Delete recording" className="h-6 w-6 opacity-0 group-hover:opacity-100" onClick={() => void api(`/api/recordings?file=${encodeURIComponent(r.file)}`, { method: "DELETE" }).then(load)}>
            <Trash2 className="h-3 w-3" />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
