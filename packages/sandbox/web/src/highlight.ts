import { useEffect, useMemo, useState } from "react";
import type { HighlighterCore, LanguageInput } from "shiki/core";

/**
 * Syntax highlighting with Shiki, loaded only when code is on screen: the
 * core, the two themes and each language are separate chunks, and the
 * JavaScript regex engine avoids shipping a WebAssembly file. Colors follow
 * the light/dark theme through CSS variables (see `.shiki-code` in styles.css).
 */

const LANGS: Record<string, () => Promise<{ default: LanguageInput }>> = {
  bash: () => import("shiki/dist/langs/bash.mjs"),
  c: () => import("shiki/dist/langs/c.mjs"),
  cpp: () => import("shiki/dist/langs/cpp.mjs"),
  csharp: () => import("shiki/dist/langs/csharp.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  diff: () => import("shiki/dist/langs/diff.mjs"),
  docker: () => import("shiki/dist/langs/docker.mjs"),
  go: () => import("shiki/dist/langs/go.mjs"),
  graphql: () => import("shiki/dist/langs/graphql.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  ini: () => import("shiki/dist/langs/ini.mjs"),
  java: () => import("shiki/dist/langs/java.mjs"),
  javascript: () => import("shiki/dist/langs/javascript.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  jsonc: () => import("shiki/dist/langs/jsonc.mjs"),
  jsx: () => import("shiki/dist/langs/jsx.mjs"),
  kotlin: () => import("shiki/dist/langs/kotlin.mjs"),
  less: () => import("shiki/dist/langs/less.mjs"),
  lua: () => import("shiki/dist/langs/lua.mjs"),
  make: () => import("shiki/dist/langs/make.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"),
  mermaid: () => import("shiki/dist/langs/mermaid.mjs"),
  php: () => import("shiki/dist/langs/php.mjs"),
  powershell: () => import("shiki/dist/langs/powershell.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  r: () => import("shiki/dist/langs/r.mjs"),
  ruby: () => import("shiki/dist/langs/ruby.mjs"),
  rust: () => import("shiki/dist/langs/rust.mjs"),
  scss: () => import("shiki/dist/langs/scss.mjs"),
  shellsession: () => import("shiki/dist/langs/shellsession.mjs"),
  sql: () => import("shiki/dist/langs/sql.mjs"),
  svelte: () => import("shiki/dist/langs/svelte.mjs"),
  swift: () => import("shiki/dist/langs/swift.mjs"),
  toml: () => import("shiki/dist/langs/toml.mjs"),
  tsx: () => import("shiki/dist/langs/tsx.mjs"),
  typescript: () => import("shiki/dist/langs/typescript.mjs"),
  vue: () => import("shiki/dist/langs/vue.mjs"),
  xml: () => import("shiki/dist/langs/xml.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
};

const ALIASES: Record<string, string> = {
  sh: "bash", shell: "bash", zsh: "bash", console: "shellsession", terminal: "shellsession",
  js: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript",
  py: "python", python3: "python", rb: "ruby", rs: "rust", golang: "go", kt: "kotlin",
  "c++": "cpp", cc: "cpp", h: "c", hpp: "cpp", cs: "csharp", "c#": "csharp",
  yml: "yaml", md: "markdown", mdx: "markdown", htm: "html", xhtml: "html", svg: "xml",
  dockerfile: "docker", makefile: "make", ps1: "powershell", ps: "powershell", pwsh: "powershell",
  gql: "graphql", patch: "diff", cfg: "ini", conf: "ini", env: "ini", properties: "ini", sqlite: "sql", postgres: "sql", psql: "sql",
};

/** The Shiki language for a fence label or file extension, if Moka highlights it. */
export function languageOf(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const key = label.toLowerCase().trim();
  const name = ALIASES[key] ?? key;
  return name in LANGS ? name : undefined;
}

/** The language for a file name (by extension, or a well-known name like Dockerfile). */
export function languageOfFile(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const base = name.split(/[\\/]/).pop()!.toLowerCase();
  if (base === "dockerfile") return "docker";
  if (base === "makefile") return "make";
  const ext = /\.([\w+-]+)$/.exec(base)?.[1];
  return languageOf(ext);
}

// Very large inputs stay plain: highlighting them would block the page.
const MAX_CHARS = 200_000;

let core: Promise<HighlighterCore> | undefined;
let ready: HighlighterCore | undefined;
const loading = new Map<string, Promise<void>>();

function highlighter(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/dist/themes/github-light-default.mjs"),
      import("shiki/dist/themes/github-dark-default.mjs"),
    ]);
    ready = await createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
    return ready;
  })();
  return core;
}

/** Load the highlighter and a language (once; later calls share the same promise). */
function prepare(lang: string): Promise<void> {
  let pending = loading.get(lang);
  if (!pending) {
    pending = highlighter().then(async (h) => {
      const mod = await LANGS[lang]!();
      await h.loadLanguage(mod.default);
    });
    loading.set(lang, pending);
  }
  return pending;
}

function isReady(lang: string): boolean {
  return Boolean(ready?.getLoadedLanguages().includes(lang));
}

/** Highlighted HTML for the inside of a `<code>` element (one `span.line` per line), if the language is loaded. */
function highlightNow(code: string, lang: string): string | undefined {
  if (!ready || code.length > MAX_CHARS) return undefined;
  try {
    const html = ready.codeToHtml(code, { lang, themes: { light: "github-light-default", dark: "github-dark-default" }, defaultColor: false });
    return /<code[^>]*>([\s\S]*)<\/code>/.exec(html)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Highlighted HTML for `code`, or undefined while the language loads (and for
 * languages Moka doesn't highlight). Once a language is loaded, highlighting
 * is synchronous, so text being streamed or typed never flickers.
 */
export function useHighlight(code: string, label: string | undefined): string | undefined {
  const lang = languageOf(label);
  const [, loaded] = useState(0);
  const available = lang ? isReady(lang) : false;
  useEffect(() => {
    if (!lang || isReady(lang) || code.length > MAX_CHARS) return;
    let cancelled = false;
    prepare(lang)
      .then(() => !cancelled && loaded((n) => n + 1))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [lang]);
  return useMemo(() => (lang && available ? highlightNow(code, lang) : undefined), [code, lang, available]);
}
