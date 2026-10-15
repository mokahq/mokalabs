import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServerConfig } from "./config.js";
import type { McpTool } from "./mcp.js";

/**
 * A security check for MCP servers, on what the model reads: tool
 * descriptions, parameter descriptions, server instructions and prompts.
 *
 * - Tool poisoning: hidden instructions ("don't tell the user", <IMPORTANT>
 *   tags), invisible characters, requests for secrets or to send data away.
 * - Shadowing: two servers with tools of the same name, or a tool that talks
 *   about another server's tools.
 * - Changes ("rug pulls"): a tool's description or schema changed since you
 *   first connected. Moka remembers what each tool looked like (tool-pins.json)
 *   until you trust the new version.
 */

export type Severity = "high" | "medium" | "info";

export interface SecurityFinding {
  id: string;
  severity: Severity;
  title: string;
  /** Why it matters, in a sentence. */
  detail: string;
  /** Where: a tool, "instructions", or a prompt. */
  where: string;
  /** The text around the match, with the match itself. */
  evidence?: { before: string; match: string; after: string };
}

export interface ToolChange {
  tool: string;
  kind: "changed" | "added" | "removed";
  /** When the trusted version was first seen. */
  since?: number;
  before?: { description?: string; schema?: string };
  after?: { description?: string; schema?: string };
}

export interface ServerSecurity {
  serverId: string;
  name: string;
  findings: SecurityFinding[];
  changes: ToolChange[];
}

interface Rule {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  {
    id: "override",
    severity: "high",
    title: "Tries to override the model's instructions",
    detail: "Text like this in a tool definition is a classic prompt injection: every client that loads the server sends it to the model.",
    pattern: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|other|system|user'?s?)\b[^.\n]{0,25}\b(instructions?|prompts?|rules|directions)\b/i,
  },
  {
    id: "conceal",
    severity: "high",
    title: "Asks the model to hide something from the user",
    detail: "Legitimate tools have no reason to keep their actions from the user.",
    pattern: /\b(do not|don't|never|without)\b[^.\n]{0,30}\b(tell|telling|mention|mentioning|inform|informing|show|showing|reveal|revealing|notify|notifying|alert|alerting)\b[^.\n]{0,30}\b(the user|users|the human)\b/i,
  },
  {
    id: "hidden-tag",
    severity: "high",
    title: "Hidden-instruction tag",
    detail: "Tags like <IMPORTANT> or <system> in a description are a common tool-poisoning trick to make the model treat text as orders.",
    pattern: /<\s*\/?\s*(important|system|instructions?|secret|hidden|admin|override)\s*>/i,
  },
  {
    id: "secrets",
    severity: "high",
    title: "Mentions credentials or secret files",
    detail: "A tool definition that points the model at keys or credential files may be trying to read and leak them.",
    pattern: /(~\/\.ssh|\.ssh\/|\bid_(rsa|ed25519|ecdsa)\b|\.aws\/credentials|\.npmrc|\.netrc|\.pgpass|\bwallet\.dat\b|\bkeychain\b|\bprivate[ _-]key\b|\bmcp\.json\b|claude_desktop_config\.json|\.env\b(?!ironment))/i,
  },
  {
    id: "exfiltrate",
    severity: "medium",
    title: "Asks the model to send data somewhere",
    detail: "Check where it sends what, and whether that's what the tool is for.",
    pattern: /\b(send|post|upload|forward|transmit|exfiltrat\w*|leak)\b[^.\n]{0,60}(https?:\/\/|\bwebhook\b|\bpastebin\b|\b\S+@\S+\.\w+)/i,
  },
  {
    id: "steer",
    severity: "medium",
    title: "Tries to steer the model's other tool calls",
    detail: "A tool that tells the model how to use other tools can redirect what the agent does.",
    pattern: /(\b(before|instead of|rather than)\b[^.\n]{0,25}\b(using|calling|invoking)\b[^.\n]{0,20}\b(any|other|another)\b[^.\n]{0,15}\b(tools?|functions?)\b)|(\balways\b[^.\n]{0,10}\b(call|use|run)\b[^.\n]{0,15}\bthis tool\b[^.\n]{0,15}\b(first|before)\b)/i,
  },
  {
    id: "self",
    severity: "medium",
    title: "Talks about the model's own instructions",
    detail: "Tool definitions rarely need to mention the system prompt; this is often a sign of prompt injection.",
    pattern: /\b(system prompt|your (system )?instructions|developer message|you are now (an?|the)\b|act as (an?|the) (admin|root|system))\b/i,
  },
];

/** Zero-width characters, bidi controls and Unicode "tag" characters can hide text from people but not from models. */
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{e0000}-\u{e007f}]/u;
const LONG_DESCRIPTION = 4000;

function evidence(text: string, index: number, length: number): SecurityFinding["evidence"] {
  const clean = (s: string) => s.replace(/\s+/g, " ");
  return {
    before: clean(text.slice(Math.max(0, index - 60), index)),
    match: clean(text.slice(index, index + length)),
    after: clean(text.slice(index + length, index + length + 60)),
  };
}

/** Every description in a JSON schema, with its path (for parameters). */
function schemaTexts(schema: unknown, at = "", out: Array<{ where: string; text: string }> = []): Array<{ where: string; text: string }> {
  if (!schema || typeof schema !== "object") return out;
  const s = schema as Record<string, any>;
  if (typeof s.description === "string" && at) out.push({ where: at, text: s.description });
  if (typeof s.title === "string" && at) out.push({ where: at, text: s.title });
  for (const [key, value] of Object.entries(s.properties ?? {})) schemaTexts(value, at ? `${at}.${key}` : key, out);
  if (s.items) schemaTexts(s.items, `${at}[]`, out);
  for (const k of ["anyOf", "oneOf", "allOf"]) for (const sub of s[k] ?? []) schemaTexts(sub, at, out);
  return out;
}

function scanText(text: string, where: string, findings: SecurityFinding[]): void {
  for (const rule of RULES) {
    const m = rule.pattern.exec(text);
    if (m) findings.push({ id: rule.id, severity: rule.severity, title: rule.title, detail: rule.detail, where, evidence: evidence(text, m.index, m[0].length) });
  }
  const hidden = INVISIBLE.exec(text);
  if (hidden) {
    const count = [...text].filter((c) => INVISIBLE.test(c)).length;
    findings.push({
      id: "invisible",
      severity: "high",
      title: `${count} invisible character${count === 1 ? "" : "s"}`,
      detail: "Zero-width, direction-changing or Unicode tag characters hide text from people while the model still reads it.",
      where,
      evidence: evidence(text.replace(INVISIBLE, "⟦hidden⟧"), hidden.index, "⟦hidden⟧".length),
    });
  }
}

/** Check one server's tools, instructions and prompts. `otherTools`: tool names on the workspace's other servers, by server name. */
export function scanServer(
  server: { name: string; tools: McpTool[]; instructions?: string; prompts?: Array<{ name: string; description?: string }> },
  otherTools: Map<string, string> = new Map(),
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const tool of server.tools) {
    const description = tool.description ?? "";
    scanText([tool.title, description].filter(Boolean).join("\n"), `tool ${tool.name}`, findings);
    for (const { where, text } of schemaTexts(tool.inputSchema)) scanText(text, `tool ${tool.name} › ${where}`, findings);
    if (description.length > LONG_DESCRIPTION) {
      findings.push({
        id: "long",
        severity: "info",
        title: `Very long description (${description.length.toLocaleString("en-US")} characters)`,
        detail: "Long descriptions cost context on every request and make it easy to hide instructions in them. Read it through.",
        where: `tool ${tool.name}`,
      });
    }
    const owner = otherTools.get(tool.name);
    if (owner) {
      findings.push({
        id: "shadow",
        severity: "medium",
        title: `Same tool name as on ${owner}`,
        detail: "Two servers with a tool of the same name: some clients can't tell them apart, and one can stand in for the other.",
        where: `tool ${tool.name}`,
      });
    }
    // A description that names another server's tool is trying to influence how it's used.
    for (const [name, owner] of otherTools) {
      if (name === tool.name || name.length < 5) continue;
      const m = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).exec(description);
      if (m) {
        findings.push({
          id: "cross-tool",
          severity: "medium",
          title: `Mentions ${owner}'s tool ${name}`,
          detail: "A tool that gives instructions about another server's tool can hijack how the model uses it (tool shadowing).",
          where: `tool ${tool.name}`,
          evidence: evidence(description, m.index, m[0].length),
        });
      }
    }
  }
  if (server.instructions) scanText(server.instructions, "server instructions", findings);
  for (const prompt of server.prompts ?? []) if (prompt.description) scanText(prompt.description, `prompt ${prompt.name}`, findings);
  const order: Record<Severity, number> = { high: 0, medium: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

/* -------------------------------------------------------- remembered tools */

interface Pin {
  hash: string;
  description?: string;
  schema?: string;
  seenAt: number;
}

type PinFile = Record<string, Record<string, Pin>>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function pinOf(tool: McpTool, now: number): Pin {
  const schema = stable(tool.inputSchema ?? {});
  const description = [tool.title, tool.description].filter(Boolean).join("\n");
  return { hash: createHash("sha256").update(`${description}\u0000${schema}`).digest("hex").slice(0, 16), description, schema, seenAt: now };
}

/** A server's identity for pinning: its id plus what it runs, so pointing an id at another server starts fresh. */
export function serverKey(server: Pick<McpServerConfig, "id" | "transport" | "command" | "args" | "url">): string {
  const target = server.transport === "stdio" ? [server.command, ...(server.args ?? [])].join(" ") : (server.url ?? "");
  return `${server.id}|${createHash("sha256").update(target).digest("hex").slice(0, 12)}`;
}

/**
 * What each server's tools looked like when first seen (or last trusted), in
 * ~/.moka/tool-pins.json. A changed description or schema is reported until
 * you trust it.
 */
export class ToolPins {
  private cache?: PinFile;

  constructor(readonly file: string) {}

  private async load(): Promise<PinFile> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.file, "utf8")) as PinFile;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    // Unique per write: two servers can connect (and save) at the same time.
    const tmp = `${this.file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(this.cache ?? {}, null, 1), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** Compare with what was trusted. A server seen for the first time is trusted as it is. */
  async check(key: string, tools: McpTool[], now = Date.now()): Promise<ToolChange[]> {
    const pins = await this.load();
    const known = pins[key];
    if (!known) {
      pins[key] = Object.fromEntries(tools.map((t) => [t.name, pinOf(t, now)]));
      await this.save();
      return [];
    }
    const changes: ToolChange[] = [];
    const current = new Map(tools.map((t) => [t.name, pinOf(t, now)]));
    for (const [name, pin] of current) {
      const before = known[name];
      if (!before) changes.push({ tool: name, kind: "added", after: { description: pin.description, schema: pin.schema } });
      else if (before.hash !== pin.hash) changes.push({ tool: name, kind: "changed", since: before.seenAt, before: { description: before.description, schema: before.schema }, after: { description: pin.description, schema: pin.schema } });
    }
    for (const [name, pin] of Object.entries(known)) if (!current.has(name)) changes.push({ tool: name, kind: "removed", since: pin.seenAt, before: { description: pin.description } });
    return changes;
  }

  /** Trust the server's tools as they are now. */
  async trust(key: string, tools: McpTool[], now = Date.now()): Promise<void> {
    const pins = await this.load();
    pins[key] = Object.fromEntries(tools.map((t) => [t.name, pinOf(t, now)]));
    await this.save();
  }
}
