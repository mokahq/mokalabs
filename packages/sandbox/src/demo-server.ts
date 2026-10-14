import { acceptedContent, inputRequired, inputResponse, McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { bookingFormA2ui, DICE_APP_HTML, DICE_APP_URI } from "./demo-apps.js";
import { EXTENSION, MIME, renderDocument, slug } from "./demo-docs.js";

/**
 * A tiny, dependency-free MCP server bundled with Moka so the very first run
 * has real tools to call. Run standalone with `moka demo-server`.
 */

/** Safe arithmetic: + - * / % ^, parentheses, unary minus, and a few functions. */
export function evaluate(expression: string): number {
  const tokens = expression.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[A-Za-z_]+|\*\*|[-+*/%^(),]/gi);
  if (!tokens || tokens.join("") !== expression.replace(/\s+/g, "")) throw new Error("Unsupported characters in expression");
  const fns: Record<string, (...n: number[]) => number> = {
    sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log, exp: Math.exp,
    min: Math.min, max: Math.max, pow: Math.pow,
  };
  const consts: Record<string, number> = { pi: Math.PI, e: Math.E };
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expect = (t: string) => {
    if (next() !== t) throw new Error(`Expected "${t}"`);
  };
  const primary = (): number => {
    const t = next();
    if (t === undefined) throw new Error("Unexpected end of expression");
    if (t === "(") {
      const v = additive();
      expect(")");
      return v;
    }
    if (t === "-") return -power();
    if (t === "+") return power();
    if (/^[\d.]/.test(t)) return Number(t);
    const name = t.toLowerCase();
    if (name in consts) return consts[name]!;
    if (name in fns) {
      expect("(");
      const args = [additive()];
      while (peek() === ",") {
        next();
        args.push(additive());
      }
      expect(")");
      return fns[name]!(...args);
    }
    throw new Error(`Unknown identifier "${t}"`);
  };
  const unary = (): number => primary();
  const power = (): number => {
    const base = unary();
    if (peek() === "^" || peek() === "**") {
      next();
      return base ** power();
    }
    return base;
  };
  const multiplicative = (): number => {
    let v = power();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = next();
      const r = power();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const additive = (): number => {
    let v = multiplicative();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const r = multiplicative();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const result = additive();
  if (i !== tokens.length) throw new Error(`Unexpected "${tokens[i]}"`);
  return result;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

const ORDER = z.object({ drink: z.string(), size: z.string(), oatMilk: z.boolean().optional(), note: z.string().optional() });

/** Where `flaky_write` keeps notes, so they survive the crash it simulates. */
const NOTES_FILE = path.join(os.tmpdir(), "moka-demo-notes.txt");
const readNotes = () => (existsSync(NOTES_FILE) ? readFileSync(NOTES_FILE, "utf8") || "(empty)" : "(empty)");
/** True when running as its own process (`moka demo-server`), so crashing is safe. */
let standalone = false;

export function createDemoServer(version: string): McpServer {
  const server = new McpServer(
    { name: "moka-demo", version },
    { instructions: "Demo tools bundled with Moka. Use them to answer questions about time, math, dice, and web pages, and to make documents (create_document)." },
  );

  server.registerTool(
    "get_time",
    {
      title: "Current time",
      description: "Get the current date and time, optionally in a specific IANA timezone (e.g. Asia/Kolkata).",
      inputSchema: z.object({ timezone: z.string().optional().describe("IANA timezone name") }),
      annotations: { readOnlyHint: true },
    },
    async ({ timezone }) => {
      const now = new Date();
      try {
        const formatted = now.toLocaleString("en-US", { timeZone: timezone || undefined, dateStyle: "full", timeStyle: "long" });
        return text(`${formatted}\nISO: ${now.toISOString()}`);
      } catch {
        return { ...text(`Unknown timezone "${timezone}"`), isError: true };
      }
    },
  );

  server.registerTool(
    "calculate",
    {
      title: "Calculator",
      description: "Evaluate an arithmetic expression. Supports + - * / % ^, parentheses, pi, e, sqrt, abs, round, floor, ceil, sin, cos, tan, log, ln, exp, min, max, pow.",
      inputSchema: z.object({ expression: z.string().describe("e.g. (2 + 3) * sqrt(16)") }),
      annotations: { readOnlyHint: true },
    },
    async ({ expression }) => {
      try {
        return text(String(evaluate(expression)));
      } catch (error) {
        return { ...text((error as Error).message), isError: true };
      }
    },
  );

  server.registerTool(
    "roll_dice",
    {
      title: "Roll dice",
      description: "Roll one or more dice. Shows an interactive dice roller (MCP App) to the user.",
      inputSchema: z.object({
        sides: z.number().int().min(2).max(1000).default(6),
        count: z.number().int().min(1).max(100).default(1),
      }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: DICE_APP_URI } },
    },
    async ({ sides, count }) => {
      const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
      return {
        ...text(`Rolled ${count}d${sides}: ${rolls.join(", ")} (total ${rolls.reduce((a, b) => a + b, 0)})`),
        structuredContent: { rolls, total: rolls.reduce((a, b) => a + b, 0) },
      };
    },
  );

  server.registerTool(
    "fetch_url",
    {
      title: "Fetch URL",
      description: "Fetch a web page or JSON endpoint and return its text content (truncated).",
      inputSchema: z.object({
        url: z.string().url(),
        maxChars: z.number().int().min(100).max(50_000).default(8_000),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url, maxChars }) => {
      if (!/^https?:\/\//i.test(url)) return { ...text("Only http(s) URLs are allowed"), isError: true };
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "moka-demo/1.0" } });
        const type = res.headers.get("content-type") ?? "";
        const raw = await res.text();
        const body = type.includes("html") ? htmlToText(raw) : raw;
        const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}\n…[truncated ${body.length - maxChars} chars]` : body;
        return text(`HTTP ${res.status} ${type}\n\n${clipped}`);
      } catch (error) {
        return { ...text(`Fetch failed: ${(error as Error).message}`), isError: true };
      }
    },
  );

  server.registerTool(
    "generate_uuid",
    {
      title: "Generate UUIDs",
      description: "Generate random v4 UUIDs.",
      inputSchema: z.object({ count: z.number().int().min(1).max(50).default(1) }),
      annotations: { readOnlyHint: true },
    },
    async ({ count }) => text(Array.from({ length: count }, () => randomUUID()).join("\n")),
  );

  server.registerResource(
    "dice-app",
    DICE_APP_URI,
    { title: "Dice roller", description: "MCP App UI for roll_dice", mimeType: "text/html;profile=mcp-app" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/html;profile=mcp-app", text: DICE_APP_HTML, _meta: { ui: { prefersBorder: true } } }],
    }),
  );

  server.registerTool(
    "book_table",
    {
      title: "Book a table",
      description: "Start a restaurant booking. Shows the user a booking form (A2UI); their confirmation comes back as a [ui action] message.",
      inputSchema: z.object({
        restaurant: z.string().describe("Restaurant name"),
        partySize: z.number().int().min(1).max(12).default(2),
      }),
    },
    async ({ restaurant, partySize }) => ({
      content: [
        { type: "text", text: `Showing a booking form for ${restaurant} (party of ${partySize}).` },
        {
          type: "resource",
          resource: { uri: "a2ui://moka-demo/booking", mimeType: "application/json+a2ui", text: JSON.stringify(bookingFormA2ui(restaurant, partySize)) },
        },
      ],
    }),
  );

  server.registerTool(
    "order_coffee",
    {
      title: "Order a coffee",
      description: "Order a coffee for the user. Asks the user directly for their drink, size and milk (MCP elicitation), so don't ask them yourself.",
      inputSchema: z.object({ name: z.string().optional().describe("Who the coffee is for") }),
    },
    // Written once in the 2026-07-28 style: return `input_required`, read the
    // answer when the client calls again. On 2025 connections the SDK sends a
    // real elicitation/create request instead and calls this handler again.
    async ({ name }, ctx) => {
      const answer = inputResponse(ctx.mcpReq.inputResponses, "order");
      if (answer.kind === "missing") {
        return inputRequired({
          inputRequests: {
            order: inputRequired.elicit({
              message: `What can we get you${name ? `, ${name}` : ""}? ☕`,
              requestedSchema: {
                type: "object",
                properties: {
                  drink: { type: "string", title: "Drink", enum: ["espresso", "flat white", "cappuccino", "cold brew"] },
                  size: { type: "string", title: "Size", enum: ["small", "medium", "large"], default: "medium" },
                  oatMilk: { type: "boolean", title: "Oat milk", default: false },
                  note: { type: "string", title: "Note for the barista" },
                },
                required: ["drink", "size"],
              },
            }),
          },
        });
      }
      if (answer.kind === "elicit" && answer.action !== "accept") return text(`The user ${answer.action === "decline" ? "declined" : "cancelled"} the order.`);
      const c = acceptedContent(ctx.mcpReq.inputResponses, "order", ORDER);
      if (!c) return { ...text("The order form came back incomplete."), isError: true };
      return text(`Order placed: ${c.size} ${c.drink}${c.oatMilk ? " with oat milk" : ""}${c.note ? ` (note: ${c.note})` : ""}. Ready in 4 minutes.`);
    },
  );

  server.registerTool(
    "brainstorm",
    {
      title: "Brainstorm with the host's model",
      description: "Brainstorm three short ideas about a topic. The server borrows the client's model through MCP sampling.",
      inputSchema: z.object({ topic: z.string().describe("What to brainstorm about") }),
    },
    // MCP sampling, 2026-07-28 style: ask for a completion in the result, and
    // get it back in the retried call. 2025 clients get sampling/createMessage.
    async ({ topic }, ctx) => {
      const ideas = inputResponse(ctx.mcpReq.inputResponses, "ideas");
      if (ideas.kind === "missing") {
        return inputRequired({
          inputRequests: {
            ideas: inputRequired.createMessage({
              systemPrompt: "You are a playful brainstorming partner. Reply with exactly three short bullet points.",
              messages: [{ role: "user", content: { type: "text", text: `Three ideas for: ${topic}` } }],
              maxTokens: 200,
            }),
          },
        });
      }
      if (ideas.kind !== "sampling") return { ...text("Sampling failed: the client didn't return a completion."), isError: true };
      const block = Array.isArray(ideas.result.content) ? ideas.result.content[0] : ideas.result.content;
      return text(`Ideas from ${ideas.result.model}:\n${block?.type === "text" ? block.text : "(non-text reply)"}`);
    },
  );

  server.registerTool(
    "slow_backtest",
    {
      title: "Backtest a strategy (slow)",
      description:
        "Backtest a simple trading strategy on historical prices (simulated). Takes about 90 seconds and reports progress every second: use it to test long-running tools, progress bars and client timeouts.",
      inputSchema: z.object({
        symbol: z.string().default("AAPL").describe("Ticker to backtest"),
        years: z.number().int().min(1).max(20).default(5).describe("Years of history to replay"),
        seconds: z.number().int().min(1).max(300).default(90).describe("How long the simulation takes"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ symbol, years, seconds }, ctx) => {
      const token = ctx.mcpReq._meta?.progressToken;
      for (let s = 1; s <= seconds; s++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (ctx.mcpReq.signal.aborted) return text("Backtest cancelled.");
        if (token !== undefined) {
          const year = new Date().getFullYear() - years + Math.min(years - 1, Math.floor((s / seconds) * years));
          await ctx.mcpReq
            .notify({ method: "notifications/progress", params: { progressToken: token, progress: s, total: seconds, message: `Replaying ${symbol} ${year}` } })
            .catch(() => {});
        }
      }
      // Deterministic, made-up results so demos are repeatable.
      const seed = [...symbol.toUpperCase()].reduce((n, c) => n + c.charCodeAt(0), years);
      const cagr = ((seed % 190) / 10 - 4).toFixed(1);
      const drawdown = (8 + (seed % 23)).toFixed(0);
      const trades = 40 + (seed % 160) * years;
      return text(`Backtest of ${symbol.toUpperCase()} over ${years} years (simulated): ${cagr}% a year, worst drawdown -${drawdown}%, ${trades} trades.`);
    },
  );

  server.registerTool(
    "flaky_write",
    {
      title: "Save a note (flaky)",
      description:
        "Save a note to the demo notebook. For testing interrupted calls: the server writes the note, then crashes before it can reply, like a flaky backend. If it fails, call read_notes to check whether the note was saved before retrying, so you don't save it twice.",
      inputSchema: z.object({ note: z.string().describe("The note to save") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ note }) => {
      appendFileSync(NOTES_FILE, `${new Date().toISOString()}  ${note}\n`);
      // The write happened; the reply never will.
      if (standalone) setTimeout(() => process.exit(1), 50);
      else setTimeout(() => void server.close(), 50);
      return new Promise<never>(() => {});
    },
  );

  server.registerTool(
    "read_notes",
    {
      title: "Read the notebook",
      description: "List the notes saved in the demo notebook (by flaky_write). Use it to check whether a save went through.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: "text", text: readNotes() }] }),
  );

  server.registerTool(
    "create_document",
    {
      title: "Create a document",
      description:
        "Write a document (PDF, Word .docx, HTML page or Markdown) from a title, sections and an optional table, and give it to the user. Moka opens it next to the chat. In a section body, lines starting with \"- \" are bullet points; a blank line starts a new paragraph.",
      inputSchema: z.object({
        title: z.string().describe("Document title"),
        subtitle: z.string().optional().describe("One line under the title"),
        format: z.enum(["pdf", "docx", "html", "markdown"]).default("pdf").describe("File type (default pdf)"),
        sections: z
          .array(z.object({ heading: z.string().optional(), body: z.string().describe("Paragraphs, and bullet points as lines starting with \"- \"") }))
          .describe("The document's sections, in order"),
        table: z
          .object({ columns: z.array(z.string()), rows: z.array(z.array(z.string())) })
          .optional()
          .describe("An optional table at the end, e.g. a comparison"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ title, subtitle, format, sections, table }) => {
      const file = `${slug(title)}.${EXTENSION[format]}`;
      const rendered = renderDocument({ title, subtitle, sections, ...(table ? { table } : {}) }, format);
      const uri = `moka://documents/${file}`;
      const size = rendered.bytes?.length ?? Buffer.byteLength(rendered.text ?? "");
      return {
        content: [
          { type: "text" as const, text: `Created ${file} (${Math.max(1, Math.round(size / 1024))} KB). The user can see it now.` },
          {
            type: "resource" as const,
            resource: rendered.bytes ? { uri, mimeType: MIME[format], blob: Buffer.from(rendered.bytes).toString("base64") } : { uri, mimeType: MIME[format], text: rendered.text! },
          },
        ],
      };
    },
  );

  server.registerResource(
    "notes",
    "moka://notes",
    { title: "Demo notebook", description: "Notes saved by flaky_write (kept across server restarts)", mimeType: "text/plain" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: readNotes() }],
    }),
  );

  server.registerResource(
    "about",
    "moka://about",
    { title: "About Moka", description: "What this demo server is", mimeType: "text/markdown" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: "# Moka demo server\n\nA built-in MCP server so you can try tool calling instantly. Add your own servers in Settings → MCP.",
        },
      ],
    }),
  );

  // A live resource that changes every few seconds, for trying subscriptions.
  const BREW_URI = "moka://brew/status";
  const stages = ["grinding beans", "blooming", "pouring", "steeping", "ready ☕"];
  let tick = 0;
  const brewStatus = () => {
    const stage = stages[tick % stages.length]!;
    return JSON.stringify({ stage, cup: Math.floor(tick / stages.length) + 1, temperatureC: 88 + (tick % 5), updatedAt: new Date().toISOString() }, null, 2);
  };
  server.registerResource(
    "brew-status",
    BREW_URI,
    { title: "Live brew status", description: "Changes every 3 seconds. Subscribe to watch it update.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: brewStatus() }] }),
  );
  const subscribed = new Set<string>();
  server.server.registerCapabilities({ resources: { subscribe: true, listChanged: true } });
  server.server.setRequestHandler("resources/subscribe", async (request) => {
    subscribed.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler("resources/unsubscribe", async (request) => {
    subscribed.delete(request.params.uri);
    return {};
  });
  const timer = setInterval(() => {
    tick++;
    // 2025: only after resources/subscribe. 2026-07-28: the SDK delivers it to
    // subscriptions/listen streams that asked for this URI.
    const modern = (server.server.getNegotiatedProtocolVersion() ?? "") >= "2026-07-28";
    if (modern || subscribed.has(BREW_URI)) void server.server.sendResourceUpdated({ uri: BREW_URI }).catch(() => {});
  }, 3000);
  timer.unref();

  // A resource template: one resource per drink.
  const DRINKS: Record<string, { caffeineMg: number; milk: boolean; note: string }> = {
    espresso: { caffeineMg: 63, milk: false, note: "Short and intense." },
    "flat-white": { caffeineMg: 130, milk: true, note: "Velvety microfoam." },
    cappuccino: { caffeineMg: 130, milk: true, note: "Equal parts espresso, milk and foam." },
    "cold-brew": { caffeineMg: 200, milk: false, note: "Steeped 16 hours." },
  };
  server.registerResource(
    "drink",
    new ResourceTemplate("moka://drinks/{drink}", {
      list: async () => ({ resources: Object.keys(DRINKS).map((d) => ({ uri: `moka://drinks/${d}`, name: d, title: `Drink: ${d}` })) }),
      complete: { drink: (value) => Object.keys(DRINKS).filter((d) => d.startsWith(value)) },
    }),
    { title: "Coffee drinks", description: "Details for a drink, e.g. moka://drinks/espresso", mimeType: "application/json" },
    async (uri, { drink }) => {
      const info = DRINKS[String(drink)];
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(info ? { drink, ...info } : { error: `Unknown drink "${drink}". Try: ${Object.keys(DRINKS).join(", ")}` }, null, 2) }] };
    },
  );

  server.registerPrompt(
    "plan-a-trip",
    {
      title: "Plan a trip",
      description: "Ask the model to plan a trip using the demo tools.",
      argsSchema: z.object({ city: z.string() }),
    },
    ({ city }) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `What time is it in ${city} right now, and roll a d20 to pick how many hours I should spend exploring.` },
        },
      ],
    }),
  );

  return server;
}

/** Serves MCP 2026-07-28 and, for older clients, 2025-11-25 on stdio. */
export async function runDemoServer(version: string): Promise<void> {
  standalone = true;
  serveStdio(() => createDemoServer(version));
}
