# @mokalabs/sandbox

**Any LLM. Any MCP server. Any skill. One command.**

```bash
npx @mokalabs/sandbox
```

Moka is a local web sandbox for chatting with any model (OpenAI, Anthropic, Gemini, Azure, Ollama, OpenRouter, Groq, or any OpenAI-compatible gateway) while plugging in MCP servers (stdio, Streamable HTTP, SSE) and Agent Skills. A live inspector shows every LLM step, tool call and raw JSON-RPC message.

- Zero config: API keys are picked up from env vars, Ollama is auto-detected, and a demo MCP server is built in
- Forms for models, MCP servers, skills and workspaces, saved to a readable `moka.json`
- Paste Claude Desktop, Cursor or VS Code `mcp.json` to import servers
- Compare models side by side, call tools manually, presenter mode, ⌘K palette
- Export a workspace as Vercel AI SDK or LangGraph code

```text
npx @mokalabs/sandbox [config.json] [--port 4000] [--host 127.0.0.1] [--no-open] [--token <t> | --no-auth]
moka init          # write a starter moka.json
moka demo-server   # run the bundled demo MCP server on stdio
```

Docker: `docker run --rm -p 4000:4000 -e OPENAI_API_KEY ghcr.io/mokahq/moka`

Full docs: https://github.com/mokahq/mokalabs
