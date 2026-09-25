import { uniqueId, type LlmProfile, type McpServerConfig, type MokaConfig, type Workspace } from "./config.js";

/**
 * Import servers from the `mcpServers` JSON used by Claude Desktop, Claude
 * Code, Cursor and Windsurf, or the `servers` JSON used by VS Code.
 */
export function importMcpJson(input: unknown, takenIds: Iterable<string> = []): McpServerConfig[] {
  const root = (typeof input === "string" ? JSON.parse(input) : input) as any;
  const map = root?.mcpServers ?? root?.servers ?? root?.mcp?.servers ?? root;
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    throw new Error('Expected an object with "mcpServers" (Claude/Cursor) or "servers" (VS Code).');
  }
  const taken = new Set(takenIds);
  const out: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries<any>(map)) {
    if (!raw || typeof raw !== "object") continue;
    const id = uniqueId(name, taken);
    taken.add(id);
    const type = String(raw.type ?? raw.transport ?? "").toLowerCase();
    if (raw.command) {
      out.push({ id, name, transport: "stdio", command: raw.command, args: raw.args ?? [], env: raw.env, cwd: raw.cwd });
    } else if (raw.url || raw.serverUrl) {
      out.push({
        id,
        name,
        transport: type === "sse" ? "sse" : "http",
        url: raw.url ?? raw.serverUrl,
        headers: raw.headers,
      });
    }
  }
  if (out.length === 0) throw new Error("No MCP servers found in that JSON.");
  return out;
}

/** Export servers in the de-facto standard `mcpServers` format. */
export function exportMcpJson(servers: McpServerConfig[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    mcpServers[s.name] =
      s.transport === "stdio"
        ? { command: s.command, args: s.args ?? [], ...(s.env && Object.keys(s.env).length ? { env: s.env } : {}) }
        : { type: s.transport, url: s.url, ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}) };
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

/** Map Moka's virtual commands to something runnable outside the sandbox. */
function portable(server: McpServerConfig): McpServerConfig {
  if (server.transport === "stdio" && server.command === "moka:demo") {
    return { ...server, command: "npx", args: ["-y", "@mokalabs/sandbox", "demo-server"] };
  }
  return server;
}

export type CodeTarget = "ai-sdk" | "langgraph" | "mcp-json" | "moka";

export interface CodeExportInput {
  config: MokaConfig;
  workspace: Workspace;
  llm?: LlmProfile;
  servers: McpServerConfig[];
}

const q = (s: string) => JSON.stringify(s);
const envName = (value: string | undefined, fallback: string) => {
  const m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(value ?? "") ?? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value ?? "");
  return m ? m[1]! : fallback;
};

export function exportCode(target: CodeTarget, input: CodeExportInput): string {
  if (target !== "moka") input = { ...input, servers: input.servers.map(portable) };
  switch (target) {
    case "mcp-json":
      return exportMcpJson(input.servers);
    case "moka":
      return JSON.stringify(input.config, null, 2);
    case "ai-sdk":
      return aiSdkCode(input);
    case "langgraph":
      return langGraphCode(input);
  }
}

function aiSdkCode({ workspace, llm, servers }: CodeExportInput): string {
  const provider = llm?.provider ?? "openai";
  const keyVar = envName(llm?.apiKey, "API_KEY");
  const imports: Record<string, string> = {
    openai: `import { createOpenAI } from "@ai-sdk/openai";`,
    anthropic: `import { createAnthropic } from "@ai-sdk/anthropic";`,
    google: `import { createGoogleGenerativeAI } from "@ai-sdk/google";`,
    azure: `import { createAzure } from "@ai-sdk/azure";`,
    ollama: `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";`,
    "openai-compatible": `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";`,
  };
  const base = llm?.baseURL ? `, baseURL: ${q(llm.baseURL)}` : "";
  const factory: Record<string, string> = {
    openai: `createOpenAI({ apiKey: process.env.${keyVar}${base} })`,
    anthropic: `createAnthropic({ apiKey: process.env.${keyVar}${base} })`,
    google: `createGoogleGenerativeAI({ apiKey: process.env.${keyVar}${base} })`,
    azure: `createAzure({ apiKey: process.env.${keyVar}, resourceName: process.env.AZURE_RESOURCE_NAME })`,
    ollama: `createOpenAICompatible({ name: "ollama", baseURL: ${q(llm?.baseURL ?? "http://localhost:11434/v1")} })`,
    "openai-compatible": `createOpenAICompatible({ name: "custom", apiKey: process.env.${keyVar}${base || `, baseURL: "https://..."`} })`,
  };
  const transports = servers.map((s, i) => {
    const t =
      s.transport === "stdio"
        ? `new StdioClientTransport({ command: ${q(s.command ?? "")}, args: ${JSON.stringify(s.args ?? [])} })`
        : `{ type: ${q(s.transport)}, url: ${q(s.url ?? "")}${s.headers ? `, headers: ${JSON.stringify(s.headers)}` : ""} }`;
    return `const mcp${i} = await createMCPClient({ transport: ${t} }); // ${s.name}`;
  });
  return `// Generated by Moka — https://github.com/thebunnyweb/mokalabs
// npm i ai @ai-sdk/mcp @modelcontextprotocol/sdk ${provider === "ollama" || provider === "openai-compatible" ? "@ai-sdk/openai-compatible" : `@ai-sdk/${provider}`}
import { streamText, stepCountIs } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
${servers.some((s) => s.transport === "stdio") ? `import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";\n` : ""}${imports[provider]}

const model = ${factory[provider]}(${q(llm?.model ?? "gpt-5-mini")});

${transports.join("\n") || "// No MCP servers in this workspace"}
const tools = {
${servers.map((_, i) => `  ...(await mcp${i}.tools()),`).join("\n")}
};

const result = streamText({
  model,
  tools,
  stopWhen: stepCountIs(${workspace.maxSteps ?? 12}),${workspace.systemPrompt ? `\n  system: ${q(workspace.systemPrompt)},` : ""}
  prompt: ${q(workspace.starterPrompts?.[0] ?? "Hello!")},
});

for await (const text of result.textStream) process.stdout.write(text);
${servers.map((_, i) => `await mcp${i}.close();`).join("\n")}
`;
}

function langGraphCode({ workspace, llm, servers }: CodeExportInput): string {
  const provider = llm?.provider ?? "openai";
  const keyVar = envName(llm?.apiKey, "API_KEY");
  const model = llm?.model ?? "gpt-5-mini";
  const chat: Record<string, [string, string]> = {
    openai: ["langchain-openai", `from langchain_openai import ChatOpenAI\nmodel = ChatOpenAI(model=${q(model)}, api_key=os.environ[${q(keyVar)}]${llm?.baseURL ? `, base_url=${q(llm.baseURL)}` : ""})`],
    anthropic: ["langchain-anthropic", `from langchain_anthropic import ChatAnthropic\nmodel = ChatAnthropic(model=${q(model)}, api_key=os.environ[${q(keyVar)}])`],
    google: ["langchain-google-genai", `from langchain_google_genai import ChatGoogleGenerativeAI\nmodel = ChatGoogleGenerativeAI(model=${q(model)}, google_api_key=os.environ[${q(keyVar)}])`],
    azure: ["langchain-openai", `from langchain_openai import AzureChatOpenAI\nmodel = AzureChatOpenAI(azure_deployment=${q(model)}, api_version=${q(llm?.apiVersion ?? "2024-10-21")})`],
    ollama: ["langchain-ollama", `from langchain_ollama import ChatOllama\nmodel = ChatOllama(model=${q(model)})`],
    "openai-compatible": ["langchain-openai", `from langchain_openai import ChatOpenAI\nmodel = ChatOpenAI(model=${q(model)}, base_url=${q(llm?.baseURL ?? "https://...")}, api_key=os.environ.get(${q(keyVar)}, "none"))`],
  };
  const [pkg, modelCode] = chat[provider]!;
  const serverDict = servers
    .map((s) => {
      const body =
        s.transport === "stdio"
          ? `"command": ${q(s.command ?? "")}, "args": ${JSON.stringify(s.args ?? [])}, "transport": "stdio"`
          : `"url": ${q(s.url ?? "")}, "transport": ${q(s.transport === "sse" ? "sse" : "streamable_http")}${s.headers ? `, "headers": ${JSON.stringify(s.headers)}` : ""}`;
      return `        ${q(s.id)}: {${body}},`;
    })
    .join("\n");
  return `# Generated by Moka — https://github.com/thebunnyweb/mokalabs
# pip install langgraph langchain-mcp-adapters ${pkg}
import asyncio
import os

from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent
${modelCode}

SYSTEM_PROMPT = ${q(workspace.systemPrompt ?? "You are a helpful assistant.")}


async def main() -> None:
    client = MultiServerMCPClient({
${serverDict || "        # No MCP servers in this workspace"}
    })
    tools = await client.get_tools()
    agent = create_react_agent(model, tools, prompt=SYSTEM_PROMPT)
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": ${q(workspace.starterPrompts?.[0] ?? "Hello!")}}]},
        {"recursion_limit": ${(workspace.maxSteps ?? 12) * 2 + 1}},
    )
    print(result["messages"][-1].content)


if __name__ == "__main__":
    asyncio.run(main())
`;
}
