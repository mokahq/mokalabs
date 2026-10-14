<div align="center">

<img src="https://raw.githubusercontent.com/mokahq/mokalabs/main/brand/png/moka-puppy-256.png" width="110" height="110" alt="Moka the puppy, holding a coffee" />

# Moka

**See every MCP message.**

Chat with any LLM, plug in any MCP server, agent or skill, and inspect every call. Or see what your AI editor sends to your MCP servers. One command, zero config, 100% local.

[![npm](https://img.shields.io/npm/v/@mokalabs/sandbox?color=c2703d&label=%40mokalabs%2Fsandbox)](https://www.npmjs.com/package/@mokalabs/sandbox)
[![downloads](https://img.shields.io/npm/dm/@mokalabs/sandbox?color=c2703d)](https://www.npmjs.com/package/@mokalabs/sandbox)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/mokahq/mokalabs/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-mokalabs.dev-c2703d)](https://mokalabs.dev)

</div>

```bash
npx @mokalabs/sandbox
```

Node 20+. Moka picks up your API keys from the environment, finds a local Ollama, ships with a demo MCP server so the first run already has tools, and opens in your browser.

## Chat and inspect every call

Any model, any MCP server. The inspector shows every LLM step, tool call and raw JSON-RPC message, each response paired with its request.

![A chat with MCP tool calls, then the inspector's paired JSON-RPC request and response](https://raw.githubusercontent.com/mokahq/mokalabs/main/docs/assets/chat.gif)

## Test your tools across models

Prompts with the tools a model should (and shouldn't) call, run on several models, several times each. **Suggest tests** writes a first set from your tools; `moka test` runs them in CI.

![Tool tests run on two local models, three times each, with a failed run's wrong argument](https://raw.githubusercontent.com/mokahq/mokalabs/main/docs/assets/tests.gif)

## Compare models

One prompt, the same MCP tools, several models side by side: answers, tool calls, latency and tokens.

![Three models answer the same prompt with the same MCP tools](https://raw.githubusercontent.com/mokahq/mokalabs/main/docs/assets/compare.gif)

## Call tools directly

Run any tool, resource or prompt from a form generated from its schema. No model needed. Long-running tools show live progress.

![The Tools view: a generated form, then a long-running tool with live progress](https://raw.githubusercontent.com/mokahq/mokalabs/main/docs/assets/tools.gif)

## See what your AI editor sends to your MCP servers

Put [`@mokalabs/proxy`](https://www.npmjs.com/package/@mokalabs/proxy) in front of the MCP servers of GitHub Copilot (VS Code), Cursor, Claude Desktop, Claude Code, Windsurf or Gemini, and Moka's **Proxy** tab shows every message, live: timeouts, retries, late replies, errors.

```bash
npx @mokalabs/proxy wrap     # finds your editor configs, asks before changing anything
npx @mokalabs/sandbox        # → Proxy tab
```

![Each editor's MCP traffic in the Proxy tab, with a timed-out call and its retry flagged](https://raw.githubusercontent.com/mokahq/mokalabs/main/docs/assets/proxy.gif)

## Pages, diagrams and files

HTML pages a model writes open next to the chat, Mermaid diagrams draw in place, and documents your tools make (PDF, Word, HTML, CSV) open there too. Attach PDFs and Word files: local models (LM Studio, Ollama) get their text, read in your browser.

![An HTML dashboard opens next to the chat, a Mermaid diagram draws in place, a tool makes a PDF](https://raw.githubusercontent.com/mokahq/mokalabs/main/docs/assets/files.gif)

## Security check and context budget

Every MCP server is checked for tool poisoning, invisible characters, shadowing and tools that change after you trusted them. And Moka shows how many tokens each server's tool definitions cost on every request.

## Generative UI, from your own agent

Point Moka at a LangGraph, CopilotKit or ADK agent over AG-UI or A2A: you get a chat UI, every step in the inspector, and tools that answer with A2UI render as real forms. Moka also renders MCP Apps.

![A LangGraph agent shows a drink menu form, then an order card](https://raw.githubusercontent.com/mokahq/mokalabs/main/docs/assets/agent.gif)

## Works with

- **Models:** OpenAI, Anthropic, Gemini, Azure OpenAI, Ollama, LM Studio, OpenRouter, Groq, DeepSeek, Mistral, xAI, Together, and any OpenAI-compatible gateway (vLLM, LiteLLM, your company's gateway).
- **MCP servers:** stdio, Streamable HTTP and SSE, with OAuth sign-in, elicitation, sampling, resources and prompts. Paste a Claude Desktop, Cursor or VS Code `mcp.json` to import them.
- **Agents:** AG-UI (LangGraph, CopilotKit, Mastra…) and A2A (Google ADK…).
- **Agent Skills:** `SKILL.md` folders, including `~/.claude/skills`.

## 100% local

No account, no telemetry, no Moka backend. Prompts go only to the model you pick, and with Ollama or LM Studio nothing leaves your machine. API keys can stay in your environment (`"apiKey": "env:OPENAI_API_KEY"`) and are never written to disk. Moka binds to `127.0.0.1` and every API call needs the token printed at startup.

## At work

- **Company certificates:** Moka trusts the certificates your OS trusts (macOS keychain, Windows store), so internal gateways connect. Or set `NODE_EXTRA_CA_CERTS`.
- **HTTP(S) proxy:** `HTTPS_PROXY` / `NO_PROXY`, or `--proxy <url>`.
- **Gateways:** extra stream events are skipped, Azure's GPT-5 models get `max_completion_tokens`, and a per-model **Stream responses** switch handles gateways that don't stream well.
- **Curated registries:** zero runtime dependencies, so `npx` installs exactly one package.

## CLI

```text
npx @mokalabs/sandbox [config.json] [options]
moka [config.json] [options]          after: npm i -g @mokalabs/sandbox
moka init                             write a starter moka.json in this folder
moka demo-server                      run the bundled demo MCP server on stdio
moka demo-agent [--port]              run a demo A2A + AG-UI agent
moka test [config.json] [--models a,b] [--runs n]   run tool tests (CI)

-p, --port <n>        port (default 4000, or $PORT)
-H, --host <host>     interface to bind (default 127.0.0.1)
-c, --config <file>   config file (default ./moka.json, else ~/.moka/config.json)
    --token <token>   fixed access token (default: random, or $MOKA_TOKEN)
    --no-auth         disable the access token (trusted machines only)
    --no-open         don't open the browser
    --proxy <url>     send model/MCP traffic through an HTTP(S) proxy
    --no-system-ca    don't trust the OS certificate store
```

Everything you set in the UI is saved to a readable `moka.json`:

```jsonc
{
  "llms": [{ "id": "gpt", "name": "OpenAI", "provider": "openai", "model": "gpt-5-mini", "apiKey": "env:OPENAI_API_KEY" }],
  "mcpServers": [{ "id": "fs", "name": "Filesystem", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }],
  "workspaces": [{ "id": "demo", "name": "Demo", "llmId": "gpt", "mcpServerIds": ["fs"] }]
}
```

Also: `npm create moka@latest my-demo` scaffolds a shareable demo project, and Docker works too: `docker run --rm -p 4000:4000 -e OPENAI_API_KEY ghcr.io/mokahq/moka`.

## Links

[Docs](https://mokalabs.dev) · [Quickstart](https://mokalabs.dev/quickstart/) · [Configuration](https://mokalabs.dev/reference/config/) · [GitHub](https://github.com/mokahq/mokalabs) · [Issues](https://github.com/mokahq/mokalabs/issues)

⭐ If Moka saves you time, [a star on GitHub](https://github.com/mokahq/mokalabs) helps other people find it.

MIT
