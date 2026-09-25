import {
  agentSchema,
  catalogConfigSchema,
  discoverSkills,
  exportCode,
  importMcpJson,
  loadCatalog,
  loadSkill,
  STANDARD_CATALOG,
  llmProfileSchema,
  mcpServerSchema,
  PROVIDER_PRESETS,
  redactConfig,
  skillSchema,
  type CodeTarget,
  type MokaEngine,
  type SessionStore,
} from "@mokalabs/core";
import { Hono, type Context } from "hono";
import { stream } from "hono/streaming";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface ServerOptions {
  engine: MokaEngine;
  sessions: SessionStore;
  /** Directory containing the built web UI. */
  webDir?: string;
  /** When set, every /api request must present this token. */
  token?: string;
  configPath: string;
  version: string;
  env?: NodeJS.ProcessEnv;
}

const ENV_HINTS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "AZURE_API_KEY",
  "AZURE_RESOURCE_NAME",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "TOGETHER_API_KEY",
];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function badRequest(c: Context, message: string) {
  return c.json({ error: message }, 400);
}

async function body<T = any>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

function safeParse<T>(schema: { safeParse: (v: unknown) => any }, value: unknown): { data?: T; error?: string } {
  const result = schema.safeParse(value);
  if (result.success) return { data: result.data };
  return { error: result.error.issues.map((i: any) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ") };
}

export function createApp(options: ServerOptions): Hono {
  const { engine, sessions, token } = options;
  const env = options.env ?? process.env;
  const app = new Hono();

  app.onError((error, c) => {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  });

  // --- auth -----------------------------------------------------------------
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") return next();
    if (token) {
      const presented = c.req.header("x-moka-token") ?? c.req.query("token");
      if (presented !== token) return c.json({ error: "Unauthorized. Open the URL printed in your terminal." }, 401);
    }
    return next();
  });

  app.get("/api/health", (c) => c.json({ ok: true, version: options.version }));

  // --- bootstrap / config -----------------------------------------------------
  app.get("/api/bootstrap", async (c) => {
    const config = engine.getConfig();
    const [skills, catalogs] = await Promise.all([engine.loadSkills(), engine.loadCatalogs()]);
    return c.json({
      catalogs: [STANDARD_CATALOG, ...catalogs],
      interactions: engine.interactions.pending(),
      version: options.version,
      configPath: options.configPath,
      config,
      presets: PROVIDER_PRESETS,
      env: Object.fromEntries(ENV_HINTS.map((k) => [k, Boolean(env[k])])),
      mcp: engine.mcp.states(),
      skills: skills.map(({ body: _b, ...rest }) => rest),
    });
  });

  app.put("/api/config", async (c) => {
    const next = await body(c);
    if (!next || typeof next !== "object" || Array.isArray(next) || !Array.isArray((next as any).workspaces)) {
      return badRequest(c, "Expected a full Moka config object");
    }
    try {
      const config = await engine.setConfig(next);
      return c.json({ config });
    } catch (error: any) {
      const issues = error?.issues?.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return badRequest(c, issues || error?.message || "Invalid config");
    }
  });

  app.get("/api/config/export", (c) => {
    const redact = c.req.query("redact") !== "0";
    const config = redact ? redactConfig(engine.getConfig()) : engine.getConfig();
    return c.json({ $schema: "https://unpkg.com/@mokalabs/sandbox/dist/moka.schema.json", ...config });
  });

  app.post("/api/export", async (c) => {
    const { target, workspaceId } = await body<{ target: CodeTarget; workspaceId?: string }>(c);
    const config = redactConfig(engine.getConfig());
    const workspace = config.workspaces.find((w) => w.id === workspaceId) ?? engine.workspace(workspaceId);
    const llm = config.llms.find((l) => l.id === workspace.llmId) ?? config.llms[0];
    const servers = config.mcpServers.filter((s) => workspace.mcpServerIds.includes(s.id));
    const scoped = target === "moka" ? { ...config, activeWorkspaceId: workspace.id } : config;
    return c.json({ code: exportCode(target, { config: scoped, workspace, llm, servers }) });
  });

  // --- LLMs -----------------------------------------------------------------
  app.post("/api/llm/test", async (c) => {
    const { profile } = await body(c);
    const parsed = safeParse<any>(llmProfileSchema, profile);
    if (parsed.error) return badRequest(c, parsed.error);
    return c.json(await engine.testLlm(parsed.data));
  });

  app.post("/api/llm/models", async (c) => {
    const { profile } = await body(c);
    const parsed = safeParse<any>(llmProfileSchema, { model: "-", ...profile });
    if (parsed.error) return badRequest(c, parsed.error);
    try {
      return c.json({ models: await engine.listModels(parsed.data) });
    } catch (error: any) {
      return c.json({ models: [], error: error?.message ?? String(error) });
    }
  });

  // --- Remote agents (A2A / AG-UI) -------------------------------------------
  app.post("/api/agents/test", async (c) => {
    const { agent } = await body(c);
    const parsed = safeParse<any>(agentSchema, agent);
    if (parsed.error) return badRequest(c, parsed.error);
    return c.json(await engine.testAgent(parsed.data));
  });

  // --- MCP ------------------------------------------------------------------
  app.get("/api/mcp", (c) => c.json({ servers: engine.mcp.states() }));

  /** Connect a server from a draft config (used by the form's "Test" button). */
  app.post("/api/mcp/test", async (c) => {
    const { server } = await body(c);
    const parsed = safeParse<any>(mcpServerSchema, server);
    if (parsed.error) return badRequest(c, parsed.error);
    const known = engine.getConfig().mcpServers.some((s) => s.id === parsed.data.id);
    const state = { ...(await engine.mcp.reconnect(parsed.data)) };
    // Draft servers are only connected long enough to report their capabilities.
    if (!known) await engine.mcp.disconnect(parsed.data.id);
    return c.json({ state });
  });

  app.post("/api/mcp/import", async (c) => {
    const { json } = await body<{ json: string }>(c);
    try {
      const servers = importMcpJson(json, engine.getConfig().mcpServers.map((s) => s.id));
      return c.json({ servers });
    } catch (error: any) {
      return badRequest(c, error?.message ?? "Invalid JSON");
    }
  });

  const serverOr404 = (c: Context) => {
    const server = engine.getConfig().mcpServers.find((s) => s.id === c.req.param("id"));
    return server;
  };

  app.post("/api/mcp/:id/connect", async (c) => {
    const server = serverOr404(c);
    if (!server) return c.json({ error: "Unknown server" }, 404);
    const { force } = await body<{ force?: boolean }>(c);
    const state = force ? await engine.mcp.reconnect(server) : await engine.mcp.ensure(server);
    return c.json({ state });
  });

  app.post("/api/mcp/:id/disconnect", async (c) => {
    await engine.mcp.disconnect(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/mcp/:id/call", async (c) => {
    const server = serverOr404(c);
    if (!server) return c.json({ error: "Unknown server" }, 404);
    const { tool, args, source } = await body<{ tool: string; args?: Record<string, unknown>; source?: string }>(c);
    const via = source === "app" ? "MCP App" : "manual";
    if (!tool) return badRequest(c, "tool is required");
    await engine.mcp.ensure(server);
    const started = Date.now();
    engine.bus.emit({ kind: "tool.call", title: `${server.name} › ${tool} (${via})`, serverId: server.id, data: { input: args ?? {} } });
    try {
      const result = await engine.mcp.callTool(server.id, tool, args ?? {});
      engine.bus.emit({
        kind: result.isError ? "tool.error" : "tool.result",
        title: `${tool} ${result.isError ? "✗" : "✓"} (${via})`,
        serverId: server.id,
        durationMs: Date.now() - started,
        level: result.isError ? "error" : "info",
        data: result,
      });
      return c.json({ result, durationMs: Date.now() - started });
    } catch (error: any) {
      engine.bus.emit({ kind: "tool.error", level: "error", title: `${tool} ✗ ${error?.message}`, serverId: server.id, durationMs: Date.now() - started });
      return c.json({ error: error?.message ?? String(error), durationMs: Date.now() - started }, 500);
    }
  });

  app.post("/api/mcp/:id/signout", async (c) => {
    const server = serverOr404(c);
    if (!server) return c.json({ error: "Unknown server" }, 404);
    return c.json({ state: await engine.mcp.signOut(server) });
  });

  app.post("/api/mcp/:id/resource", async (c) => {
    const server = serverOr404(c);
    if (!server) return c.json({ error: "Unknown server" }, 404);
    const { uri } = await body<{ uri: string }>(c);
    await engine.mcp.ensure(server);
    return c.json({ result: await engine.mcp.readResource(server.id, uri) });
  });

  app.post("/api/mcp/:id/prompt", async (c) => {
    const server = serverOr404(c);
    if (!server) return c.json({ error: "Unknown server" }, 404);
    const { name, args } = await body<{ name: string; args?: Record<string, string> }>(c);
    await engine.mcp.ensure(server);
    return c.json({ result: await engine.mcp.getPrompt(server.id, name, args) });
  });

  // --- Skills ---------------------------------------------------------------
  app.post("/api/skills/preview", async (c) => {
    const { skill } = await body(c);
    const parsed = safeParse<any>(skillSchema, skill);
    if (parsed.error) return badRequest(c, parsed.error);
    return c.json({ skill: await loadSkill(parsed.data, path.dirname(options.configPath)) });
  });

  app.post("/api/skills/discover", async (c) => {
    const { path: root } = await body<{ path: string }>(c);
    if (!root) return badRequest(c, "path is required");
    try {
      return c.json({ paths: await discoverSkills(path.resolve(path.dirname(options.configPath), root)) });
    } catch (error: any) {
      return badRequest(c, error?.message ?? String(error));
    }
  });

  // --- Generative UI: catalogs and playground --------------------------------
  app.get("/api/catalogs", async (c) => c.json({ catalogs: [STANDARD_CATALOG, ...(await engine.loadCatalogs())] }));

  app.post("/api/catalogs/preview", async (c) => {
    const { catalog } = await body(c);
    const parsed = safeParse<any>(catalogConfigSchema, catalog);
    if (parsed.error) return badRequest(c, parsed.error);
    return c.json({ catalog: await loadCatalog(parsed.data, path.dirname(options.configPath)) });
  });

  app.get("/api/ui/tool", async (c) => c.json(await engine.renderToolDefinition(c.req.query("workspaceId"))));

  app.post("/api/ui/preview", async (c) => {
    const { input, workspaceId, component } = await body<{ input: unknown; workspaceId?: string; component?: { catalogId: string; name: string } }>(c);
    if (component) return c.json(await engine.previewComponent(component.catalogId, component.name));
    return c.json(await engine.previewUi(input, workspaceId));
  });

  app.post("/api/ui/generate", async (c) => {
    const { prompt, workspaceId, llmId } = await body<{ prompt: string; workspaceId?: string; llmId?: string }>(c);
    if (!prompt?.trim()) return badRequest(c, "prompt is required");
    try {
      return c.json(await engine.generateUi(prompt, { workspaceId, llmId, signal: c.req.raw.signal }));
    } catch (error: any) {
      return c.json({ error: error?.message ?? String(error) }, 502);
    }
  });

  // --- Human in the loop (approvals, elicitation, sampling) -----------------
  app.get("/api/interactions", (c) => c.json({ interactions: engine.interactions.pending() }));

  app.post("/api/interactions/:id", async (c) => {
    const { response } = await body<{ response: any }>(c);
    if (!response || typeof response !== "object") return badRequest(c, "response is required");
    const ok = await engine.respond(c.req.param("id"), response);
    return ok ? c.json({ ok }) : c.json({ error: "This request is no longer pending" }, 404);
  });

  // --- Chat -----------------------------------------------------------------
  app.post("/api/chat", async (c) => {
    const req = await body<{ messages: any[]; workspaceId?: string; llmId?: string; agentId?: string }>(c);
    if (!Array.isArray(req.messages)) return badRequest(c, "messages must be an array");
    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    const controller = new AbortController();
    const upstream = c.req.raw.signal;
    upstream?.addEventListener("abort", () => controller.abort(), { once: true });
    return stream(c, async (s) => {
      s.onAbort(() => controller.abort());
      for await (const chunk of engine.chat({
        messages: req.messages,
        workspaceId: req.workspaceId,
        llmId: req.llmId,
        agentId: req.agentId,
        signal: controller.signal,
      })) {
        if (s.aborted) break;
        await s.write(`${JSON.stringify(chunk)}\n`);
      }
    });
  });

  // --- Inspector event stream -------------------------------------------------
  app.get("/api/events", (c) => {
    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    return stream(c, async (s) => {
      const queue: string[] = [];
      let wake: (() => void) | undefined;
      const push = (line: string) => {
        queue.push(line);
        wake?.();
      };
      for (const event of engine.bus.history()) push(JSON.stringify(safeEvent(event)));
      const unsubscribe = engine.bus.subscribe((event) => push(JSON.stringify(safeEvent(event))));
      const heartbeat = setInterval(() => push(JSON.stringify({ kind: "heartbeat", ts: Date.now() })), 15_000);
      s.onAbort(() => {
        unsubscribe();
        clearInterval(heartbeat);
        wake?.();
      });
      try {
        while (!s.aborted) {
          if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
          const batch = queue.splice(0, queue.length);
          if (batch.length) await s.write(`${batch.join("\n")}\n`);
        }
      } finally {
        unsubscribe();
        clearInterval(heartbeat);
      }
    });
  });

  /** The browser reports UI traffic (MCP App JSON-RPC, A2UI actions) so it shows in the inspector. */
  app.post("/api/events/ui", async (c) => {
    const { kind, title, direction, serverId, data } = await body<any>(c);
    if (kind !== "ui.rpc" && kind !== "ui.action") return badRequest(c, "kind must be ui.rpc or ui.action");
    engine.bus.emit({
      kind,
      title: String(title ?? kind).slice(0, 200),
      direction: direction === "in" || direction === "out" ? direction : undefined,
      serverId: typeof serverId === "string" ? serverId : undefined,
      data,
    });
    return c.json({ ok: true });
  });

  app.delete("/api/events", (c) => {
    engine.bus.clear();
    return c.json({ ok: true });
  });

  // --- Sessions -------------------------------------------------------------
  app.get("/api/sessions", async (c) => c.json({ sessions: await sessions.list() }));
  app.get("/api/sessions/:id", async (c) => {
    const session = await sessions.get(c.req.param("id"));
    return session ? c.json({ session }) : c.json({ error: "Not found" }, 404);
  });
  app.put("/api/sessions/:id", async (c) => {
    const session = await body(c);
    try {
      await sessions.put({ ...session, id: c.req.param("id"), updatedAt: Date.now() });
      return c.json({ ok: true });
    } catch (error: any) {
      return badRequest(c, error?.message ?? "Invalid session");
    }
  });
  app.delete("/api/sessions/:id", async (c) => {
    await sessions.delete(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  // --- OAuth redirect (no token: the browser arrives here from the provider) --
  app.get("/oauth/callback", async (c) => {
    const { code, state, error, error_description: description } = c.req.query();
    const page = (title: string, detail: string, ok: boolean) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
          `<body style="font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#faf8f6;color:#1d1714">` +
          `<div style="text-align:center;max-width:420px"><div style="font-size:40px">${ok ? "☕" : "⚠️"}</div><h2>${escapeHtml(title)}</h2>` +
          `<p style="color:#6f6259">${escapeHtml(detail)}</p></div>` +
          `<script>try{window.opener&&window.opener.postMessage({moka:"oauth-done"},"*")}catch(e){}${ok ? "setTimeout(()=>window.close(),1200)" : ""}</script>`,
        ok ? 200 : 400,
      );
    if (error) return page("Sign-in failed", description || error, false);
    if (!code || !state) return page("Sign-in failed", "The provider didn't return a code.", false);
    try {
      const state_ = await engine.mcp.finishAuth(state, code);
      return page(`Signed in to ${state_.name}`, state_.status === "connected" ? "You can close this tab and go back to Moka." : `Connected, but: ${state_.error ?? state_.status}`, true);
    } catch (e: any) {
      return page("Sign-in failed", e?.message ?? String(e), false);
    }
  });

  // --- Static UI ------------------------------------------------------------
  if (options.webDir) {
    const webDir = path.resolve(options.webDir);
    app.get("*", async (c) => {
      const requested = decodeURIComponent(new URL(c.req.url).pathname);
      let file = path.resolve(webDir, `.${requested}`);
      if (!file.startsWith(webDir)) return c.text("Forbidden", 403);
      try {
        const info = await stat(file);
        if (info.isDirectory()) file = path.join(file, "index.html");
      } catch {
        file = path.join(webDir, "index.html");
      }
      try {
        const data = await readFile(file);
        const type = MIME[path.extname(file)] ?? "application/octet-stream";
        const immutable = requested.startsWith("/assets/");
        return c.body(data, 200, {
          "Content-Type": type,
          "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        });
      } catch {
        return c.text("Moka UI not built. Run `pnpm build`.", 404);
      }
    });
  }

  return app;
}

/** Keep the event stream light: truncate huge payloads (e.g. base64 images). */
function safeEvent<T extends { data?: unknown }>(event: T): T {
  if (event.data === undefined) return event;
  const json = JSON.stringify(event.data);
  if (json.length <= 200_000) return event;
  return { ...event, data: { truncated: true, preview: json.slice(0, 20_000), bytes: json.length } };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
