# Architecture

```
┌──────────── browser (React + Tailwind, packages/sandbox/web) ────────────┐
│  Chat · Compare · Tools · Settings forms · Inspector                     │
└───────────────┬──────────────────────────────▲───────────────────────────┘
      REST + NDJSON streams (/api/*, token)    │  /api/events (NDJSON)
┌───────────────▼──────────────────────────────┴───────────────────────────┐
│  Hono server (packages/sandbox/src/server.ts)                            │
└───────────────┬──────────────────────────────────────────────────────────┘
┌───────────────▼──────────── @mokalabs/core ──────────────────────────────┐
│  MokaEngine ── ConfigStore (moka.json)                                   │
│    ├─ providers.ts   AI SDK: OpenAI, Anthropic, Gemini, Azure,           │
│    │                 OpenAI-compatible (Ollama, gateways…)               │
│    ├─ mcp.ts         McpManager: stdio / Streamable HTTP / SSE clients,  │
│    │                 raw JSON-RPC tap → EventBus                         │
│    ├─ skills.ts      SKILL.md loader, load_skill / read_skill_file       │
│    ├─ agent.ts       streamText tool loop → ChatChunk stream + events    │
│    └─ events.ts      EventBus (ring buffer, live subscribers)            │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Stateless chat.** The browser keeps each conversation's model messages and sends the full history on every turn. Sessions are persisted as JSON under `~/.moka/sessions`.
- **Lazy MCP connections.** Servers connect on first use. A connection is rebuilt only when its transport-level config changes; renaming a server or toggling tools doesn't reconnect it.
- **Tool naming.** MCP tools are exposed to models as `<serverId>__<tool>`, sanitised to `^[a-zA-Z0-9_-]{1,64}$`.
- **Skills.** Progressive disclosure: names and descriptions go in the system prompt, and the body is fetched with the `load_skill` tool.
