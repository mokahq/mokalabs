---
"@mokalabs/core": patch
"@mokalabs/sandbox": patch
---

**See what went over the wire, and help people find Moka.**

- **Headers view.** For HTTP and SSE servers, **Settings → MCP servers** now shows the last request's method, URL, status, timing and every header it actually carried: your configured headers and the ones the client adds (`Authorization` after OAuth, `mcp-session-id`, `mcp-protocol-version`), plus useful response headers such as `WWW-Authenticate`. Secret values and query-string values are masked. Configured headers that weren't sent are flagged.
- **Clearer HTTP failures.** A rejected request now says what the server answered (`… (HTTP 401)`), and a new `mcp.http` inspector event carries the status, masked headers and auth challenge.
- **Readable AG-UI traces.** Adapters such as `ag-ui-langgraph` re-emit every framework event as `RAW`. Moka now collapses them into one `AG-UI RAW × N (collapsed)` entry per run (first 200 kept), so steps, tool calls and state stand out.
- **Star Moka on GitHub**: a small line on the empty chat screen (with a **Hide** link) and in the terminal banner, plus ⌘K commands to star, open the docs or report an issue. Never shown in presenter mode; turn it off for good with `"ui": { "starLink": false }` or **Settings → Config file → Preferences**.
- Fix: in the headers and environment-variable editors, the value field was squashed to a few pixels, so values couldn't be seen or edited.
- The README leads with the inspector and shows it in a short GIF.
