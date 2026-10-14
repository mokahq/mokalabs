import type { Part, UiMessage } from "./types";

/** A file the preview pane can show: something the user attached, a tool returned, or a model wrote in its reply. */
export interface PreviewItem {
  id: string;
  name: string;
  mediaType: string;
  /** Where it came from, e.g. "You attached" or "Filesystem › read_file". */
  origin: string;
  /** The message it belongs to, to scroll back to it. */
  messageId: string;
  /** base64 data: URL for binary content. */
  dataUrl?: string;
  text?: string;
  /** Not inlined: read from the MCP server when opened (a tool's resource_link). */
  link?: { serverId: string; uri: string };
  size?: number;
}

export type PreviewKind = "image" | "svg" | "pdf" | "html" | "markdown" | "mermaid" | "json" | "csv" | "docx" | "audio" | "video" | "text" | "binary";

const EXT: Record<string, PreviewKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", ico: "image",
  svg: "svg",
  pdf: "pdf",
  html: "html", htm: "html",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  mmd: "mermaid", mermaid: "mermaid",
  json: "json", jsonl: "text",
  csv: "csv", tsv: "csv",
  docx: "docx",
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", flac: "audio",
  mp4: "video", webm: "video", mov: "video",
};

const TEXT_EXT = /\.(txt|log|ya?ml|toml|xml|ini|env|css|s[ac]ss|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|r|lua|dart|scala|vue|svelte|graphql|proto|dockerfile|gitignore)$/i;

/** How to show a file, from its media type and name. */
export function previewKind(mediaType: string, name = ""): PreviewKind {
  const type = mediaType.toLowerCase().split(";")[0]!.trim();
  if (type === "image/svg+xml") return "svg";
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type === "text/vnd.mermaid") return "mermaid";
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (type === "text/csv" || type === "text/tab-separated-values") return "csv";
  if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext && EXT[ext]) return EXT[ext]!;
  if (type.startsWith("text/") || TEXT_EXT.test(name) || type.includes("javascript") || type.includes("xml") || type.includes("yaml")) return "text";
  return "binary";
}

/** Documents worth opening on their own when a tool returns one (images stay inline in the chat). */
export function isDocument(kind: PreviewKind): boolean {
  return kind === "pdf" || kind === "html" || kind === "markdown" || kind === "docx" || kind === "csv";
}

/* ------------------------------------------------- artifacts in model replies */

/** FNV-1a: a short, stable id for a block of code. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** What a code block in a reply can be shown as, from its language tag or its first characters. */
export function artifactKind(lang: string | undefined, code: string): "html" | "svg" | "mermaid" | undefined {
  const l = (lang ?? "").toLowerCase();
  const head = code.trimStart().slice(0, 200).toLowerCase();
  if (l === "mermaid" || l === "mmd") return "mermaid";
  if (l === "svg" || ((l === "xml" || l === "") && head.startsWith("<svg"))) return "svg";
  if (l === "html" || l === "htm" || l === "xhtml") return "html";
  if (!l && (head.startsWith("<!doctype html") || head.startsWith("<html"))) return "html";
  return undefined;
}

/** A whole page (not a snippet), worth opening on its own. */
export function isFullPage(kind: "html" | "svg" | "mermaid", code: string): boolean {
  return kind === "html" && /<!doctype html|<html[\s>]/i.test(code.slice(0, 2000));
}

export function artifactId(messageId: string, code: string): string {
  return `${messageId}:reply:${hash(code.trim())}`;
}

const ARTIFACT_TYPE = { html: "text/html", svg: "image/svg+xml", mermaid: "text/vnd.mermaid" } as const;
const ARTIFACT_EXT = { html: "html", svg: "svg", mermaid: "mmd" } as const;

function artifactName(kind: "html" | "svg" | "mermaid", code: string, n: number): string {
  const title = kind === "html" ? /<title[^>]*>([^<]{1,80})<\/title>/i.exec(code)?.[1]?.trim() : undefined;
  const base = title ? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) : "";
  return `${base || (kind === "html" ? "page" : "diagram")}${!base && n > 1 ? `-${n}` : ""}.${ARTIFACT_EXT[kind]}`;
}

/** HTML pages, SVG and Mermaid diagrams a model wrote in a reply: fenced code blocks, or a reply that is a whole page. */
export function replyArtifacts(message: UiMessage): PreviewItem[] {
  if (message.role !== "assistant") return [];
  const out: PreviewItem[] = [];
  const seen = new Set<string>();
  const origin = message.meta?.model ? `Reply · ${message.meta.model}` : "Reply";
  const add = (kind: "html" | "svg" | "mermaid", code: string) => {
    const id = artifactId(message.id, code);
    if (seen.has(id)) return;
    seen.add(id);
    const count = out.filter((o) => previewKind(o.mediaType) === kind).length + 1;
    out.push({ id, name: artifactName(kind, code, count), mediaType: ARTIFACT_TYPE[kind], origin, messageId: message.id, text: code.trim(), size: code.trim().length });
  };
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    const text = part.text;
    // A reply that is nothing but a page (some models skip the code fence).
    if (/^\s*(<!doctype html|<html[\s>])/i.test(text)) {
      add("html", text);
      continue;
    }
    for (const m of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\s`]*)[^\n]*\n([\s\S]*?)\n {0,3}\1[ \t]*$/gm)) {
      const kind = artifactKind(m[2], m[3]!);
      if (kind && m[3]!.trim()) add(kind, m[3]!);
    }
  }
  return out;
}

const EXT_FOR: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "video/mp4": "mp4", "video/webm": "webm",
  "application/pdf": "pdf", "text/html": "html", "text/markdown": "md", "application/json": "json", "text/csv": "csv", "text/plain": "txt",
};

/** The last segment of a URI, or a name made up from the tool and the type. */
function nameFor(uri: string | undefined, mediaType: string, fallback: string): string {
  const last = uri ? decodeURIComponent(uri.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop() ?? "") : "";
  if (last && !/^[a-z]+:$/i.test(last)) return last;
  const ext = EXT_FOR[mediaType.split(";")[0]!.trim()];
  return ext ? `${fallback}.${ext}` : fallback;
}

/** Bytes in a base64 string, without decoding it. */
function base64Size(data: string): number {
  const clean = data.replace(/\s/g, "");
  return Math.floor((clean.length * 3) / 4) - (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0);
}

/** The content an attachment sent to the model, by position (see toModelContent in the store). */
function attachmentContent(part: unknown): { dataUrl?: string; text?: string } {
  const p = part as any;
  if (p?.type === "image" && typeof p.image === "string") return { dataUrl: p.image };
  if (p?.type === "file" && typeof p.data === "string") return { dataUrl: p.data };
  if (p?.type === "text" && typeof p.text === "string") {
    const m = /^<(file|resource)\b[^>]*>\n([\s\S]*)\n<\/\1>$/.exec(p.text);
    return { text: m ? m[2] : p.text };
  }
  return {};
}

type ToolPart = Extract<Part, { type: "tool" }>;

/** Files in one tool result: images, audio, embedded resources and resource links. Interactive UIs (ui://) are shown in the chat instead. */
export function toolFiles(part: ToolPart, messageId: string): PreviewItem[] {
  const out: PreviewItem[] = [];
  const origin = part.source && part.source !== "unknown" ? `${part.source} › ${part.tool}` : part.tool;
  const seen = { image: 0, audio: 0 };
  (part.raw?.content ?? []).forEach((block: any, index) => {
    // Tool call ids are only unique within a turn for some providers, so the message's id comes first.
    const id = `${messageId}:${part.id}:${index}`;
    const base = { id, origin, messageId };
    if ((block?.type === "image" || block?.type === "audio") && typeof block.data === "string") {
      const mediaType = block.mimeType ?? (block.type === "image" ? "image/png" : "audio/mpeg");
      out.push({ ...base, name: nameFor(undefined, mediaType, `${part.tool}-${block.type}${seen[block.type as "image" | "audio"]++ ? `-${seen[block.type as "image" | "audio"]}` : ""}`), mediaType, dataUrl: `data:${mediaType};base64,${block.data}`, size: base64Size(block.data) });
    } else if (block?.type === "resource" && block.resource?.uri && !String(block.resource.uri).startsWith("ui://")) {
      const r = block.resource;
      const mediaType = r.mimeType ?? (typeof r.text === "string" ? "text/plain" : "application/octet-stream");
      const item: PreviewItem = { ...base, name: nameFor(r.uri, mediaType, part.tool), mediaType };
      if (typeof r.text === "string") Object.assign(item, { text: r.text, size: r.text.length });
      else if (typeof r.blob === "string") Object.assign(item, { dataUrl: `data:${mediaType};base64,${r.blob}`, size: base64Size(r.blob) });
      else return;
      out.push(item);
    } else if (block?.type === "resource_link" && block.uri && !String(block.uri).startsWith("ui://")) {
      const mediaType = block.mimeType ?? "application/octet-stream";
      out.push({
        ...base,
        name: block.title ?? block.name ?? nameFor(block.uri, mediaType, part.tool),
        mediaType,
        ...(part.serverId ? { link: { serverId: part.serverId, uri: block.uri } } : {}),
        ...(typeof block.size === "number" ? { size: block.size } : {}),
      });
    }
  });
  return out;
}

/** Everything in a chat the preview pane can open, oldest first. */
export function collectPreviews(messages: UiMessage[], modelMessages: unknown[] = []): PreviewItem[] {
  const userContents = modelMessages.filter((m: any) => m?.role === "user").map((m: any) => m.content);
  const items: PreviewItem[] = [];
  let nthUser = -1;
  for (const message of messages) {
    if (message.role === "user") nthUser++;
    let nthAttachment = 0;
    for (const part of message.parts) {
      if (part.type === "attachment") {
        const a = part.attachment;
        const content = userContents[nthUser];
        const sent = Array.isArray(content) ? attachmentContent(content[nthAttachment]) : {};
        nthAttachment++;
        items.push({
          id: a.id,
          name: a.name,
          mediaType: a.mediaType,
          origin: a.kind === "resource" ? `Resource · ${a.uri ?? ""}` : "You attached",
          messageId: message.id,
          size: a.size,
          dataUrl: a.dataUrl ?? sent.dataUrl,
          text: sent.text,
          ...(a.kind === "resource" && !sent.text && a.uri && a.serverId ? { link: { serverId: a.serverId, uri: a.uri } } : {}),
        });
      } else if (part.type === "tool") {
        items.push(...toolFiles(part, message.id));
      }
    }
    items.push(...replyArtifacts(message));
  }
  return items;
}

/** base64 data: URL → bytes. */
export function dataUrlBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const meta = dataUrl.slice(5, comma);
  const body = dataUrl.slice(comma + 1);
  if (!meta.endsWith(";base64")) return new TextEncoder().encode(decodeURIComponent(body));
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A small CSV/TSV parser: quoted fields, escaped quotes, newlines inside quotes. */
export function parseCsv(text: string, delimiter = text.split("\n", 1)[0]!.includes("\t") ? "\t" : ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function formatBytes(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Hosts an HTML page loads scripts, styles, fonts or images from (http/https and protocol-relative URLs). */
export function externalHosts(html: string): string[] {
  const hosts = new Set<string>();
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']?((?:https?:)?\/\/[^\s"'>]+)/gi)) {
    try {
      const url = new URL(m[1]!.startsWith("//") ? `https:${m[1]}` : m[1]!);
      // Plain links (<a href>) don't load anything; only count what the page fetches.
      const before = html.slice(Math.max(0, m.index! - 200), m.index).toLowerCase();
      if (/<a\s[^>]*$/.test(before)) continue;
      hosts.add(url.host);
    } catch {
      // not a URL
    }
  }
  for (const m of html.matchAll(/@import\s+(?:url\()?["']?((?:https?:)?\/\/[^\s"')]+)/gi)) {
    try {
      hosts.add(new URL(m[1]!.startsWith("//") ? `https:${m[1]}` : m[1]!).host);
    } catch {
      // not a URL
    }
  }
  return [...hosts];
}

/** The page with a Content-Security-Policy that blocks everything from the network. */
export function offline(html: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + csp) : csp + html;
}
