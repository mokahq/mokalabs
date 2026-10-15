/**
 * Word (.docx) → Markdown, with no dependencies: a .docx is a zip of XML
 * files. Keeps what reads well in a chat app: headings, bold/italic/strike,
 * links, bullet and numbered lists, tables and line breaks. Images, comments
 * and tracked changes are left out.
 */

/** Read one file from a zip archive (stored or deflated entries). */
export async function unzipEntry(zip: Uint8Array, path: string): Promise<Uint8Array | undefined> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < count && view.getUint32(at, true) === 0x02014b50; n++) {
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name !== path) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + compressed);
    if (method === 0) return data;
    if (method !== 8) throw new Error(`Unsupported zip compression (${method})`);
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? unescapeXml(m[1]!) : undefined;
}

/** A formatting toggle like <w:b/> is on unless w:val says otherwise. */
const on = (attrs: string) => !/\bw:val="(0|false|none)"/.test(attrs);

/** `numId` → (`ilvl` → ordered?) from word/numbering.xml. */
export function parseNumbering(xml: string): Map<string, Map<string, boolean>> {
  const abstract = new Map<string, Map<string, boolean>>();
  for (const m of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="([^"]+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const levels = new Map<string, boolean>();
    for (const l of m[2]!.matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      const fmt = /<w:numFmt\b[^>]*w:val="([^"]+)"/.exec(l[2]!)?.[1] ?? "bullet";
      levels.set(l[1]!, fmt !== "bullet" && fmt !== "none");
    }
    abstract.set(m[1]!, levels);
  }
  const nums = new Map<string, Map<string, boolean>>();
  for (const m of xml.matchAll(/<w:num\b[^>]*w:numId="([^"]+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const id = /<w:abstractNumId\b[^>]*w:val="([^"]+)"/.exec(m[2]!)?.[1];
    if (id && abstract.has(id)) nums.set(m[1]!, abstract.get(id)!);
  }
  return nums;
}

/** `rId` → link target from word/_rels/document.xml.rels. */
export function parseRels(xml: string): Map<string, string> {
  const rels = new Map<string, string>();
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1]!, "Id");
    const target = attr(m[1]!, "Target");
    if (id && target) rels.set(id, target);
  }
  return rels;
}

interface Run {
  text: string;
  b: boolean;
  i: boolean;
  s: boolean;
  href?: string;
}

const escapeMd = (s: string) => s.replace(/([\\`*_[\]<>])/g, "\\$1");

/** Adjacent runs with the same formatting become one, then get their markers (whitespace stays outside them). */
function renderRuns(runs: Run[], inTable: boolean): string {
  const merged: Run[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.b === r.b && last.i === r.i && last.s === r.s && last.href === r.href) last.text += r.text;
    else merged.push({ ...r });
  }
  let out = "";
  for (const r of merged) {
    let text = escapeMd(r.text);
    if (inTable) text = text.replace(/\|/g, "\\|").replace(/\n/g, " ");
    else text = text.replace(/\n/g, "  \n");
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
    if (!core) {
      out += text;
      continue;
    }
    let wrapped = core;
    if (r.s) wrapped = `~~${wrapped}~~`;
    if (r.i) wrapped = `*${wrapped}*`;
    if (r.b) wrapped = `**${wrapped}**`;
    if (r.href) wrapped = `[${wrapped}](${r.href.replace(/[()\s]/g, encodeURIComponent)})`;
    out += lead + wrapped + trail;
  }
  return out;
}

interface Paragraph {
  style?: string;
  list?: { level: number; ordered: boolean };
  runs: Run[];
}

/** WordprocessingML (word/document.xml) → Markdown. */
export function documentToMarkdown(xml: string, numbering = new Map<string, Map<string, boolean>>(), rels = new Map<string, string>()): string {
  // List items are kept together (a tight list); everything else is separated by a blank line.
  const blocks: Array<{ md: string; item?: boolean }> = [];
  // Tables, innermost last: rows → cells → paragraphs' text.
  const tables: string[][][][] = [];
  let paragraph: Paragraph | undefined;
  let run: Omit<Run, "text"> | undefined;
  let href: string | undefined;
  let inText = false;
  let numId: string | undefined;
  let ilvl = "0";

  const finishParagraph = () => {
    if (!paragraph) return;
    const p = paragraph;
    paragraph = undefined;
    const table = tables[tables.length - 1];
    if (table) {
      const row = table[table.length - 1];
      row?.[row.length - 1]?.push(renderRuns(p.runs, true).trim());
      return;
    }
    const text = renderRuns(p.runs, false).trim();
    const heading = /^(?:heading|berschrift|titre|titolo|kop)\s*([1-6])$/i.exec(p.style ?? "")?.[1] ?? (p.style === "Title" ? "1" : p.style === "Subtitle" ? "2" : undefined);
    if (!text) return;
    if (!p.list && /^List ?(Bullet|Number)/i.test(p.style ?? "")) p.list = { level: Number(/(\d)$/.exec(p.style!)?.[1] ?? 1) - 1, ordered: /Number/i.test(p.style!) };
    if (heading) blocks.push({ md: `${"#".repeat(Number(heading))} ${text}` });
    else if (p.list) blocks.push({ md: `${"  ".repeat(p.list.level * 2)}${p.list.ordered ? "1." : "-"} ${text}`, item: true });
    else if (/quote/i.test(p.style ?? "")) blocks.push({ md: `> ${text}` });
    else blocks.push({ md: /^([#>+-]|\d+\.)/.test(text) ? `\\${text}` : text });
  };

  const finishTable = () => {
    const rows = tables.pop()!.map((r) => r.map((cell) => cell.filter(Boolean).join(" ")));
    if (!rows.length) return;
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
    const md = [line(rows[0]!), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
    const outer = tables[tables.length - 1];
    // A table in a table: keep its text in the outer cell.
    if (outer) outer[outer.length - 1]?.[outer[outer.length - 1]!.length - 1]?.push(rows.flat().join(" "));
    else blocks.push({ md });
  };

  for (const m of xml.matchAll(/<(\/?)([\w:]+)([^>]*?)(\/?)>|([^<]+)/g)) {
    const [, close, tag, attrs = "", selfClose, text] = m;
    if (text !== undefined) {
      if (inText && paragraph && run) paragraph.runs.push({ ...run, text: unescapeXml(text), ...(href ? { href } : {}) });
      continue;
    }
    if (close) {
      if (tag === "w:t") inText = false;
      else if (tag === "w:r") run = undefined;
      else if (tag === "w:hyperlink") href = undefined;
      else if (tag === "w:p") finishParagraph();
      else if (tag === "w:tbl") finishTable();
      continue;
    }
    switch (tag) {
      case "w:p":
        finishParagraph();
        paragraph = { runs: [] };
        numId = undefined;
        ilvl = "0";
        if (selfClose) finishParagraph();
        break;
      case "w:pStyle":
        if (paragraph) paragraph.style = attr(attrs, "w:val");
        break;
      case "w:ilvl":
        ilvl = attr(attrs, "w:val") ?? "0";
        if (paragraph?.list) paragraph.list.level = Number(ilvl);
        break;
      case "w:numId":
        numId = attr(attrs, "w:val");
        if (paragraph && numId && numId !== "0") paragraph.list = { level: Number(ilvl), ordered: numbering.get(numId)?.get(ilvl) ?? false };
        break;
      case "w:r":
        run = { b: false, i: false, s: false };
        break;
      case "w:b":
        if (run) run.b = on(attrs);
        break;
      case "w:i":
        if (run) run.i = on(attrs);
        break;
      case "w:strike":
        if (run) run.s = on(attrs);
        break;
      case "w:t":
        if (!selfClose) inText = true;
        break;
      case "w:tab":
        if (run && paragraph) paragraph.runs.push({ ...run, text: " " });
        break;
      case "w:br":
      case "w:cr":
        if (run && paragraph && attr(attrs, "w:type") !== "page") paragraph.runs.push({ ...run, text: "\n" });
        break;
      case "w:hyperlink": {
        const id = attr(attrs, "r:id");
        href = id ? rels.get(id) : undefined;
        if (selfClose) href = undefined;
        break;
      }
      case "w:drawing":
      case "w:pict":
        if (paragraph) paragraph.runs.push({ text: "[image]", b: false, i: true, s: false });
        break;
      case "w:tbl":
        finishParagraph();
        tables.push([]);
        break;
      case "w:tr":
        tables[tables.length - 1]?.push([]);
        break;
      case "w:tc": {
        const table = tables[tables.length - 1];
        table?.[table.length - 1]?.push([]);
        break;
      }
    }
  }
  finishParagraph();
  return blocks.map((b, i) => (i === 0 ? "" : b.item && blocks[i - 1]!.item ? "\n" : "\n\n") + b.md).join("");
}

/** A .docx file's text as Markdown. */
export async function docxToMarkdown(bytes: Uint8Array): Promise<string> {
  const read = async (path: string) => {
    const data = await unzipEntry(bytes, path);
    return data ? new TextDecoder().decode(data) : undefined;
  };
  const document = await read("word/document.xml");
  if (!document) throw new Error("Not a Word document (word/document.xml is missing)");
  const numbering = await read("word/numbering.xml");
  const rels = await read("word/_rels/document.xml.rels");
  return documentToMarkdown(document, numbering ? parseNumbering(numbering) : undefined, rels ? parseRels(rels) : undefined);
}
