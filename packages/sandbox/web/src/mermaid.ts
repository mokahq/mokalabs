/**
 * Mermaid diagrams, loaded only when one is shown. `securityLevel: "strict"`
 * sanitizes labels and disables click handlers, so a diagram can't run script.
 */
let lib: Promise<typeof import("mermaid").default> | undefined;
let theme: string | undefined;
let count = 0;

export async function renderMermaid(code: string, dark: boolean): Promise<string> {
  lib ??= import("mermaid").then((m) => m.default);
  const mermaid = await lib;
  const next = dark ? "dark" : "default";
  if (theme !== next) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: next, fontFamily: "inherit" });
    theme = next;
  }
  const { svg } = await mermaid.render(`moka-mermaid-${++count}`, code);
  return svg;
}
