---
"@mokalabs/proxy": minor
"@mokalabs/sandbox": minor
"@mokalabs/core": minor
"create-moka": minor
---

**The proxy works with HTTP servers.** `wrap` used to skip remote servers ("HTTP servers aren't supported yet"); now each one becomes a local bridge that your editor starts like any local server, and that forwards every message to the real URL, unchanged and recorded for the Proxy tab. Streamable HTTP and HTTP+SSE; VS Code, Cursor, Claude Code, Windsurf and Gemini entry shapes (`url`, `httpUrl`, `serverUrl`). Headers move to `env` (`MOKA_PROXY_HEADER_n`), so tokens aren't in the process list; `${input:…}` still works. Sessions are kept and closed with the editor, and when a server forgets one (idle timeout, restart) the bridge opens a new session and resends the request. `unwrap` restores the original entry exactly. Servers that sign in with OAuth need their credentials as headers. By hand: `npx @mokalabs/proxy --url https://… --header "Authorization: Bearer …"`.
