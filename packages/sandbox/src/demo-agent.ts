import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny agent that speaks both A2A (JSON-RPC + SSE) and AG-UI (SSE), so you
 * can try Moka's agent mode without writing one: `moka demo-agent`.
 *
 * - "book" / "form" → replies with an A2UI booking form; pressing the button
 *   comes back as an A2UI action and the agent confirms the booking.
 * - AG-UI: if Moka shares its tools, "time" → calls the time tool as a
 *   frontend tool and uses the result.
 * - Anything else is echoed back, word by word.
 */

const A2UI_EXTENSION = "https://a2ui.org/a2a-extension/a2ui/v0.8";

function bookingForm(): Record<string, any>[] {
  const surfaceId = "demo-booking";
  return [
    { version: "v0.9", createSurface: { surfaceId, catalogId: "https://a2ui.org/specification/v0_9/standard_catalog.json" } },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId,
        components: [
          { id: "root", component: "Card", child: "col" },
          { id: "col", component: "Column", children: ["title", "when", "size", "go"] },
          { id: "title", component: "Text", text: "Book a coffee tasting ☕", variant: "h3" },
          { id: "when", component: "DateTimeInput", label: "When", value: { path: "/when" }, enableDate: true, enableTime: true },
          { id: "size", component: "ChoicePicker", label: "Guests", value: { path: "/guests" }, options: [1, 2, 3, 4].map((n) => ({ label: String(n), value: n })) },
          { id: "go-label", component: "Text", text: "Book it" },
          { id: "go", component: "Button", variant: "primary", child: "go-label", action: { event: { name: "book_tasting", context: { when: { path: "/when" }, guests: { path: "/guests" } } } } },
        ],
      },
    },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: { when: "", guests: 2 } } },
  ];
}

function reply(text: string): { text: string; ui?: Record<string, any>[] } {
  if (/\b(book|booking|form|reserve)\b/i.test(text)) return { text: "Here's a booking form. Pick a time and I'll reserve it.", ui: bookingForm() };
  return { text: `You said: "${text.slice(0, 200)}". I'm the Moka demo agent. Ask me to *book a tasting* to see A2UI.` };
}

function actionReply(action: any): string {
  const ctx = action?.context ?? {};
  return `Booked ✅ ${ctx.guests ?? "?"} guest(s)${ctx.when ? ` on ${String(ctx.when).replace("T", " at ")}` : ""}. See you there!`;
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function sse(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  return (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ A2A */

async function handleA2a(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rpc = await readJson(req);
  const message = rpc.params?.message ?? {};
  const contextId = message.contextId ?? randomUUID();
  const taskId = randomUUID();
  const parts: any[] = message.parts ?? [];
  const action = parts.find((p) => p.kind === "data")?.data;
  const userText = parts.filter((p) => p.kind === "text").map((p) => p.text).join(" ");
  const answer = action?.action || action?.userAction ? { text: actionReply(action.action ?? action.userAction) } : reply(userText);
  const agentMessage = (extra: any[] = []) => ({
    kind: "message",
    role: "agent",
    messageId: randomUUID(),
    contextId,
    taskId,
    parts: [{ kind: "text", text: answer.text }, ...extra],
  });
  const uiParts = (answer.ui ?? []).map((m) => ({ kind: "data", data: m, metadata: { mimeType: "application/json+a2ui" } }));

  if (rpc.method === "message/send") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: agentMessage(uiParts) }));
    return;
  }
  if (rpc.method !== "message/stream") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } }));
    return;
  }
  const send = sse(res);
  const out = (result: unknown) => send({ jsonrpc: "2.0", id: rpc.id, result });
  out({ kind: "task", id: taskId, contextId, status: { state: "submitted" } });
  out({ kind: "status-update", taskId, contextId, status: { state: "working" }, final: false });
  const words = answer.text.split(/(?<= )/);
  for (let i = 0; i < words.length; i++) {
    out({ kind: "artifact-update", taskId, contextId, append: i > 0, lastChunk: i === words.length - 1, artifact: { artifactId: "answer", parts: [{ kind: "text", text: words[i] }] } });
    await pause(15);
  }
  if (uiParts.length) out({ kind: "artifact-update", taskId, contextId, artifact: { artifactId: "ui", parts: uiParts } });
  out({ kind: "status-update", taskId, contextId, status: { state: "completed" }, final: true });
  res.end();
}

function agentCard(origin: string) {
  return {
    protocolVersion: "0.3.0",
    name: "Moka demo agent",
    description: "Echoes messages and books coffee tastings with an A2UI form.",
    url: `${origin}/a2a`,
    version: "1.0.0",
    capabilities: { streaming: true, extensions: [{ uri: A2UI_EXTENSION, description: "Renders A2UI surfaces" }] },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json+a2ui"],
    skills: [
      { id: "echo", name: "Echo", description: "Repeats what you say", tags: ["demo"], examples: ["hello"] },
      { id: "book", name: "Book a tasting", description: "Shows an A2UI booking form", tags: ["a2ui"], examples: ["book a coffee tasting"] },
    ],
  };
}

/* ------------------------------------------------------------------ AG-UI */

async function handleAgui(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const input = await readJson(req);
  const send = sse(res);
  const messages: any[] = input.messages ?? [];
  const tools: any[] = input.tools ?? [];
  const last = messages.at(-1);
  const turns = Number(input.state?.turns ?? 0) + 1;
  send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
  send({ type: "STATE_SNAPSHOT", snapshot: { ...(input.state ?? {}), turns } });

  const say = async (text: string) => {
    const messageId = randomUUID();
    send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
    for (const word of text.split(/(?<= )/)) {
      send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: word });
      await pause(15);
    }
    send({ type: "TEXT_MESSAGE_END", messageId });
  };

  if (last?.role === "tool") {
    await say(`The tool answered: ${String(last.content).split("\n")[0]}`);
  } else {
    const text = String(last?.content ?? "");
    const action = /^\[ui action\]/.test(text) ? JSON.parse(text.replace(/^\[ui action\]\s*/, "")) : undefined;
    const timeTool = tools.find((t) => /time/i.test(t.name));
    if (action) {
      await say(actionReply(action));
    } else if (/\btime\b/i.test(text) && timeTool) {
      const toolCallId = randomUUID();
      send({ type: "STEP_STARTED", stepName: "check the clock" });
      send({ type: "TOOL_CALL_START", toolCallId, toolCallName: timeTool.name });
      send({ type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify({ timezone: "Asia/Tokyo" }) });
      send({ type: "TOOL_CALL_END", toolCallId });
      send({ type: "STEP_FINISHED", stepName: "check the clock" });
    } else {
      const answer = reply(text);
      await say(answer.text);
      if (answer.ui) send({ type: "CUSTOM", name: "a2ui", value: answer.ui });
    }
  }
  send({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
  res.end();
}

/* ------------------------------------------------------------------ server */

export interface DemoAgent {
  origin: string;
  a2aUrl: string;
  aguiUrl: string;
  close: () => Promise<void>;
}

export async function startDemoAgent(port = 0, host = "127.0.0.1"): Promise<DemoAgent> {
  let origin = "";
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", origin);
      if (req.method === "GET" && (url.pathname === "/.well-known/agent-card.json" || url.pathname === "/.well-known/agent.json")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(agentCard(origin)));
      } else if (req.method === "POST" && url.pathname === "/a2a") await handleA2a(req, res);
      else if (req.method === "POST" && url.pathname === "/agui") await handleAgui(req, res);
      else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Moka demo agent: POST /a2a (A2A) or /agui (AG-UI), GET /.well-known/agent-card.json");
      }
    } catch (error: any) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error?.message ?? error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address() as AddressInfo;
  origin = `http://${host === "0.0.0.0" ? "localhost" : host}:${address.port}`;
  return {
    origin,
    a2aUrl: `${origin}/.well-known/agent-card.json`,
    aguiUrl: `${origin}/agui`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
