import type { ReactNode } from "react";
import { languageOf, useHighlight } from "../highlight";
import { CopyButton, cn } from "./ui";

const NAMES: Record<string, string> = {
  bash: "Bash", c: "C", cpp: "C++", csharp: "C#", css: "CSS", diff: "Diff", docker: "Dockerfile", go: "Go", graphql: "GraphQL",
  html: "HTML", ini: "INI", java: "Java", javascript: "JavaScript", json: "JSON", jsonc: "JSON", jsx: "JSX", kotlin: "Kotlin",
  less: "Less", lua: "Lua", make: "Makefile", markdown: "Markdown", mermaid: "Mermaid", php: "PHP", powershell: "PowerShell",
  python: "Python", r: "R", ruby: "Ruby", rust: "Rust", scss: "SCSS", shellsession: "Terminal", sql: "SQL", svelte: "Svelte",
  swift: "Swift", toml: "TOML", tsx: "TSX", typescript: "TypeScript", vue: "Vue", xml: "XML", yaml: "YAML",
};

/** A readable name for a fence label: "ts" → "TypeScript". Unknown labels are shown as written. */
export function languageName(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const lang = languageOf(label);
  return lang ? NAMES[lang] : label;
}

/** Highlighted code, plain until the highlighter has loaded (and for languages Moka doesn't know). */
export function Highlighted({ code, lang, className, wrap }: { code: string; lang?: string; className?: string; wrap?: boolean }) {
  const html = useHighlight(code, lang);
  return (
    <pre className={cn("shiki-code", wrap && "whitespace-pre-wrap break-words", className)}>
      {html !== undefined ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
    </pre>
  );
}

/**
 * A code editor: a textarea with transparent text over the highlighted code,
 * in the same grid cell so both grow and scroll together. Lines wrap, so
 * there's no horizontal scrolling to keep in sync.
 */
export function CodeEditor({
  value,
  onChange,
  lang,
  rows = 10,
  className,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  lang?: string;
  rows?: number;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const html = useHighlight(value, lang);
  const layer = "col-start-1 row-start-1 m-0 min-w-0 px-3 py-2 font-mono text-[12.5px] leading-[1.6] whitespace-pre-wrap break-words";
  return (
    <div
      className={cn("shiki-code overflow-auto rounded-lg border border-line bg-panel transition-colors focus-within:border-accent/60 focus-within:ring-3 focus-within:ring-accent/15", className)}
      style={{ height: `calc(${rows} * 1.6 * 12.5px + 1rem + 2px)` }}
    >
      <div className="grid min-h-full">
        <pre aria-hidden className={cn(layer, "pointer-events-none text-fg")}>
          {html !== undefined ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{value}</code>}
          {"\n"}
        </pre>
        <textarea
          aria-label={ariaLabel}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(layer, "resize-none overflow-hidden bg-transparent text-transparent caret-[var(--fg)] outline-none selection:bg-accent/25 placeholder:text-subtle")}
        />
      </div>
    </div>
  );
}

/** A code block with a header (language, actions, copy), as in chat replies. */
export function CodeBlockView({ code, lang, actions, className }: { code: string; lang?: string; actions?: ReactNode; className?: string }) {
  const name = languageName(lang);
  return (
    <div className={cn("code-block overflow-hidden rounded-xl border border-line bg-panel-2", className)}>
      <div className="flex h-8 items-center gap-1 border-b border-line pr-1.5 pl-3">
        <span className="flex-1 truncate font-mono text-[11px] text-subtle">{name ?? "text"}</span>
        {actions}
        <CopyButton text={code} className="h-6 w-6" />
      </div>
      <Highlighted code={code} lang={lang} />
    </div>
  );
}
