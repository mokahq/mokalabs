import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSandbox, type RunningSandbox } from "../src/index.js";

// The Search button: web_search and web_fetch only when it's on, against a SearXNG-style server.
let sandbox: RunningSandbox;
let web: Server;
let llm: Server;
let webBase: string;
const requests: any[] = [];

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  web = createServer((req, res) => {
    if (req.url?.startsWith("/search")) {
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify({ results: [{ title: "Moka 0.6.1 released", url: `${webBase}/news`, content: "Background replies and web search." }] }));
    }
    res.setHeader("content-type", "text/html");
    res.end("<html><title>Moka news</title><body><nav>menu</nav><main><h1>Moka 0.6.1</h1><p>Web search is built in.</p></main></body></html>");
  });
  webBase = await listen(web);

  // Step 1 searches, step 2 reads the first result, step 3 answers.
  llm = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    const base = { id: "c", object: "chat.completion.chunk", created: 0, model: body.model };
    const send = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    res.setHeader("content-type", "text/event-stream");
    const tools = body.messages.filter((m: any) => m.role === "tool").length;
    const names = (body.tools ?? []).map((t: any) => t.function.name);
    if (names.includes("web_search") && tools === 0) {
      send({ role: "assistant", tool_calls: [{ index: 0, id: "s1", type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: "moka release" }) } }] });
      send({}, "tool_calls");
    } else if (names.includes("web_fetch") && tools === 1) {
      send({ role: "assistant", tool_calls: [{ index: 0, id: "f1", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: `${webBase}/news` }) } }] });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", content: names.length ? "Done." : "No tools." });
      send({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  const llmBase = await listen(llm);

  const home = mkdtempSync(path.join(os.tmpdir(), "moka-web-"));
  const configPath = path.join(home, "moka.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      llms: [{ id: "fake", name: "Fake", provider: "openai-compatible", model: "fake-1", baseURL: `${llmBase}/v1` }],
      workspaces: [{ id: "w", name: "W", llmId: "fake", mcpServerIds: [], skillIds: [], generativeUi: false }],
      webSearch: { provider: "searxng", url: webBase, maxResults: 3 },
    }),
  );
  sandbox = await startSandbox({ port: 0, configPath, token: "t", env: { ...process.env, MOKA_HOME: home }, ui: false });
}, 30_000);

afterAll(async () => {
  await sandbox?.close();
  web?.close();
  llm?.close();
});

async function chat(body: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${sandbox.port}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-moka-token": "t" },
    body: JSON.stringify({ messages: [{ role: "user", content: "What's new in Moka?" }], ...body }),
  });
  return (await res.text()).trim().split("\n").map((line) => JSON.parse(line));
}

describe("web search", () => {
  it("gives the model no web tools when the Search button is off", async () => {
    requests.length = 0;
    const chunks = await chat({});
    expect(requests[0].tools ?? []).toEqual([]);
    expect(chunks.filter((c) => c.type === "text").map((c) => c.text).join("")).toBe("No tools.");
  });

  it("searches and reads a page when it's on", async () => {
    requests.length = 0;
    const chunks = await chat({ webSearch: true });
    expect(requests[0].tools.map((t: any) => t.function.name)).toEqual(["web_search", "web_fetch"]);
    expect(requests[0].messages[0].content).toContain("## Web search");

    const results = chunks.filter((c) => c.type === "tool-result");
    expect(results[0].output).toBe(`1. Moka 0.6.1 released\n   ${webBase}/news\n   Background replies and web search.`);
    expect(results[0].isError).toBe(false);
    expect(results[1].output).toBe(`# Moka news\n${webBase}/news\n\n# Moka 0.6.1\nWeb search is built in.`);
    expect(chunks.find((c) => c.type === "tool-call")).toMatchObject({ tool: "web_search", source: "Web search" });
    expect(chunks.at(-1).type).toBe("finish");
  });
});
