import { Download, FileJson, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Button, Textarea } from "../components/ui";
import { useStore } from "../store";
import type { MokaConfig } from "../types";
import { Section } from "./Settings";

export function ConfigSettings() {
  const config = useStore((s) => s.config);
  const configPath = useStore((s) => s.configPath);
  const saveConfig = useStore((s) => s.saveConfig);
  const [text, setText] = useState(() => JSON.stringify(config, null, 2));
  const [error, setError] = useState<string>();
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => setText(JSON.stringify(config, null, 2)), [config]);
  const dirty = text !== JSON.stringify(config, null, 2);

  const apply = async (raw: string) => {
    let parsed: MokaConfig;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      setError(`Invalid JSON: ${e?.message}`);
      return;
    }
    setError(undefined);
    const { $schema: _s, ...rest } = parsed as any;
    await saveConfig(rest, "Config saved");
  };

  const download = async (redact: boolean) => {
    const data = await api(`/api/config/export?redact=${redact ? 1 : 0}`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "moka.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="h-full overflow-y-auto">
      <Section
        title="Config file"
        description={
          <>
            Stored at <code className="font-mono text-[12px] text-fg">{configPath}</code>. Commit a <code className="font-mono">moka.json</code> to a repo and run{" "}
            <code className="font-mono">npx @mokalabs/sandbox</code> in that folder to share a ready-to-go demo.
          </>
        }
        right={
          <div className="flex gap-1.5">
            <input
              ref={file}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const raw = await f.text();
                setText(raw);
                e.target.value = "";
              }}
            />
            <Button size="xs" variant="outline" icon={<Upload className="h-3 w-3" />} onClick={() => file.current?.click()}>
              Load file
            </Button>
            <Button size="xs" variant="outline" icon={<Download className="h-3 w-3" />} onClick={() => download(true)}>
              Download (keys redacted)
            </Button>
          </div>
        }
      >
        <Textarea mono rows={26} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} className="text-[12px]" />
        {error && <p className="mt-2 text-[12.5px] text-err">{error}</p>}
        <div className="mt-3 flex items-center gap-2">
          <FileJson className="h-4 w-4 text-subtle" />
          <span className="text-[12px] text-muted">Tip: use env:VAR_NAME for secrets so the file is safe to commit.</span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setText(JSON.stringify(config, null, 2))}>
            Revert
          </Button>
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => apply(text)}>
            Validate & save
          </Button>
        </div>
      </Section>
    </div>
  );
}
