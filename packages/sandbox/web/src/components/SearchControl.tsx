import { Check, ChevronDown, Globe } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { WebSearchConfig, WebSearchProvider } from "../types";
import { Button, Input, cn } from "./ui";

export const SEARCH_PROVIDERS: Array<{ id: WebSearchProvider; label: string; short: string; hint: string; needs?: "key" | "url" }> = [
  { id: "searxng", label: "SearXNG", short: "Local, free, no key", hint: "Your own instance, with the JSON format turned on (search.formats: [html, json]).", needs: "url" },
  { id: "tavily", label: "Tavily", short: "Free tier, needs a key", hint: "A key from app.tavily.com. Search made for agents.", needs: "key" },
  { id: "brave", label: "Brave Search", short: "Needs a key", hint: "A key from the Brave Search API dashboard.", needs: "key" },
  { id: "duckduckgo", label: "DuckDuckGo", short: "No key, but often blocks scripts", hint: "DuckDuckGo has no API and asks automated searches for a captcha, so it may not work from your machine." },
];

export const providerLabel = (id: WebSearchProvider | undefined) => SEARCH_PROVIDERS.find((p) => p.id === (id ?? "duckduckgo"))!.label;

/** A provider's settings are complete. */
export function providerReady(config: WebSearchConfig | undefined): boolean {
  const provider = SEARCH_PROVIDERS.find((p) => p.id === (config?.provider ?? "duckduckgo"))!;
  return provider.needs === "key" ? Boolean(config?.apiKey?.trim()) : provider.needs === "url" ? Boolean(config?.url?.trim()) : true;
}

/**
 * The Search button in the chat input, with its provider menu. Turning it on
 * the first time asks which provider to search with.
 */
export function SearchControl({ open, setOpen, disabled }: { open: boolean; setOpen: (open: boolean) => void; disabled?: boolean }) {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const on = useStore((s) => s.webSearch);
  const setOn = useStore((s) => s.setWebSearch);
  const chosen = config.webSearch?.provider;
  const [pick, setPick] = useState<WebSearchProvider>(chosen ?? "searxng");
  const [key, setKey] = useState(config.webSearch?.apiKey ?? "");
  const [url, setUrl] = useState(config.webSearch?.url ?? "http://localhost:8080");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setPick(chosen ?? "searxng");
    setKey(config.webSearch?.apiKey ?? "");
    setUrl(config.webSearch?.url ?? "http://localhost:8080");
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
    // Reset the form each time the menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const provider = SEARCH_PROVIDERS.find((p) => p.id === pick)!;
  const missing = provider.needs === "key" ? !key.trim() : provider.needs === "url" ? !url.trim() : false;
  const save = async () => {
    // A SearXNG instance can have a key too (set in Settings); keep it.
    const apiKey = provider.needs === "key" ? key.trim() : pick === "searxng" && config.webSearch?.provider === "searxng" ? config.webSearch.apiKey : undefined;
    const next: WebSearchConfig = {
      provider: pick,
      ...(apiKey ? { apiKey } : {}),
      ...(pick === "searxng" ? { url: url.trim() } : {}),
      ...(config.webSearch?.maxResults ? { maxResults: config.webSearch.maxResults } : {}),
    };
    if (await saveConfig({ ...config, webSearch: next }, `Web search: ${provider.label}`)) {
      setOn(true);
      setOpen(false);
    }
  };

  return (
    <div ref={box} className="relative flex items-center">
      <button
        type="button"
        aria-pressed={on}
        disabled={disabled}
        title={on ? `Web search on (${providerLabel(chosen)}): the model can search and read pages. Click to turn off.` : chosen ? `Let the model search the web (${providerLabel(chosen)})` : "Let the model search the web"}
        onClick={() => {
          // The first time, choose a provider before searching.
          if (!on && !chosen) setOpen(true);
          else setOn(!on);
        }}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-l-full border border-r-0 pr-1.5 pl-2.5 text-[12px] font-medium transition-colors disabled:opacity-40",
          on ? "border-accent/40 bg-accent-soft text-accent" : "border-transparent text-muted hover:bg-panel-2 hover:text-fg",
        )}
      >
        <Globe className="h-3.5 w-3.5" />
        Search
      </button>
      <button
        type="button"
        aria-label="Choose the search provider"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className={cn(
          "inline-flex h-7 items-center rounded-r-full border border-l-0 pr-2 pl-0.5 transition-colors disabled:opacity-40",
          on ? "border-accent/40 bg-accent-soft text-accent" : "border-transparent text-subtle hover:bg-panel-2 hover:text-fg",
          open && "bg-panel-2 text-fg",
        )}
      >
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div role="dialog" aria-label="Search provider" className="absolute bottom-full left-0 z-30 mb-2 w-80 rounded-xl border border-line bg-elev p-1 shadow-soft">
          <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-subtle uppercase">Search the web with</div>
          {SEARCH_PROVIDERS.map((p) => (
            <button key={p.id} role="radio" aria-checked={p.id === pick} onClick={() => setPick(p.id)} className={cn("flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-panel-2", p.id === pick && "bg-panel-2")}>
              <Check className={cn("mt-0.5 h-3.5 w-3.5 shrink-0 text-accent", p.id !== chosen && "invisible")} />
              <span className="min-w-0">
                <span className="block text-[13px]">{p.label}</span>
                <span className={cn("block text-[11.5px]", p.id === "duckduckgo" ? "text-warn" : "text-muted")}>{p.short}</span>
              </span>
            </button>
          ))}
          <div className="mt-1 space-y-2 border-t border-line px-2.5 pt-2 pb-1.5">
            <p className="text-[11.5px] text-muted">{provider.hint}</p>
            {provider.needs === "url" && <Input mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:8080" aria-label="SearXNG URL" className="h-8" />}
            {provider.needs === "key" && (
              <Input mono type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={pick === "tavily" ? "tvly-… or env:TAVILY_API_KEY" : "Key or env:BRAVE_API_KEY"} aria-label={`${provider.label} API key`} className="h-8" />
            )}
            {pick === "searxng" && (
              <p className="text-[11px] text-subtle">
                No instance yet? <code className="font-mono">docker run -p 8080:8080 searxng/searxng</code>, then turn on JSON in its settings.yml.
              </p>
            )}
            <div className="flex justify-end">
              <Button size="sm" variant="primary" disabled={missing} onClick={() => void save()}>
                {chosen === pick && on ? "Save" : "Use " + provider.label}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
