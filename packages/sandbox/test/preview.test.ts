import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { renderDocument, toDocx, toMarkdown, toPdf } from "../src/demo-docs.js";
import { docxToMarkdown, documentToMarkdown, parseNumbering, unzipEntry } from "../web/src/docx.js";
import { artifactId, artifactKind, collectPreviews, dataUrlBytes, externalHosts, isDocument, isFullPage, offline, parseCsv, previewKind, replyArtifacts } from "../web/src/preview.js";
import type { UiMessage } from "../web/src/types.js";

/** A minimal zip archive (deflated entries) built by hand, like Word writes them. */
function zip(files: Record<string, string>, method: 0 | 8 = 8): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content);
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const p = (inner: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;
const r = (text: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;

describe("previewKind", () => {
  it("picks a viewer from the media type, then the extension", () => {
    expect(previewKind("application/pdf")).toBe("pdf");
    expect(previewKind("image/svg+xml")).toBe("svg");
    expect(previewKind("image/png")).toBe("image");
    expect(previewKind("text/html; charset=utf-8")).toBe("html");
    expect(previewKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(previewKind("application/octet-stream", "notes.md")).toBe("markdown");
    expect(previewKind("application/octet-stream", "report.docx")).toBe("docx");
    expect(previewKind("", "main.py")).toBe("text");
    expect(previewKind("application/zip", "a.zip")).toBe("binary");
    expect(isDocument("pdf") && !isDocument("image")).toBe(true);
  });
});

describe("collectPreviews", () => {
  it("finds attachments (with the content sent to the model) and files returned by tools", () => {
    const messages: UiMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "summarise these" },
          { type: "attachment", attachment: { id: "a1", name: "report.pdf", mediaType: "application/pdf", size: 3, kind: "file" } },
          { type: "attachment", attachment: { id: "a2", name: "notes.md", mediaType: "text/markdown", size: 5, kind: "text" } },
        ],
      },
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool",
            id: "call_1",
            name: "fs__make",
            tool: "make_report",
            source: "Files",
            serverId: "fs",
            input: {},
            status: "done",
            raw: {
              content: [
                { type: "text", text: "Done" },
                { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
                { type: "resource", resource: { uri: "file:///tmp/out/plants.html", mimeType: "text/html", text: "<h1>Plants</h1>" } },
                { type: "resource", resource: { uri: "ui://app/view", mimeType: "text/html", text: "<div/>" } },
                { type: "resource_link", uri: "file:///tmp/out/plants.pdf", name: "plants.pdf", mimeType: "application/pdf", size: 1234 },
              ],
            },
          },
        ],
      },
    ];
    const modelMessages = [
      {
        role: "user",
        content: [
          { type: "file", data: "data:application/pdf;base64,JVBERg==", mediaType: "application/pdf", filename: "report.pdf" },
          { type: "text", text: '<file name="notes.md">\n# Notes\n</file>' },
          { type: "text", text: "summarise these" },
        ],
      },
      { role: "assistant", content: "…" },
    ];
    const items = collectPreviews(messages, modelMessages);
    expect(items.map((i) => [i.id, i.name, i.mediaType, i.origin])).toEqual([
      ["a1", "report.pdf", "application/pdf", "You attached"],
      ["a2", "notes.md", "text/markdown", "You attached"],
      ["m1:call_1:1", "make_report-image.png", "image/png", "Files › make_report"],
      ["m1:call_1:2", "plants.html", "text/html", "Files › make_report"],
      ["m1:call_1:4", "plants.pdf", "application/pdf", "Files › make_report"],
    ]);
    expect(items[0]!.dataUrl).toBe("data:application/pdf;base64,JVBERg==");
    expect(items[1]!.text).toBe("# Notes");
    expect(items[2]).toMatchObject({ dataUrl: "data:image/png;base64,aGVsbG8=", size: 5, messageId: "m1" });
    expect(items[3]!.text).toBe("<h1>Plants</h1>");
    expect(items[4]).toMatchObject({ link: { serverId: "fs", uri: "file:///tmp/out/plants.pdf" }, size: 1234 });
  });
});

describe("helpers", () => {
  it("decodes data: URLs", () => {
    expect(new TextDecoder().decode(dataUrlBytes("data:text/plain;base64,aGVsbG8="))).toBe("hello");
    expect(new TextDecoder().decode(dataUrlBytes("data:text/plain,a%20b"))).toBe("a b");
  });

  it("parses CSV and TSV, with quotes", () => {
    expect(parseCsv('name,notes\n"Fig, fiddle-leaf","says ""hi""\ntwice"\r\nPothos,easy\n')).toEqual([
      ["name", "notes"],
      ["Fig, fiddle-leaf", 'says "hi"\ntwice'],
      ["Pothos", "easy"],
    ]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("docx", () => {
  const numbering = `<w:numbering ${W}>
    <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
  </w:numbering>`;
  const body = [
    p(r("Office plants"), '<w:pStyle w:val="Title"/>'),
    p(r("Light"), '<w:pStyle w:val="Heading2"/>'),
    p(r("Bright, ") + r("indirect", "<w:b/>") + r(" light. ") + r("Not", "<w:i/>") + r(" direct sun &amp; no *drafts*.")),
    p(r("Fiddle-leaf fig"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
    p(r("Needs space"), '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>'),
    p(r("Water weekly"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
    p(`<w:hyperlink r:id="rId5">${r("Sources")}</w:hyperlink>`),
    p(r("line one") + "<w:r><w:br/></w:r>" + r("line two")),
    `<w:tbl><w:tr><w:tc>${p(r("Plant"))}</w:tc><w:tc>${p(r("Height"))}</w:tc></w:tr><w:tr><w:tc>${p(r("Fig"))}</w:tc><w:tc>${p(r("1.8–3 m | indoors"))}</w:tc></w:tr></w:tbl>`,
    p(r("Not bold", '<w:b w:val="0"/>')),
    "<w:p/>",
  ].join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="hyperlink" Target="https://example.com/plants" TargetMode="External"/></Relationships>`;
  const expected = [
    "# Office plants",
    "## Light",
    "Bright, **indirect** light. *Not* direct sun & no \\*drafts\\*.",
    "- Fiddle-leaf fig\n    - Needs space\n1. Water weekly",
    "[Sources](https://example.com/plants)",
    "line one  \nline two",
    "| Plant | Height |\n| --- | --- |\n| Fig | 1.8–3 m \\| indoors |",
    "Not bold",
  ].join("\n\n");

  it("turns WordprocessingML into Markdown", () => {
    expect(documentToMarkdown(document, parseNumbering(numbering), new Map([["rId5", "https://example.com/plants"]]))).toBe(expected);
  });

  it("reads a .docx file (zip, deflated or stored)", async () => {
    const files = { "[Content_Types].xml": "<Types/>", "word/document.xml": document, "word/numbering.xml": numbering, "word/_rels/document.xml.rels": rels };
    expect(await docxToMarkdown(zip(files))).toBe(expected);
    expect(await docxToMarkdown(zip(files, 0))).toBe(expected);
    expect(await unzipEntry(zip(files), "missing.xml")).toBeUndefined();
    await expect(docxToMarkdown(zip({ "a.txt": "x" }))).rejects.toThrow(/Not a Word document/);
    await expect(docxToMarkdown(new Uint8Array(40))).rejects.toThrow(/Not a zip/);
  });
});

describe("demo documents", () => {
  const outline = {
    title: "Office plants",
    subtitle: "For north-facing light",
    sections: [{ heading: "Fiddle-leaf fig", body: "Bright, indirect light — not (direct) sun.\n\n- Water weekly\n- 1.8–3 m tall" }],
    table: { columns: ["Plant", "Care"], rows: [["Fig", "Medium | high"]] },
  };

  it("writes a PDF whose cross-reference table points at its objects", () => {
    const pdf = Buffer.from(toPdf(outline)).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((offset, i) => expect(pdf.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true));
    // Escaped parentheses and WinAnsi characters (em dash, en dash, bullet).
    expect(pdf).toContain("light \\227 not \\(direct\\) sun.");
    expect(pdf).toContain("(\\225)");
    expect(pdf).toContain("1.8\\2263 m tall");
    for (const [, length, stream] of pdf.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) expect(stream!.length).toBe(Number(length));
  });

  it("writes a .docx that the preview reads back", async () => {
    expect(await docxToMarkdown(toDocx(outline))).toBe(
      ["# Office plants", "## For north-facing light", "# Fiddle-leaf fig", "Bright, indirect light — not (direct) sun.", "- Water weekly\n- 1.8–3 m tall", "| **Plant** | **Care** |\n| --- | --- |\n| Fig | Medium \\| high |"].join("\n\n"),
    );
  });

  it("writes Markdown and HTML", () => {
    expect(toMarkdown(outline)).toBe(
      "# Office plants\n\n_For north-facing light_\n\n## Fiddle-leaf fig\n\nBright, indirect light — not (direct) sun.\n\n- Water weekly\n- 1.8–3 m tall\n\n| Plant | Care |\n| --- | --- |\n| Fig | Medium \\| high |\n",
    );
    const html = renderDocument({ ...outline, title: "<Plants & co>" }, "html").text!;
    expect(html).toContain("<title>&lt;Plants &amp; co&gt;</title>");
    expect(html).toContain("<ul>\n<li>Water weekly</li>\n<li>1.8–3 m tall</li>\n</ul>");
  });
});

describe("artifacts in replies", () => {
  const page = '<!doctype html>\n<html><head><title>Sales Dashboard</title></head><body><canvas></canvas></body></html>';
  const reply = (text: string): UiMessage => ({ id: "m9", role: "assistant", parts: [{ type: "text", text }], meta: { model: "kimi-k2" } as any });

  it("finds HTML pages, SVG and Mermaid in code blocks", () => {
    const items = replyArtifacts(
      reply(
        [
          "Here's your dashboard:",
          "```html",
          page,
          "```",
          "And the flow:",
          "```mermaid",
          "graph TD; A-->B",
          "```",
          "```",
          '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>',
          "```",
          "```python",
          "print('not an artifact')",
          "```",
          "```html",
          "<b>snippet</b>",
          "```",
        ].join("\n"),
      ),
    );
    expect(items.map((i) => [i.name, i.mediaType, i.origin])).toEqual([
      ["sales-dashboard.html", "text/html", "Reply · kimi-k2"],
      ["diagram.mmd", "text/vnd.mermaid", "Reply · kimi-k2"],
      ["diagram.svg", "image/svg+xml", "Reply · kimi-k2"],
      ["page-2.html", "text/html", "Reply · kimi-k2"],
    ]);
    expect(items[0]!.id).toBe(artifactId("m9", page));
    expect(isFullPage("html", items[0]!.text!)).toBe(true);
    expect(isFullPage("html", items[3]!.text!)).toBe(false);
    expect(previewKind(items[1]!.mediaType)).toBe("mermaid");
  });

  it("treats a reply that is a bare page as one", () => {
    expect(replyArtifacts(reply(page)).map((i) => i.name)).toEqual(["sales-dashboard.html"]);
    // Unfinished blocks (still streaming) and user messages aren't artifacts.
    expect(replyArtifacts(reply("```html\n<html><body>"))).toEqual([]);
    expect(replyArtifacts({ ...reply(page), role: "user" })).toEqual([]);
    expect(artifactKind(undefined, "<svg/>")).toBe("svg");
    expect(artifactKind("js", "<html>")).toBeUndefined();
  });

  it("lists the hosts a page loads from, and can block them", () => {
    const html = '<html><head><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><link href="//fonts.googleapis.com/css2?family=Inter" rel="stylesheet"><style>@import url("https://example.org/x.css");</style></head><body><a href="https://docs.example.com">docs</a><img src="data:image/png;base64,xx"></body></html>';
    expect(externalHosts(html)).toEqual(["cdn.jsdelivr.net", "fonts.googleapis.com", "example.org"]);
    expect(offline(html)).toMatch(/^<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'/);
    expect(offline("<p>hi</p>").startsWith("<meta http-equiv")).toBe(true);
  });
});
