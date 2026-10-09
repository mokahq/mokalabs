# @mokalabs/core

[![npm](https://img.shields.io/npm/v/@mokalabs/core?color=c2703d&label=%40mokalabs%2Fcore)](https://www.npmjs.com/package/@mokalabs/core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/mokahq/mokalabs/blob/main/LICENSE)

The headless engine behind [Moka](https://www.npmjs.com/package/@mokalabs/sandbox): providers for any LLM, an MCP client manager (stdio / Streamable HTTP / SSE), Agent Skills, a streaming tool loop, and an event bus that records every step.

```bash
npm i @mokalabs/core
```

```ts
import { MokaEngine, parseConfig } from "@mokalabs/core";

const engine = new MokaEngine({
  config: parseConfig({
    llms: [{ id: "gpt", name: "OpenAI", provider: "openai", model: "gpt-5-mini", apiKey: "env:OPENAI_API_KEY" }],
    mcpServers: [{ id: "fs", name: "Files", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] }],
    workspaces: [{ id: "w", name: "W", llmId: "gpt", mcpServerIds: ["fs"], skillIds: [] }],
  }),
});

engine.bus.subscribe((event) => console.log(`[${event.kind}] ${event.title}`));

for await (const chunk of engine.chat({ messages: [{ role: "user", content: "List the files here" }] })) {
  if (chunk.type === "text") process.stdout.write(chunk.text);
}
await engine.close();
```

Also exported: `McpManager`, `loadSkill`, `importMcpJson`, `exportCode` (AI SDK / LangGraph), `redactConfig`, `mokaJsonSchema`, and more.

Every step is an event on `engine.bus`: `run.start`, `llm.request` / `llm.response`, `tool.call` / `tool.result`, raw `mcp.rpc` messages (each response paired with its request), `mcp.log` and more. Use it for tests, CLIs, evals or your own UI.

[API reference](https://mokalabs.dev/reference/core/) · [Events](https://mokalabs.dev/reference/events/) · [GitHub](https://github.com/mokahq/mokalabs) · MIT
