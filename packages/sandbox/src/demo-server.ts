import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { bookingFormA2ui, DICE_APP_HTML, DICE_APP_URI } from "./demo-apps.js";

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

export function createDemoServer(version: string): McpServer {
  const server = new McpServer(
    { name: "moka-demo", version },
    { instructions: "Demo tools bundled with Moka. Use them to answer questions about time, math, dice, and web pages." },
  );

  server.registerTool(
    "get_time",
    {
      title: "Current time",
      description: "Get the current date and time, optionally in a specific IANA timezone (e.g. Asia/Kolkata).",
      inputSchema: { timezone: z.string().optional().describe("IANA timezone name") },
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
      inputSchema: { expression: z.string().describe("e.g. (2 + 3) * sqrt(16)") },
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
      inputSchema: {
        sides: z.number().int().min(2).max(1000).default(6),
        count: z.number().int().min(1).max(100).default(1),
      },
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
      inputSchema: {
        url: z.string().url(),
        maxChars: z.number().int().min(100).max(50_000).default(8_000),
      },
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
      inputSchema: { count: z.number().int().min(1).max(50).default(1) },
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
      inputSchema: {
        restaurant: z.string().describe("Restaurant name"),
        partySize: z.number().int().min(1).max(12).default(2),
      },
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

  server.registerPrompt(
    "plan-a-trip",
    {
      title: "Plan a trip",
      description: "Ask the model to plan a trip using the demo tools.",
      argsSchema: { city: z.string() },
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

export async function runDemoServer(version: string): Promise<void> {
  const server = createDemoServer(version);
  await server.connect(new StdioServerTransport());
}
