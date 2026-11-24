import { Download, FileJson, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Button, Field, Input, Select, Switch, cn } from "../components/ui";
import { CodeEditor } from "../components/Code";
import { useStore } from "../store";
import type { MokaConfig, WebSearchConfig, WebSearchProvider } from "../types";
import { Section } from "./Settings";
import { SEARCH_PROVIDERS } from "../components/SearchControl";

export function ConfigSettings() {
  const config = useStore((s) => s.config);
  const branded = config.ui?.branding !== false;
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
        <CodeEditor lang="json" rows={26} value={text} onChange={setText} ariaLabel="moka.json" />
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
      <Section title="Preferences">
        <label className="mb-4 flex items-center justify-between gap-4 text-[13px]">
          <span>
            <span className="font-medium">Moka branding</span>
            <span className="block text-muted">
              The puppy, the Moka name in the header, chat and tab title, and the star link. Turn it off for a neutral chat when you demo your own product.
            </span>
          </span>
          <Switch
            checked={branded}
            onChange={(on) => saveConfig({ ...config, ui: { ...config.ui, branding: on } }, on ? "Moka branding on" : "Moka branding off")}
            label="Moka branding"
          />
        </label>
        <label className={cn("mb-4 flex items-center justify-between gap-4 text-[13px]", !branded && "opacity-50")}>
          <span>
            <span className="font-medium">Animate Moka</span>
            <span className="block text-muted">The puppy on the empty chat watches your cursor, and wags when petted.</span>
          </span>
          <Switch
            disabled={!branded}
            checked={config.ui?.animations !== false}
            onChange={(on) => saveConfig({ ...config, ui: { ...config.ui, animations: on } }, on ? "Moka animations on" : "Moka animations off")}
            label="Animate Moka"
          />
        </label>
        <label className={cn("flex items-center justify-between gap-4 text-[13px]", !branded && "opacity-50")}>
          <span>
            <span className="font-medium">Show the "Star it on GitHub" line</span>
            <span className="block text-muted">On the empty chat screen and in the terminal when Moka starts.</span>
          </span>
          <Switch
            disabled={!branded}
            checked={config.ui?.starLink !== false}
            onChange={(on) => saveConfig({ ...config, ui: { ...config.ui, starLink: on } }, on ? "Star link shown" : "Star link hidden")}
            label="Show the star link"
          />
        </label>
      </Section>
      <WebSearchSettings />
    </div>
  );
}

const PROVIDERS = SEARCH_PROVIDERS;

/** The provider behind the Search button in the chat input. */
function WebSearchSettings() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const current: WebSearchConfig = config.webSearch ?? {};
  const [draft, setDraft] = useState<WebSearchConfig>(current);
  useEffect(() => setDraft(config.webSearch ?? {}), [config.webSearch]);
  const provider = draft.provider ?? "duckduckgo";
  const info = PROVIDERS.find((p) => p.id === provider)!;
  const clean = (c: WebSearchConfig): WebSearchConfig | undefined => {
    const out: WebSearchConfig = {
      ...(c.provider ? { provider: c.provider } : {}),
      ...(c.apiKey?.trim() && (c.provider === "brave" || c.provider === "tavily" || c.provider === "searxng") ? { apiKey: c.apiKey.trim() } : {}),
      ...(c.url?.trim() && c.provider === "searxng" ? { url: c.url.trim() } : {}),
      ...(c.maxResults ? { maxResults: c.maxResults } : {}),
    };
    return Object.keys(out).length ? out : undefined;
  };
  const dirty = JSON.stringify(clean(draft) ?? {}) !== JSON.stringify(clean(current) ?? {});
  const missing = (provider === "brave" || provider === "tavily") && !draft.apiKey?.trim() ? "Needs an API key" : provider === "searxng" && !draft.url?.trim() ? "Needs the instance URL" : undefined;
  return (
    <Section title="Web search" description="What the Search button in the chat input uses. With it on, the model gets web_search (results with links) and web_fetch (a page as text).">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Provider" hint={info.hint}>
          <Select value={provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value as WebSearchProvider })} aria-label="Search provider">
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Results per search" hint="Default 5. More results cost more context.">
          <Input type="number" min={1} max={20} value={draft.maxResults ?? ""} placeholder="5" onChange={(e) => setDraft({ ...draft, maxResults: e.target.value ? Math.min(20, Math.max(1, Number(e.target.value))) : undefined })} />
        </Field>
        {provider === "searxng" && (
          <Field label="Instance URL">
            <Input mono value={draft.url ?? ""} placeholder="http://localhost:8080" onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
          </Field>
        )}
        {provider !== "duckduckgo" && (
          <Field label={provider === "searxng" ? "API key (optional)" : "API key"} hint="Or env:VAR_NAME to read it from the environment, so moka.json is safe to commit.">
            <Input mono type="password" autoComplete="off" value={draft.apiKey ?? ""} placeholder={provider === "brave" ? "env:BRAVE_API_KEY" : provider === "tavily" ? "env:TAVILY_API_KEY" : ""} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
          </Field>
        )}
      </div>
      <div className="mt-3 flex items-center gap-2">
        {missing && <span className="text-[12px] text-warn">{missing}</span>}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft(current)}>
          Revert
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty || Boolean(missing)}
          onClick={() => {
            const { webSearch: _old, ...rest } = config;
            const next = clean(draft);
            void saveConfig(next ? { ...rest, webSearch: next } : rest, `Web search: ${PROVIDERS.find((p) => p.id === (next?.provider ?? "duckduckgo"))!.label}`);
          }}
        >
          Save
        </Button>
      </div>
    </Section>
  );
}
