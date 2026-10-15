import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { acceptsFile, adaptAttachments } from "../src/attachments.js";

const pdf = { type: "file" as const, data: "data:application/pdf;base64,JVBERg==", mediaType: "application/pdf", filename: "plants.pdf", providerOptions: { moka: { text: '<file name="plants.pdf" pages="1">\n--- Page 1 ---\nFig\n</file>' } } };
const docx = { type: "file" as const, data: "data:;base64,UEs=", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "brief.docx", providerOptions: { moka: { text: '<file name="brief.docx">\n# Brief\n</file>' } } };
const zip = { type: "file" as const, data: "data:application/zip;base64,UEs=", mediaType: "application/zip", filename: "logs.zip" };
const messages: ModelMessage[] = [
  { role: "system", content: "Be brief." },
  { role: "user", content: [pdf, docx, zip, { type: "image", image: "data:image/png;base64,iVBO", mediaType: "image/png" }, { type: "text", text: "Summarise" }] },
  { role: "assistant", content: "Sure." },
  { role: "user", content: "Thanks" },
];

describe("attachments", () => {
  it("knows which providers take which files", () => {
    expect(acceptsFile("anthropic", "application/pdf")).toBe(true);
    expect(acceptsFile("openai", "application/pdf")).toBe(true);
    expect(acceptsFile("openai-compatible", "application/pdf")).toBe(false);
    expect(acceptsFile("ollama", "image/png")).toBe(true);
    expect(acceptsFile("google", "audio/mpeg")).toBe(true);
    expect(acceptsFile("anthropic", docx.mediaType)).toBe(false);
  });

  it("gives LM Studio, Ollama and gateways the text Moka read from the file", () => {
    const adapted = adaptAttachments(messages, "openai-compatible");
    const content = (adapted[1] as any).content;
    expect(content.map((p: any) => p.type)).toEqual(["text", "text", "text", "image", "text"]);
    expect(content[0].text).toContain("--- Page 1 ---\nFig");
    expect(content[1].text).toContain("# Brief");
    expect(content[2].text).toMatch(/^<file name="logs.zip" type="application\/zip">\n\[This model can't read application\/zip files/);
    // Other messages are untouched.
    expect(adapted[0]).toBe(messages[0]);
    expect(adapted[3]).toBe(messages[3]);
  });

  it("keeps the PDF for providers that read PDFs, and converts the rest", () => {
    const content = (adaptAttachments(messages, "anthropic")[1] as any).content;
    expect(content[0]).toBe(pdf);
    expect(content[1].type).toBe("text");
    expect(content[2].type).toBe("text");
  });

  it("returns the same array when there's nothing to change", () => {
    const plain: ModelMessage[] = [{ role: "user", content: "hi" }];
    expect(adaptAttachments(plain, "ollama")).toBe(plain);
  });
});
