import { docxToMarkdown } from "./docx";
import { dataUrlBytes, previewKind } from "./preview";

const MAX_TEXT = 400_000;
export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * The text of an attached PDF or Word file, wrapped like other attached files
 * (`<file name="…">…</file>`). Models that can't take the file itself (LM
 * Studio, Ollama, most gateways) get this instead; see adaptAttachments in core.
 */
export async function documentText(name: string, mediaType: string, dataUrl: string): Promise<string | undefined> {
  const kind = previewKind(mediaType, name);
  let body: string;
  let attrs = "";
  if (kind === "pdf") {
    const { pdfToText } = await import("./pdf");
    const { text, pages } = await pdfToText(dataUrlBytes(dataUrl));
    attrs = ` pages="${pages}"`;
    body = text.replace(/--- Page \d+ ---\s*/g, "").trim()
      ? text
      : "[This PDF has no text layer (it's probably scanned pages), so only its images could be read, by a model that reads PDFs.]";
  } else if (kind === "docx") {
    body = await docxToMarkdown(dataUrlBytes(dataUrl));
  } else {
    return undefined;
  }
  if (body.length > MAX_TEXT) body = `${body.slice(0, MAX_TEXT)}\n\n[… truncated: the file has ${body.length.toLocaleString()} characters of text]`;
  return `<file name="${name.replace(/"/g, "'")}"${attrs}>\n${body}\n</file>`;
}
