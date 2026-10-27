import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Options } from "react-markdown";

type Pluggable = NonNullable<Options["rehypePlugins"]>[number];

/*
 * What model replies may use beyond plain Markdown: a short list of inline
 * HTML (colors, highlights, keys, sub/superscript), GitHub-style callouts, and
 * math. Everything else in raw HTML is dropped; text inside is kept.
 */

/** Raw HTML Moka renders in replies, on top of GitHub's safe list. */
export const sanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "u", "small", "abbr", "font"],
  attributes: {
    ...defaultSchema.attributes,
    // Only colors and emphasis survive (see rehypeSafeStyle).
    span: ["style"],
    mark: ["style"],
    font: ["color"],
    abbr: ["title"],
    code: [["className", /^language-./, "math-inline", "math-display"]],
    div: [...(defaultSchema.attributes?.div ?? []), ["className", /^callout(-[a-z]+)?$/]],
    p: [["className", "callout-title"]],
  },
};

const STYLE_PROPS = new Set(["color", "background-color", "background", "font-weight", "font-style", "text-decoration"]);
const STYLE_VALUE = /^[#\w\s(),.%-]+$/;

/** Keeps only safe color and emphasis declarations in `style` attributes (no url(), no layout), and fixes footnote ids. */
export function rehypeSafeStyle() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (node.type === "element") {
        // Footnote ids get the sanitizer's prefix on top of remark's own; their links only have one.
        const id = node.properties?.id;
        if (typeof id === "string" && id.startsWith("user-content-user-content-")) node.properties.id = id.slice("user-content-".length);
        const style = node.properties?.style;
        if (typeof style === "string") {
          const kept = style
            .split(";")
            .map((d: string) => d.split(":").map((x) => x.trim()))
            .filter(([prop, value]: string[]) => prop && value && STYLE_PROPS.has(prop.toLowerCase()) && STYLE_VALUE.test(value) && !/url|expression|var\(/i.test(value))
            .map(([prop, value]: string[]) => `${prop}:${value}`)
            .join(";");
          if (kept) node.properties.style = kept;
          else delete node.properties.style;
        }
        // <font color="red"> → <span style="color:red">
        if (node.tagName === "font") {
          const color = node.properties?.color;
          node.tagName = "span";
          node.properties = typeof color === "string" && STYLE_VALUE.test(color) && !/url|expression/i.test(color) ? { style: `color:${color}` } : {};
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

const CALLOUTS: Record<string, string> = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

/** `> [!NOTE]` (GitHub alerts) → a colored callout with a title. */
export function remarkCallouts() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (node.type === "blockquote") {
        const first = node.children?.[0];
        const text = first?.type === "paragraph" ? first.children?.[0] : undefined;
        const match = text?.type === "text" ? /^\[!(note|tip|important|warning|caution)\][ \t]*\n?/i.exec(text.value) : null;
        if (match) {
          const kind = match[1]!.toLowerCase();
          text.value = text.value.slice(match[0].length);
          if (!text.value) first.children.shift();
          if (first.children[0]?.type === "break") first.children.shift();
          if (!first.children.length) node.children.shift();
          node.data = { hName: "div", hProperties: { className: ["callout", `callout-${kind}`] } };
          node.children.unshift({ type: "paragraph", data: { hProperties: { className: ["callout-title"] } }, children: [{ type: "text", value: CALLOUTS[kind] }] });
          return;
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

/**
 * Math in the forms models write, normalised for remark-math: `\( x \)` and
 * `$x$` inline, `\[ x \]` and `$$ x $$` as blocks. A single `$` only counts
 * when it hugs its content (`$x$`, not `$5 and $10`), as in Pandoc. Code is
 * left alone.
 */
export function normalizeMath(text: string): string {
  if (!/[$\\]/.test(text)) return text;
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part; // code
      return part
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `\n$$\n${m.trim()}\n$$\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `$$${m.trim()}$$`)
        .replace(/(^|[^$\\\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])/g, (_, pre: string, m: string) => `${pre}$$${m}$$`);
    })
    .join("");
}

export function hasMath(text: string): boolean {
  return text.includes("$$");
}

let katex: Promise<Pluggable> | undefined;
let katexReady: Pluggable | undefined;

/** rehype-katex and its stylesheet, loaded the first time a reply has math. */
export function loadKatex(): Promise<Pluggable> {
  katex ??= Promise.all([import("rehype-katex"), import("katex/dist/katex.min.css")]).then(([m]) => {
    katexReady = [m.default, { throwOnError: false, strict: "ignore" }] as Pluggable;
    return katexReady;
  });
  return katex;
}

export function katexPlugin(): Pluggable | undefined {
  return katexReady;
}

/** The Markdown pipeline for replies (Markdown.tsx), shared with the tests. */
export const remarkPlugins: NonNullable<Options["remarkPlugins"]> = [remarkGfm, [remarkMath, { singleDollarTextMath: false }], remarkCallouts];

export function rehypePlugins(katex?: Pluggable): NonNullable<Options["rehypePlugins"]> {
  return [rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeSafeStyle, ...(katex ? [katex] : [])];
}
