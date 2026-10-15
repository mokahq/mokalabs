/**
 * Tiny, dependency-free document writers for the demo server's
 * `create_document` tool: PDF, Word (.docx), HTML and Markdown from the same
 * outline. Enough for a model to "make a file" in a demo; not a layout engine.
 */

export interface DocOutline {
  title: string;
  subtitle?: string;
  sections: Array<{ heading?: string; body: string }>;
  table?: { columns: string[]; rows: string[][] };
}

export type DocFormat = "pdf" | "docx" | "html" | "markdown";

export const MIME: Record<DocFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html",
  markdown: "text/markdown",
};

export const EXTENSION: Record<DocFormat, string> = { pdf: "pdf", docx: "docx", html: "html", markdown: "md" };

/** A section body as paragraphs and bullet items ("- " or "* " lines). */
function blocks(body: string): Array<{ bullet: boolean; text: string }> {
  const out: Array<{ bullet: boolean; text: string }> = [];
  for (const raw of body.split(/\n/)) {
    const line = raw.trim();
    if (!line) {
      out.push({ bullet: false, text: "" });
      continue;
    }
    const bullet = /^[-*•]\s+/.test(line);
    const text = line.replace(/^[-*•]\s+/, "");
    const last = out[out.length - 1];
    // Lines of one paragraph join up; a blank line starts a new one.
    if (!bullet && last && !last.bullet && last.text) last.text += ` ${text}`;
    else out.push({ bullet, text });
  }
  return out.filter((b) => b.text);
}

export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_-]+/g, "-")
      .slice(0, 60) || "document"
  );
}

/* ---------------------------------------------------------------- markdown */

export function toMarkdown(doc: DocOutline): string {
  const lines = [`# ${doc.title}`];
  if (doc.subtitle) lines.push("", `_${doc.subtitle}_`);
  for (const s of doc.sections) {
    if (s.heading) lines.push("", `## ${s.heading}`);
    let wasBullet = false;
    for (const b of blocks(s.body)) {
      if (!(b.bullet && wasBullet)) lines.push("");
      lines.push(b.bullet ? `- ${b.text}` : b.text);
      wasBullet = b.bullet;
    }
  }
  if (doc.table?.columns.length) {
    const cell = (c: string) => c.replace(/\|/g, "\\|");
    lines.push("", `| ${doc.table.columns.map(cell).join(" | ")} |`, `|${" --- |".repeat(doc.table.columns.length)}`);
    for (const r of doc.table.rows) lines.push(`| ${doc.table.columns.map((_, i) => cell(r[i] ?? "")).join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

/* -------------------------------------------------------------------- html */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function toHtml(doc: DocOutline): string {
  const body: string[] = [`<h1>${esc(doc.title)}</h1>`];
  if (doc.subtitle) body.push(`<p class="subtitle">${esc(doc.subtitle)}</p>`);
  for (const s of doc.sections) {
    body.push("<section>");
    if (s.heading) body.push(`<h2>${esc(s.heading)}</h2>`);
    let list = false;
    for (const b of blocks(s.body)) {
      if (b.bullet && !list) body.push("<ul>");
      if (!b.bullet && list) body.push("</ul>");
      list = b.bullet;
      body.push(b.bullet ? `<li>${esc(b.text)}</li>` : `<p>${esc(b.text)}</p>`);
    }
    if (list) body.push("</ul>");
    body.push("</section>");
  }
  if (doc.table?.columns.length) {
    body.push("<table><thead><tr>", ...doc.table.columns.map((c) => `<th>${esc(c)}</th>`), "</tr></thead><tbody>");
    for (const r of doc.table.rows) body.push("<tr>", ...doc.table.columns.map((_, i) => `<td>${esc(r[i] ?? "")}</td>`), "</tr>");
    body.push("</tbody></table>");
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.title)}</title>
<style>
  body { font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f1b16; background: #fffdf9; max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.5rem; }
  h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 .25rem; }
  .subtitle { color: #7a6f63; margin: 0 0 1.5rem; }
  h2 { font-size: 1.2rem; margin: 2rem 0 .5rem; color: #8a4b22; }
  section { border-top: 1px solid #eadfd3; }
  table { border-collapse: collapse; width: 100%; margin-top: 2rem; font-size: .95rem; }
  th, td { border: 1px solid #eadfd3; padding: .45rem .6rem; text-align: left; vertical-align: top; }
  th { background: #f6ede3; }
</style>
</head>
<body>
${body.join("\n")}
</body>
</html>
`;
}

/* --------------------------------------------------------------------- pdf */

/** Unicode → a PDF string in WinAnsi (Helvetica's encoding); other characters become "?". */
function pdfText(s: string): string {
  const special: Record<string, string> = { "•": "\\225", "–": "\\226", "—": "\\227", "‘": "\\221", "’": "\\222", "“": "\\223", "”": "\\224", "…": "\\205", "€": "\\200" };
  let out = "";
  for (const ch of s.normalize("NFC")) {
    if (special[ch]) out += special[ch];
    else if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else {
      const code = ch.codePointAt(0)!;
      if (code >= 32 && code < 127) out += ch;
      else if (code >= 160 && code < 256) out += `\\${code.toString(8).padStart(3, "0")}`;
      else out += "?";
    }
  }
  return out;
}

/** Approximate Helvetica width (in em) for wrapping: narrow, regular and wide letters. */
function width(s: string, size: number, bold: boolean): number {
  let em = 0;
  for (const ch of s) em += /[iljtfrI.,;:'!| ]/.test(ch) ? 0.28 : /[mwMW@]/.test(ch) ? 0.85 : /[A-Z0-9]/.test(ch) ? 0.66 : 0.53;
  return em * size * (bold ? 1.06 : 1);
}

function wrap(text: string, max: number, size: number, bold: boolean): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && width(next, size, bold) > max) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export function toPdf(doc: DocOutline): Uint8Array {
  const W = 595;
  const H = 842;
  const M = 56;
  const pages: string[][] = [[]];
  let y = H - M;
  const ensure = (needed: number) => {
    if (y - needed < M + 20) {
      pages.push([]);
      y = H - M;
    }
  };
  const put = (text: string, x: number, size: number, bold: boolean, color = "0.12 0.1 0.08") => {
    pages[pages.length - 1]!.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${color} rg ${x} ${y.toFixed(1)} Td (${pdfText(text)}) Tj ET`);
  };
  const paragraph = (text: string, size: number, bold: boolean, opts: { indent?: number; gap?: number; color?: string; bullet?: boolean } = {}) => {
    const indent = opts.indent ?? 0;
    const lead = size * 1.4;
    wrap(text, W - 2 * M - indent, size, bold).forEach((line, i) => {
      ensure(lead);
      y -= lead;
      if (opts.bullet && i === 0) put("•", M + indent - 12, size, false, opts.color);
      put(line, M + indent, size, bold, opts.color);
    });
    y -= opts.gap ?? 0;
  };

  paragraph(doc.title, 24, true, { gap: 4 });
  if (doc.subtitle) paragraph(doc.subtitle, 12, false, { color: "0.45 0.42 0.38", gap: 6 });
  for (const s of doc.sections) {
    y -= 10;
    if (s.heading) {
      ensure(40);
      paragraph(s.heading, 14, true, { color: "0.54 0.29 0.13", gap: 2 });
    }
    for (const b of blocks(s.body)) paragraph(b.text, 11, false, b.bullet ? { indent: 18, bullet: true, gap: 1 } : { gap: 6 });
  }
  if (doc.table?.columns.length) {
    y -= 14;
    const cols = doc.table.columns.length;
    const colWidth = (W - 2 * M) / cols;
    const row = (cells: string[], bold: boolean) => {
      const wrapped = doc.table!.columns.map((_, i) => wrap(cells[i] ?? "", colWidth - 10, 10, bold));
      const height = Math.max(1, ...wrapped.map((l) => l.length)) * 13 + 8;
      ensure(height);
      const top = y;
      const page = pages[pages.length - 1]!;
      if (bold) page.push(`0.96 0.93 0.89 rg ${M} ${(top - height).toFixed(1)} ${W - 2 * M} ${height.toFixed(1)} re f`);
      page.push(`0.85 0.8 0.75 RG 0.5 w ${M} ${(top - height).toFixed(1)} ${W - 2 * M} ${height.toFixed(1)} re S`);
      wrapped.forEach((lines, i) => {
        y = top - 4;
        for (const line of lines) {
          y -= 13;
          put(line, M + i * colWidth + 5, 10, bold);
        }
      });
      y = top - height;
    };
    row(doc.table.columns, true);
    for (const r of doc.table.rows) row(r, false);
  }

  // Objects: 1 catalog, 2 page tree, 3-4 fonts, then a page and its content stream per page.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  pages.forEach((ops, i) => {
    const footer = `BT /F1 9 Tf 0.55 0.52 0.48 rg ${M} 30 Td (${pdfText(doc.title)}) Tj ET BT /F1 9 Tf ${W - M - 40} 30 Td (${i + 1} of ${pages.length}) Tj ET`;
    const stream = [...ops, footer].join("\n");
    objects[pageIds[i]!] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`;
    objects[pageIds[i]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let pdf = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character is 0-255 (escapes keep the rest ASCII), so latin1 gives one byte each.
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

/* -------------------------------------------------------------------- docx */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive with stored (uncompressed) entries. */
export function zipStore(files: Record<string, string>): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    chunks.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, cd, end]));
}

export function toDocx(doc: DocOutline): Uint8Array {
  const x = (s: string) => esc(s).replace(/'/g, "&apos;");
  const run = (text: string, props = "") => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${x(text)}</w:t></w:r>`;
  const para = (text: string, style?: string, extra = "") => `<w:p>${style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}</w:pPr>` : ""}${run(text)}</w:p>`;
  const body: string[] = [para(doc.title, "Title")];
  if (doc.subtitle) body.push(para(doc.subtitle, "Subtitle"));
  for (const s of doc.sections) {
    if (s.heading) body.push(para(s.heading, "Heading1"));
    for (const b of blocks(s.body)) body.push(b.bullet ? para(b.text, "ListParagraph", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>') : para(b.text));
  }
  if (doc.table?.columns.length) {
    const border = '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="D9CCBF"/><w:left w:val="single" w:sz="4" w:color="D9CCBF"/><w:bottom w:val="single" w:sz="4" w:color="D9CCBF"/><w:right w:val="single" w:sz="4" w:color="D9CCBF"/><w:insideH w:val="single" w:sz="4" w:color="D9CCBF"/><w:insideV w:val="single" w:sz="4" w:color="D9CCBF"/></w:tblBorders>';
    const cell = (text: string, head: boolean) => `<w:tc><w:p>${run(text, head ? "<w:b/>" : "")}</w:p></w:tc>`;
    body.push(
      `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${border}</w:tblPr>`,
      `<w:tr>${doc.table.columns.map((c) => cell(c, true)).join("")}</w:tr>`,
      ...doc.table.rows.map((r) => `<w:tr>${doc.table!.columns.map((_, i) => cell(r[i] ?? "", false)).join("")}</w:tr>`),
      "</w:tbl>",
    );
  }
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const style = (id: string, name: string, size: number, color?: string, bold = true) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr>${bold ? "<w:b/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}<w:sz w:val="${size}"/></w:rPr></w:style>`;
  return zipStore({
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/_rels/document.xml.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>',
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${style("Title", "Title", 48)}${style("Subtitle", "Subtitle", 24, "7A6F63", false)}${style("Heading1", "heading 1", 28, "8A4B22")}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style></w:styles>`,
    "word/numbering.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  });
}

/** The document as bytes or text, ready to return as an MCP embedded resource. */
export function renderDocument(doc: DocOutline, format: DocFormat): { text?: string; bytes?: Uint8Array } {
  if (format === "pdf") return { bytes: toPdf(doc) };
  if (format === "docx") return { bytes: toDocx(doc) };
  if (format === "html") return { text: toHtml(doc) };
  return { text: toMarkdown(doc) };
}
