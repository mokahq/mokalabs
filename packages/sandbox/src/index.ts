import { serve, type ServerType } from "@hono/node-server";
import {
  ConfigStore,
  detectOllama,
  detectProfiles,
  mokaHome,
  MokaEngine,
  SessionStore,
  type MokaConfig,
} from "@mokalabs/core";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.js";

export { createApp } from "./server.js";
export { createDemoServer, runDemoServer } from "./demo-server.js";
export { startDemoAgent, type DemoAgent } from "./demo-agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

/** Virtual command that launches the bundled demo MCP server. */
export const DEMO_COMMAND = "moka:demo";

export interface StartOptions {
  port?: number;
  host?: string;
  /** Path to a moka.json. Defaults to ./moka.json if present, else ~/.moka/config.json. */
  configPath?: string;
  /** `false` disables auth; a string pins the token; undefined generates one. */
  token?: string | false;
  env?: NodeJS.ProcessEnv;
  /** Seed a fresh config with detected providers + the demo server. Default true. */
  seed?: boolean;
  /** Serve the prebuilt UI. Default true. */
  ui?: boolean;
}

export interface RunningSandbox {
  url: string;
  port: number;
  host: string;
  token?: string;
  configPath: string;
  engine: MokaEngine;
  seeded: boolean;
  close: () => Promise<void>;
}

export function resolveConfigPath(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit) return path.resolve(explicit);
  if (env.MOKA_CONFIG) return path.resolve(env.MOKA_CONFIG);
  const local = path.resolve("moka.json");
  if (existsSync(local)) return local;
  return path.join(mokaHome(env), "config.json");
}

/** Build a first-run config from whatever is available on this machine. */
export async function seedConfig(config: MokaConfig, env: NodeJS.ProcessEnv): Promise<MokaConfig> {
  const llms = detectProfiles(env);
  const ollamaModels = await detectOllama(env.OLLAMA_HOST ? normaliseOllama(env.OLLAMA_HOST) : undefined);
  if (ollamaModels.length > 0) {
    llms.push({
      id: "ollama",
      name: "Ollama",
      provider: "ollama",
      model: ollamaModels[0]!,
      baseURL: env.OLLAMA_HOST ? `${normaliseOllama(env.OLLAMA_HOST)}/v1` : undefined,
    });
  }
  const demo = { id: "moka-demo", name: "Moka demo tools", transport: "stdio" as const, command: DEMO_COMMAND, args: [] };
  const skill = {
    id: "moka-guide",
    name: "moka-guide",
    description: "Explains what Moka is and how to add models, MCP servers and skills. Use when the user asks about Moka itself.",
    content: MOKA_GUIDE_SKILL,
  };
  return {
    ...config,
    llms: config.llms.length ? config.llms : llms,
    mcpServers: config.mcpServers.length ? config.mcpServers : [demo],
    skills: config.skills.length ? config.skills : [skill],
    workspaces: config.workspaces.map((w, i) =>
      i === 0
        ? {
            ...w,
            llmId: w.llmId ?? llms[0]?.id,
            mcpServerIds: w.mcpServerIds.length ? w.mcpServerIds : [demo.id],
            skillIds: w.skillIds.length ? w.skillIds : [skill.id],
            systemPrompt: w.systemPrompt ?? "You are a helpful assistant. Use tools when they help, and explain briefly what you did.",
            starterPrompts: w.starterPrompts ?? [
              "What time is it in Tokyo and Bengaluru right now?",
              "Roll 3d20 and compute the average with the calculator",
              "Fetch https://example.com and summarise it",
              "What is Moka and how do I add my own MCP server?",
            ],
          }
        : w,
    ),
  };
}

function normaliseOllama(host: string): string {
  const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;
  return withScheme.replace(/\/$/, "");
}

export async function startSandbox(options: StartOptions = {}): Promise<RunningSandbox> {
  const env = options.env ?? process.env;
  const host = options.host ?? env.MOKA_HOST ?? "127.0.0.1";
  const configPath = resolveConfigPath(options.configPath, env);
  const store = new ConfigStore(configPath);
  let { config, existed } = await store.load();
  let seeded = false;
  if (!existed && options.seed !== false) {
    config = await store.save(await seedConfig(config, env));
    seeded = true;
  }

  // In dev (tsx) the CLI is TypeScript; in the published package it is compiled JS.
  const cliJs = path.join(here, "cli.js");
  const demoArgs = existsSync(cliJs)
    ? [cliJs, "demo-server"]
    : ["--import", "tsx", path.join(here, "cli.ts"), "demo-server"];
  const engine = new MokaEngine({
    config,
    store,
    env,
    oauthStorePath: path.join(mokaHome(env), "oauth.json"),
    resolveCommand: (command) =>
      command === DEMO_COMMAND ? { command: process.execPath, args: demoArgs } : undefined,
  });

  const token =
    options.token === false ? undefined : options.token || env.MOKA_TOKEN || randomBytes(16).toString("hex");
  const webDir = path.join(here, "web");
  const app = createApp({
    engine,
    sessions: new SessionStore(path.join(mokaHome(env), "sessions")),
    webDir: options.ui === false ? undefined : webDir,
    token,
    configPath,
    version: VERSION,
    env,
  });

  const { server, port } = await listen(app.fetch, host, options.port ?? Number(env.PORT ?? 4000));
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host === "127.0.0.1" ? "localhost" : host;
  // OAuth providers redirect the browser back here after sign-in.
  engine.oauthRedirectUrl = `${(env.MOKA_PUBLIC_URL ?? `http://${displayHost}:${port}`).replace(/\/$/, "")}/oauth/callback`;
  const url = `http://${displayHost}:${port}/${token ? `?token=${token}` : ""}`;

  return {
    url,
    port,
    host,
    token,
    configPath,
    engine,
    seeded,
    close: async () => {
      await engine.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function listen(
  fetch: (req: Request) => Response | Promise<Response>,
  host: string,
  preferred: number,
): Promise<{ server: ServerType; port: number }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = preferred + attempt;
    try {
      const server = await new Promise<ServerType>((resolve, reject) => {
        const s = serve({ fetch, port, hostname: host }, () => resolve(s));
        s.once("error", reject);
      });
      const address = server.address();
      return { server, port: typeof address === "object" && address ? address.port : port };
    } catch (error: any) {
      if (error?.code !== "EADDRINUSE" || preferred === 0) throw error;
    }
  }
  throw new Error(`No free port found starting at ${preferred}`);
}

const MOKA_GUIDE_SKILL = `---
name: moka-guide
description: Explains what Moka is and how to add models, MCP servers and skills.
---

# Moka guide

Moka is a local playground for chatting with any LLM while plugging in MCP servers and Agent Skills, with a live inspector of every call.

When the user asks how to do something in Moka, answer with these steps:

- **Add a model**: Settings → Models → Add. Pick a provider preset (OpenAI, Anthropic, Gemini, Azure, Ollama, OpenRouter, Groq…) or "Custom" for any OpenAI-compatible gateway. Keys can be typed or referenced as \`env:VAR_NAME\`.
- **Add an MCP server**: Settings → MCP → Add. Choose stdio (command + args), Streamable HTTP, or SSE (URL + headers). You can also paste a Claude Desktop / Cursor \`mcpServers\` JSON with Import.
- **Add a skill**: Settings → Skills → Add. Point to a folder containing SKILL.md, scan a folder of skills, or paste SKILL.md content.
- **Workspaces** bundle a model, servers, skills, a system prompt and starter prompts. Switch them from the top bar.
- **Inspector** (right panel) shows every LLM step, tool call, and raw MCP JSON-RPC message with timings.
- **Agents**: Settings → Agents connects an existing agent over A2A or AG-UI (try \`moka demo-agent\`).
- **Generative UI**: Settings → Generative UI adds custom A2UI component catalogs and has a playground.
- **Compare** runs the same prompt against two models side by side.
- **Export** turns the current workspace into Vercel AI SDK or LangGraph code, or a shareable moka.json.

Keep answers short and practical.
`;
