/** A readable name for an HTTP server: mcp.deepwiki.com → deepwiki, jira.acme.com/mcp → jira. */
export function guessHttpName(url: string): string {
  try {
    const host = new URL(url).hostname.split(".").filter((part) => !/^(mcp|api|www|com|net|org|io|dev|ai|app|internal|local|localhost)$/i.test(part) && !/^\d+$/.test(part));
    return host[0] ?? new URL(url).hostname;
  } catch {
    return url;
  }
}
