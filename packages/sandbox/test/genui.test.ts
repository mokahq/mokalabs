import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSandbox, type RunningSandbox } from "../src/index.js";
import { startFakeLlm } from "./fake-llm.js";

let sandbox: RunningSandbox;
let base: string;
const fakes: Array<Awaited<ReturnType<typeof startFakeLlm>>> = [];
const TOKEN = "t";

async function call(pathname: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { "x-moka-token": TOKEN, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) };
}

const chunksOf = (text: string) => text.trim().split("\n").map((l) => JSON.parse(l));

async function addModel(id: string, tool: string, args: Record<string, unknown>) {
  const fake = await startFakeLlm(tool, args);
  fakes.push(fake);
  const config = (await call("/api/bootstrap")).json().config;
  config.llms.push({ id, name: id, provider: "openai-compatible", model: "m", baseURL: fake.baseURL });
  await call("/api/config", { method: "PUT", body: config });
  return fake;
}

async function patchConfig(fn: (config: any) => void) {
  const config = (await call("/api/bootstrap")).json().config;
  fn(config);
  const res = await call("/api/config", { method: "PUT", body: config });
  expect(res.status).toBe(200);
}

const CATALOG = {
  name: "Banking",
  instructions: "Use AccountCard for balances.",
  components: {
    AccountCard: {
      description: "An account balance",
      props: { name: { type: "string" }, balance: { type: "string" } },
      required: ["name", "balance"],
      template: [
        { id: "root", component: "Card", child: "t" },
        { id: "t", component: "Text", text: "{{name}}: {{balance}}" },
      ],
    },
    Gauge: { props: { value: { type: "number" } }, html: "<div id=g></div>" },
  },
};

beforeAll(async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "moka-genui-"));
  const configPath = path.join(home, "moka.json");
  writeFileSync(path.join(home, "banking.json"), JSON.stringify(CATALOG));
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      llms: [],
      catalogs: [{ id: "banking", path: "banking.json" }],
      mcpServers: [{ id: "moka-demo", name: "Demo", transport: "stdio", command: "moka:demo" }],
      workspaces: [
        {
          id: "w",
          name: "W",
          mcpServerIds: ["moka-demo"],
          skillIds: [],
          generativeUi: { toolName: "show_ui", catalogIds: ["banking"], deny: ["Slider"], theme: { primaryColor: "#0a5cff" }, instructions: "Be visual." },
        },
      ],
    }),
  );
  sandbox = await startSandbox({ port: 0, configPath, token: TOKEN, env: { ...process.env, MOKA_HOME: home }, ui: false });
  base = `http://127.0.0.1:${sandbox.port}`;
}, 30_000);

afterAll(async () => {
  await sandbox?.close();
  await Promise.all(fakes.map((f) => f.close()));
});

describe("catalogs", () => {
  it("lists the standard catalog and loads file catalogs", async () => {
    const { catalogs } = (await call("/api/catalogs")).json();
    expect(catalogs.map((c: any) => c.id)).toEqual(["standard", "banking"]);
    expect(Object.keys(catalogs[1].components)).toEqual(["AccountCard", "Gauge"]);
    const boot = (await call("/api/bootstrap")).json();
    expect(boot.catalogs).toHaveLength(2);
    expect(boot.interactions).toEqual([]);
  });

  it("previews draft catalogs and reports errors", async () => {
    const ok = (await call("/api/catalogs/preview", { body: { catalog: { id: "x", catalog: CATALOG } } })).json();
    expect(ok.catalog.error).toBeUndefined();
    const bad = (await call("/api/catalogs/preview", { body: { catalog: { id: "x", path: "missing.json" } } })).json();
    expect(bad.catalog.error).toBeTruthy();
  });

  it("describes the workspace's render tool", async () => {
    const tool = (await call("/api/ui/tool?workspaceId=w")).json();
    expect(tool.name).toBe("show_ui");
    expect(tool.components).toContain("AccountCard");
    expect(tool.components).not.toContain("Slider");
    expect(tool.description).toContain("Use AccountCard for balances.");
    expect(tool.description).toContain("Be visual.");
  });

  it("previews UI JSON and single components", async () => {
    const good = (await call("/api/ui/preview", { body: { workspaceId: "w", input: { components: [{ id: "root", component: "AccountCard", name: "Main", balance: "$1" }] } } })).json();
    expect(good.problems).toEqual([]);
    expect(good.messages[0].createSurface.theme.primaryColor).toBe("#0a5cff");
    expect(good.messages[1].updateComponents.components[1].text).toBe("Main: $1");
    const bad = (await call("/api/ui/preview", { body: { workspaceId: "w", input: { components: [{ id: "root", component: "Slider" }] } } })).json();
    expect(bad.problems[0]).toMatch(/unknown component "Slider"/);
    const single = (await call("/api/ui/preview", { body: { component: { catalogId: "banking", name: "Gauge" } } })).json();
    expect(single.messages[1].updateComponents.components[0]).toMatchObject({ component: "MokaHtml", name: "Gauge" });
  });
});

describe("render tool in chat", () => {
  it("uses the custom tool name, expands catalog components and themes the surface", async () => {
    const fake = await addModel("cat", "show_ui", { components: [{ id: "root", component: "AccountCard", name: "Savings", balance: "$9" }] });
    await patchConfig((c) => (c.workspaces[0].llmId = "cat"));
    const chunks = chunksOf((await call("/api/chat", { body: { messages: [{ role: "user", content: "balance?" }] } })).text);
    const result = chunks.find((c) => c.type === "tool-result");
    expect(result.isError).toBe(false);
    expect(result.ui.messages[0].createSurface.theme.primaryColor).toBe("#0a5cff");
    expect(result.ui.messages[1].updateComponents.components.map((c: any) => c.component)).toEqual(["Card", "Text"]);
    const tools = fake.requests[0].tools.map((t: any) => t.function);
    const show = tools.find((t: any) => t.name === "show_ui");
    expect(show.parameters.properties.components.items.properties.component.enum).toContain("AccountCard");
    expect(tools.some((t: any) => t.name === "render_ui")).toBe(false);
  }, 30_000);

  it("sends validation problems back to the model", async () => {
    await addModel("badcat", "show_ui", { components: [{ id: "root", component: "AccountCard", name: "x" }] });
    const chunks = chunksOf((await call("/api/chat", { body: { llmId: "badcat", messages: [{ role: "user", content: "x" }] } })).text);
    const result = chunks.find((c) => c.type === "tool-result");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/missing required prop "balance"/);
    expect(result.output).toMatch(/call show_ui again/);
  }, 30_000);
});

describe("tool approvals", () => {
  async function chatAndAnswer(answer: Record<string, unknown> | "abort") {
    const controller = new AbortController();
    const chat = fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "x-moka-token": TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ llmId: "calc", messages: [{ role: "user", content: "6*7" }] }),
      signal: controller.signal,
    }).then((r) => r.text());
    let pending: any[] = [];
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      pending = (await call("/api/interactions")).json().interactions;
    }
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "tool-approval", serverId: "moka-demo", tool: "calculate", input: { expression: "6*7" } });
    if (answer === "abort") {
      controller.abort();
      await chat.catch(() => {});
      return { pending, chunks: [] };
    }
    expect((await call(`/api/interactions/${pending[0].id}`, { body: { response: answer } })).status).toBe(200);
    return { pending, chunks: chunksOf(await chat) };
  }

  it("waits for approval when the server asks", async () => {
    await addModel("calc", "moka-demo__calculate", { expression: "6*7" });
    await patchConfig((c) => (c.mcpServers[0].approval = { default: "ask" }));
    const { chunks } = await chatAndAnswer({ approved: true });
    expect(chunks.find((c) => c.type === "tool-result")).toMatchObject({ output: "42", isError: false });
    const kinds = sandbox.engine.bus.history().map((e) => e.kind);
    expect(kinds).toContain("interaction.request");
    expect(kinds).toContain("interaction.resolved");
  }, 30_000);

  it("tells the model when the user declines", async () => {
    const { chunks } = await chatAndAnswer({ approved: false });
    const result = chunks.find((c) => c.type === "tool-result");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/declined/);
  }, 30_000);

  it("cancels pending approvals when the chat is aborted", async () => {
    await chatAndAnswer("abort");
    for (let i = 0; i < 40; i++) {
      if ((await call("/api/interactions")).json().interactions.length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await call("/api/interactions")).json().interactions).toEqual([]);
  }, 30_000);

  it("remembers 'always' in the config", async () => {
    await chatAndAnswer({ approved: true, remember: "always" });
    const config = (await call("/api/bootstrap")).json().config;
    expect(config.mcpServers[0].approval).toEqual({ default: "ask", tools: { calculate: "auto" } });
    const chunks = chunksOf((await call("/api/chat", { body: { llmId: "calc", messages: [{ role: "user", content: "6*7" }] } })).text);
    expect(chunks.find((c) => c.type === "tool-result")).toMatchObject({ output: "42" });
  }, 30_000);

  it("rejects answers to unknown requests", async () => {
    expect((await call("/api/interactions/nope", { body: { response: { approved: true } } })).status).toBe(404);
  });
});
