# @mokalabs/proxy

**See what your AI editor sends to your MCP servers.**

A pass-through proxy for MCP servers. Put it in front of a server that GitHub Copilot (VS Code), Cursor, Claude Desktop, Claude Code, Windsurf or Gemini starts, and every JSON-RPC message between them is recorded for the [Moka](https://github.com/mokahq/mokalabs) inspector: requests, responses, timeouts, cancellations, late replies, retries and server logs.

```bash
npx @mokalabs/proxy wrap     # find your client configs and wrap their servers (asks first, keeps a backup)
npx @mokalabs/sandbox        # open Moka → Proxy tab
```

Restart the MCP servers in your editor and use it as usual.

```bash
npx @mokalabs/proxy status   # what's wrapped, and where
npx @mokalabs/proxy unwrap   # put your configs back
npx @mokalabs/proxy export   # everything recorded, as one JSON file (secrets redacted)
```

## How it works

`wrap` changes only the `command` and `args` of each server entry (comments and formatting are kept):

```json
"github": {
  "command": "npx",
  "args": ["-y", "@mokalabs/proxy", "--client", "vscode", "--name", "github", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
}
```

The proxy starts the real server (everything after `--`), passes every byte through untouched in both directions, and appends each message to a session log in `~/.moka/proxy/sessions/` (`MOKA_HOME` moves it). Moka reads those logs, whether it starts before or after your editor. The proxy never writes to stdout itself, and if the log can't be written it keeps passing messages through.

Local (stdio) servers only for now; `wrap` skips HTTP servers.

Docs: [Proxy for your AI editor](https://mokahq.github.io/mokalabs/guides/proxy/) · MIT
