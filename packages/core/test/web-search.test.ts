import { describe, expect, it } from "vitest";
import { formatResults, htmlToText, parseConfig, parseDuckDuckGo, redactConfig, webFetch, webSearch } from "../src/index.js";

// The shape of html.duckduckgo.com's results page: an ad, then organic results whose links go through a redirect.
const DDG = `<!DOCTYPE html><html><body><div id="links" class="results">
<div class="result results_links results_links_deep result--ad ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=x">Buy MCP now</a></h2>
    <a class="result__snippet" href="https://duckduckgo.com/y.js?x">Sponsored</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmodelcontextprotocol.io%2Fintroduction&amp;rut=abc123">Introduction - <b>Model Context Protocol</b></a>
    </h2>
    <div class="result__extras"><div class="result__extras__url"><a class="result__url" href="//duckduckgo.com/l/?uddg=x">modelcontextprotocol.io</a></div></div>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The <b>Model Context Protocol</b> (MCP) is an open protocol that standardizes how applications provide context to LLMs &amp; agents.</a>
    <div class="clear"></div>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fmodelcontextprotocol&amp;rut=def">Model Context Protocol &#183; GitHub</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">SDKs and servers for MCP.</a>
  </div>
</div>
</div></body></html>`;

/** A fetch that answers from a map of URL prefix → response, and records requests. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof URL ? input.href : input);
    calls.push({ url, ...(init ? { init } : {}) });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const res = routes[key]!();
    Object.defineProperty(res, "url", { value: url });
    return res;
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("web search", () => {
  it("reads DuckDuckGo results, skipping ads and unwrapping redirect links", () => {
    const results = parseDuckDuckGo(DDG, 5);
    expect(results).toEqual([
      {
        title: "Introduction - Model Context Protocol",
        url: "https://modelcontextprotocol.io/introduction",
        snippet: "The Model Context Protocol (MCP) is an open protocol that standardizes how applications provide context to LLMs & agents.",
      },
      { title: "Model Context Protocol · GitHub", url: "https://github.com/modelcontextprotocol", snippet: "SDKs and servers for MCP." },
    ]);
    expect(parseDuckDuckGo(DDG, 1)).toHaveLength(1);
  });

  it("searches DuckDuckGo with no key, and explains a captcha", async () => {
    const ok = fakeFetch({ "https://html.duckduckgo.com/html/": () => new Response(DDG, { headers: { "content-type": "text/html" } }) });
    const results = await webSearch("model context protocol", 5, { fetcher: ok.fetcher });
    expect(results[0]!.url).toBe("https://modelcontextprotocol.io/introduction");
    expect(String(ok.calls[0]!.init?.body)).toContain("q=model+context+protocol");

    const blocked = fakeFetch({ "https://html.duckduckgo.com/html/": () => new Response('<div class="anomaly-modal">bots</div>', { status: 202 }) });
    await expect(webSearch("x", 5, { fetcher: blocked.fetcher })).rejects.toThrow(/limits automated searches.*Brave Search, Tavily or SearXNG/);
  });

  it("uses Brave, Tavily and SearXNG with their keys", async () => {
    const { fetcher, calls } = fakeFetch({
      "https://api.search.brave.com/": () => Response.json({ web: { results: [{ title: "Brave <strong>hit</strong>", url: "https://a.example", description: "from <strong>Brave</strong>" }] } }),
      "https://api.tavily.com/search": () => Response.json({ results: [{ title: "Tavily hit", url: "https://b.example", content: "from Tavily" }] }),
      "http://searx.local/search": () => Response.json({ results: [{ title: "Searx hit", url: "https://c.example", content: "from SearXNG" }] }),
    });
    const env = { BRAVE: "brave-key" };
    expect(await webSearch("q", 3, { fetcher, env, config: { provider: "brave", apiKey: "env:BRAVE" } })).toEqual([{ title: "Brave hit", url: "https://a.example", snippet: "from Brave" }]);
    expect(new Headers(calls[0]!.init?.headers).get("x-subscription-token")).toBe("brave-key");
    expect(calls[0]!.url).toContain("count=3");

    expect((await webSearch("q", 3, { fetcher, config: { provider: "tavily", apiKey: "tvly-1" } }))[0]!.snippet).toBe("from Tavily");
    expect(new Headers(calls[1]!.init?.headers).get("authorization")).toBe("Bearer tvly-1");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ query: "q", max_results: 3 });

    expect((await webSearch("q", 3, { fetcher, config: { provider: "searxng", url: "http://searx.local/" } }))[0]!.title).toBe("Searx hit");
    expect(calls[2]!.url).toBe("http://searx.local/search?q=q&format=json");
  });

  it("says what's missing for a provider", async () => {
    const { fetcher } = fakeFetch({});
    await expect(webSearch("q", 3, { fetcher, config: { provider: "brave" } })).rejects.toThrow(/Brave Search needs an API key/);
    await expect(webSearch("q", 3, { fetcher, config: { provider: "searxng" } })).rejects.toThrow(/SearXNG needs the instance URL/);
    const forbidden = fakeFetch({ "http://s/search": () => new Response("Forbidden", { status: 403 }) });
    await expect(webSearch("q", 3, { fetcher: forbidden.fetcher, config: { provider: "searxng", url: "http://s" } })).rejects.toThrow(/JSON format/);
  });

  it("formats results for the model", () => {
    expect(formatResults("q", [{ title: "T", url: "https://t.example", snippet: "S" }])).toBe("1. T\n   https://t.example\n   S");
    expect(formatResults("q", [])).toMatch(/No results/);
  });
});

describe("web fetch", () => {
  it("turns a page into readable text without scripts, styles or navigation", () => {
    const { title, text } = htmlToText(`<html><head><title>Docs &amp; more</title><style>p{}</style></head><body>
      <nav>Home | About</nav><main><h1>Getting started</h1><p>Install it:</p><ul><li>one</li><li>two</li></ul>
      <script>alert(1)</script><p>Done&nbsp;&#8212; enjoy.</p></main><footer>© 2026</footer></body></html>`);
    expect(title).toBe("Docs & more");
    expect(text).toBe("# Getting started\nInstall it:\n\n- one\n- two\n\nDone — enjoy.");
  });

  it("fetches a page, cuts long ones, and refuses other schemes and binary files", async () => {
    const { fetcher } = fakeFetch({
      "https://page.example/": () => new Response(`<html><title>Hi</title><body><p>${"word ".repeat(100)}</p></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://file.example/": () => new Response("PK", { headers: { "content-type": "application/zip" } }),
    });
    const page = await webFetch("https://page.example/", { fetcher, maxChars: 50 });
    expect(page).toMatch(/^# Hi\nhttps:\/\/page\.example\/\n\nword word/);
    expect(page).toMatch(/\[Cut at 50 of 499 characters\.\]$/);
    await expect(webFetch("file:///etc/passwd", { fetcher })).rejects.toThrow(/Only http and https/);
    await expect(webFetch("https://file.example/a.zip", { fetcher })).rejects.toThrow(/application\/zip/);
    await expect(webFetch("https://missing.example/", { fetcher })).rejects.toThrow(/HTTP 404/);
  });
});

describe("web search config", () => {
  it("validates the provider and redacts a literal key", () => {
    expect(() => parseConfig({ webSearch: { provider: "bing" } })).toThrow();
    const config = parseConfig({ webSearch: { provider: "brave", apiKey: "secret-key" } });
    expect(redactConfig(config).webSearch).toEqual({ provider: "brave", apiKey: "<set-me>" });
    expect(redactConfig(parseConfig({ webSearch: { provider: "tavily", apiKey: "env:TAVILY" } })).webSearch?.apiKey).toBe("env:TAVILY");
  });
});
