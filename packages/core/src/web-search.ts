import type { WebSearchConfig } from "./config.js";
import { WEB_SEARCH_PROVIDERS, resolveSecret } from "./config.js";

/**
 * Web search, built in: a `web_search` tool (results with titles, links and
 * snippets) and a `web_fetch` tool (a page as readable text). Turned on per
 * message from the chat input. DuckDuckGo needs no key; Brave, Tavily and a
 * SearXNG instance can be set in `webSearch` in moka.json.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export const WEB_SEARCH_LABELS: Record<WebSearchProvider, string> = {
  duckduckgo: "DuckDuckGo",
  brave: "Brave Search",
  tavily: "Tavily",
  searxng: "SearXNG",
};

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const TIMEOUT_MS = 15_000;
/** The most text web_fetch returns; the rest is cut with a note. */
export const FETCH_MAX_CHARS = 20_000;

type Fetch = typeof fetch;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const stripTags = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

/** DuckDuckGo wraps result links in a redirect (`//duckduckgo.com/l/?uddg=<url>`). */
function unwrapDuckLink(href: string): string {
  const decoded = decodeEntities(href);
  try {
    const url = new URL(decoded, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    if (target) return target;
    return url.href;
  } catch {
    return decoded;
  }
}

/** Results from DuckDuckGo's HTML page (html.duckduckgo.com). */
export function parseDuckDuckGo(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/(?=<div[^>]+class="[^"]*\bresult\b[^"]*")/i).slice(1);
  for (const block of blocks) {
    if (/^<div[^>]+class="[^"]*\bresult--ad\b/i.test(block)) continue;
    const link = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block) ?? /<a[^>]+href="([^"]+)"[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = unwrapDuckLink(link[1]!);
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const snippet = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(block);
    results.push({ title: stripTags(link[2]!), url, snippet: snippet ? stripTags(snippet[1]!) : "" });
    if (results.length >= max) break;
  }
  return results;
}

async function getJson(fetcher: Fetch, url: string, init: RequestInit, label: string): Promise<any> {
  const res = await fetcher(url, { ...init, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`${label} answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (check the API key)" : ""}${body ? `: ${body}` : ""}`);
  }
  return res.json();
}

export interface SearchOptions {
  config?: WebSearchConfig;
  env?: NodeJS.ProcessEnv;
  fetcher?: Fetch;
  signal?: AbortSignal;
}

export function searchProvider(config?: WebSearchConfig): WebSearchProvider {
  return config?.provider ?? "duckduckgo";
}

export async function webSearch(query: string, max: number, options: SearchOptions = {}): Promise<SearchResult[]> {
  const { config, env = process.env, fetcher = fetch } = options;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  const provider = searchProvider(config);
  const key = resolveSecret(config?.apiKey, env);
  const needsKey = (name: string) => {
    if (!key) throw new Error(`${name} needs an API key: set webSearch.apiKey in moka.json (or Settings → Config file → Web search).`);
    return key;
  };
  switch (provider) {
    case "brave": {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`;
      const data = await getJson(fetcher, url, { headers: { accept: "application/json", "x-subscription-token": needsKey("Brave Search") }, signal }, "Brave Search");
      return ((data?.web?.results ?? []) as any[]).slice(0, max).map((r) => ({ title: stripTags(r.title ?? ""), url: r.url, snippet: stripTags(r.description ?? "") }));
    }
    case "tavily": {
      const data = await getJson(
        fetcher,
        "https://api.tavily.com/search",
        { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${needsKey("Tavily")}` }, body: JSON.stringify({ query, max_results: max }), signal },
        "Tavily",
      );
      return ((data?.results ?? []) as any[]).slice(0, max).map((r) => ({ title: r.title ?? "", url: r.url, snippet: r.content ?? "" }));
    }
    case "searxng": {
      if (!config?.url) throw new Error("SearXNG needs the instance URL: set webSearch.url in moka.json (or Settings → Config file → Web search).");
      const base = config.url.replace(/\/+$/, "");
      const data = await getJson(fetcher, `${base}/search?q=${encodeURIComponent(query)}&format=json`, { headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, signal }, "SearXNG").catch((error: Error) => {
        throw new Error(/403/.test(error.message) ? `${error.message}. Turn on the JSON format in the instance's settings.yml (search.formats: [html, json]).` : error.message);
      });
      return ((data?.results ?? []) as any[]).slice(0, max).map((r) => ({ title: r.title ?? "", url: r.url, snippet: r.content ?? "" }));
    }
    default: {
      const res = await fetcher("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, accept: "text/html" },
        body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
        signal,
      });
      const html = await res.text();
      if (!res.ok || /anomaly-modal|challenge-form|Unfortunately, bots use DuckDuckGo too/i.test(html)) {
        throw new Error(
          `DuckDuckGo didn't return results (HTTP ${res.status}${res.ok ? ", it asked for a captcha" : ""}). It limits automated searches. Choose Brave Search, Tavily or SearXNG from the menu next to the Search button (or Settings → Config file → Web search).`,
        );
      }
      return parseDuckDuckGo(html, max);
    }
  }
}

export function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No results for "${query}". Try other words.`;
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
}

/** The readable text of an HTML page: title, then the body without scripts, styles and navigation. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html)?.[2] ?? /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  const text = decodeEntities(
    main
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n\n${"#".repeat(Number(n))} `)
      .replace(/<\/(p|div|section|h[1-6]|tr|table|ul|ol|pre|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

export async function webFetch(rawUrl: string, options: { fetcher?: Fetch; signal?: AbortSignal; maxChars?: number } = {}): Promise<string> {
  const { fetcher = fetch, maxChars = FETCH_MAX_CHARS } = options;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs can be fetched.");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetcher(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" }, redirect: "follow", signal });
  if (!res.ok) throw new Error(`${url.host} answered HTTP ${res.status}.`);
  const type = res.headers.get("content-type") ?? "";
  if (!/text|json|xml|javascript/i.test(type) && type) throw new Error(`${url.href} is ${type.split(";")[0]}, not a page Moka can read as text.`);
  const body = await res.text();
  const { title, text } = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body) ? htmlToText(body) : { title: "", text: body.trim() };
  const cut = text.length > maxChars;
  return `${title ? `# ${title}\n` : ""}${res.url || url.href}\n\n${cut ? text.slice(0, maxChars) : text}${cut ? `\n\n[Cut at ${maxChars.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters.]` : ""}`;
}

/** Told to the model when web search is on. */
export function webSearchSystemPrompt(today = new Date()): string {
  return `## Web search
You can search the web with web_search and read a page with web_fetch. Today is ${today.toISOString().slice(0, 10)}. Search when the answer depends on recent or specific facts, read the most relevant pages when snippets aren't enough, and cite the pages you used as Markdown links.`;
}
