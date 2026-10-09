# @mokalabs/proxy

**See what your AI editor sends to your MCP servers.**

[![npm](https://img.shields.io/npm/v/@mokalabs/proxy?color=c2703d&label=%40mokalabs%2Fproxy)](https://www.npmjs.com/package/@mokalabs/proxy)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/mokahq/mokalabs/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-mokalabs.dev-c2703d)](https://mokalabs.dev/guides/proxy/)

A pass-through proxy for MCP servers. Put it in front of the servers that GitHub Copilot (VS Code), Cursor, Claude Desktop, Claude Code, Windsurf or Gemini start, and [Moka](https://www.npmjs.com/package/@mokalabs/sandbox) shows every JSON-RPC message between them, live: requests and responses with latency, timeouts, cancellations, late replies, retries and server logs.

```bash
npx @mokalabs/proxy wrap     # find your editor configs and wrap their servers (asks first, keeps a backup)
npx @mokalabs/sandbox        # open Moka → Proxy tab
```

Restart the MCP servers in your editor (or reload its window) and use it as usual.

![wrap updates the VS Code and Cursor configs; each editor's MCP traffic then appears in Moka's Proxy tab, with a timed-out call and its retry flagged](https://raw.githubusercontent.com/mokahq/mokalabs/main/docs/assets/proxy.gif)

## Why

When a tool is slow or flaky inside an editor, you can't see what the client sent, how long it waited, or whether it gave up and tried again. If it retries a call that timed out, your server may run it twice. The proxy sees both directions and lines them up, so Moka can flag *"retry after a timeout: the first call may have run"*.

## Commands

```bash
npx @mokalabs/proxy wrap [files…] [--only a,b] [--dry-run] [--yes] [--local]
npx @mokalabs/proxy unwrap [files…] [--only a,b] [--yes]     # put your configs back
npx @mokalabs/proxy status                                   # what's wrapped, and where
npx @mokalabs/proxy export [--client vscode] [--name github] [--since 24h] [--raw] [-o file.json|-]
```

`export` writes everything recorded as one JSON file for a bug report. Tokens, keys and passwords are redacted unless you pass `--raw`. Moka's Proxy tab has the same **Export** button.

## Where it looks

`wrap` reads each client's global config and the project configs in the folder you run it from. It never searches the rest of your disk:

| Client | Global | Project |
|---|---|---|
| VS Code / GitHub Copilot | `mcp.json` in VS Code's user folder | `.vscode/mcp.json` |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| Claude Desktop | `claude_desktop_config.json` | |
| Claude Code | | `.mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | |
| Gemini CLI | `~/.gemini/settings.json` | `.gemini/settings.json` |
| Gemini | `~/.gemini/config/mcp_config.json` | |

Any other file: `npx @mokalabs/proxy wrap path/to/mcp.json`.

## How it works

`wrap` changes only the `command` and `args` of each server entry. Comments, formatting and other fields stay as they were:

```json
"github": {
  "command": "npx",
  "args": ["-y", "@mokalabs/proxy", "--client", "vscode", "--name", "github", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
}
```

The proxy starts the real server (everything after `--`), passes every byte through untouched in both directions, and appends each message to a session log in `~/.moka/proxy/sessions/` (`MOKA_HOME` moves it). Moka reads those logs whether it starts before or after your editor. The proxy never writes to stdout itself, and if the log can't be written it keeps passing messages through.

Everything stays on your machine. Local (stdio) servers only for now: `wrap` skips HTTP servers.

[Docs](https://mokalabs.dev/guides/proxy/) · [GitHub](https://github.com/mokahq/mokalabs) · MIT
