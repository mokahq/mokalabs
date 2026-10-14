/**
 * PDF support, loaded only when a PDF is opened or attached: pdf.js renders
 * pages in the preview pane (the same in every browser, and in headless ones)
 * and reads the text, so models that can't take PDF files still can read them.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";

let lib: Promise<typeof import("pdfjs-dist")> | undefined;

// The legacy build: the modern one needs very recent browsers (e.g. Map.getOrInsertComputed).
function pdfjs(): Promise<typeof import("pdfjs-dist")> {
  lib ??= Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")]).then(([m, worker]) => {
    m.GlobalWorkerOptions.workerSrc = worker.default;
    return m;
  });
  return lib;
}

/** Open a PDF; `close()` frees it (and its worker work) when it's no longer shown. */
export async function openPdf(bytes: Uint8Array): Promise<{ doc: PDFDocumentProxy; close: () => void }> {
  const m = await pdfjs();
  // pdf.js takes ownership of the buffer it's given, so hand it a copy.
  const task = m.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  return { doc, close: () => void task.destroy() };
}

/** The text of every page, marked with page numbers so a model can cite them. */
export async function pdfToText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const { doc, close } = await openPdf(bytes);
  try {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      pages.push(`--- Page ${n} ---\n${text}`);
      page.cleanup();
    }
    return { text: pages.join("\n\n"), pages: doc.numPages };
  } finally {
    close();
  }
}
