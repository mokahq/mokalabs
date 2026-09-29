/**
 * What actually goes over the wire to HTTP MCP servers: the headers the
 * transport sent (yours, plus the ones the SDK adds such as `Authorization`
 * from OAuth or `mcp-session-id`), with secret values masked.
 */

export interface HttpExchange {
  method: string;
  /** Endpoint URL with query-string values masked. */
  url: string;
  at: number;
  durationMs?: number;
  status?: number;
  /** Network failure (no HTTP response). */
  error?: string;
  requestHeaders: Record<string, string>;
  /** Headers worth seeing when debugging (content type, session, auth challenge). */
  responseHeaders?: Record<string, string>;
  /** Lower-cased names of the headers that came from the server's config. */
  configured: string[];
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** Values that are never secret and help debugging, shown as-is. */
const PLAIN = new Set(["accept", "content-type", "content-length", "mcp-protocol-version", "user-agent", "last-event-id", "cache-control"]);
const RESPONSE = ["content-type", "mcp-session-id", "www-authenticate", "retry-after"];

/** Keep enough of a value to recognise it, never enough to reuse it. */
export function maskHeaderValue(name: string, value: string): string {
  const key = name.toLowerCase();
  if (PLAIN.has(key)) return value;
  if (key === "mcp-session-id") return value.length > 8 ? `${value.slice(0, 8)}…` : value;
  const scheme = /^(bearer|basic|token)\s+/i.exec(value);
  const secret = scheme ? value.slice(scheme[0].length) : value;
  const masked = secret.length >= 12 ? `${secret.slice(0, 4)}••• (${secret.length} chars)` : `••• (${secret.length} chars)`;
  return scheme ? `${scheme[0]}${masked}` : masked;
}

export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, "•••");
    return u.toString().replace(/%E2%80%A2/g, "•");
  } catch {
    return url;
  }
}

function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers ?? {}).forEach((value, key) => (out[key] = value));
  return out;
}

/**
 * A fetch that records every exchange with `endpoint` (other URLs, like OAuth
 * discovery, pass through untouched). SSE servers post messages to a URL they
 * announce later, so `sameOrigin` records anything on the endpoint's origin.
 */
export function tracingFetch(opts: {
  endpoint: URL;
  sameOrigin?: boolean;
  configured: Record<string, string> | undefined;
  onExchange: (exchange: HttpExchange) => void;
  fetch?: FetchLike;
}): FetchLike {
  const base = opts.fetch ?? ((url, init) => fetch(url, init));
  const target = opts.endpoint.origin + opts.endpoint.pathname;
  const configured = Object.keys(opts.configured ?? {}).map((k) => k.toLowerCase());
  return async (url, init) => {
    const href = typeof url === "string" ? url : url.toString();
    let parsed: URL | undefined;
    try {
      parsed = new URL(href);
    } catch {
      /* relative or odd URL: not ours */
    }
    const ours = parsed && (opts.sameOrigin ? parsed.origin === opts.endpoint.origin && !parsed.pathname.startsWith("/.well-known/") : parsed.origin + parsed.pathname === target);
    if (!ours) return base(url, init);

    const started = Date.now();
    const requestHeaders = Object.fromEntries(Object.entries(headerRecord(init?.headers)).map(([k, v]) => [k, maskHeaderValue(k, v)]));
    const exchange: HttpExchange = { method: (init?.method ?? "GET").toUpperCase(), url: maskUrl(href), at: started, requestHeaders, configured };
    try {
      const response = await base(url, init);
      exchange.status = response.status;
      exchange.durationMs = Date.now() - started;
      const responseHeaders: Record<string, string> = {};
      for (const name of RESPONSE) {
        const value = response.headers.get(name);
        if (value !== null) responseHeaders[name] = name === "mcp-session-id" ? maskHeaderValue(name, value) : value;
      }
      exchange.responseHeaders = responseHeaders;
      // Servers may refuse the optional GET event stream (and session DELETE) with 405; the SDK expects that.
      const optional = response.status === 405 && (exchange.method === "GET" || exchange.method === "DELETE");
      if (!optional) opts.onExchange(exchange);
      return response;
    } catch (error: any) {
      exchange.durationMs = Date.now() - started;
      exchange.error = error?.cause?.message ?? error?.message ?? String(error);
      opts.onExchange(exchange);
      throw error;
    }
  };
}
