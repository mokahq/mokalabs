import { Code2, Eye, FileCode2, Maximize2 } from "lucide-react";
import { createContext, memo, useContext, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { artifactId, artifactKind, isFullPage } from "../preview";
import { useStore } from "../store";
import { MermaidDiagram } from "./Diagram";
import { CopyButton, IconButton, cn } from "./ui";

/** The reply a code block belongs to, so HTML, SVG and Mermaid blocks can open in the preview pane. */
const ReplyContext = createContext<string | undefined>(undefined);

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const text = String(children ?? "").replace(/\n$/, "");
  const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1];
  const messageId = useContext(ReplyContext);
  const kind = messageId ? artifactKind(lang, text) : undefined;
  if (kind && messageId) return <Artifact kind={kind} code={text} lang={lang} className={className} id={artifactId(messageId, text)} />;
  return <PlainCode text={text} lang={lang} className={className} />;
}

function PlainCode({ text, lang, className, actions }: { text: string; lang?: string; className?: string; actions?: React.ReactNode }) {
  return (
    <div className="group relative">
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {lang && <span className="font-mono text-[10px] text-subtle uppercase">{lang}</span>}
        {actions}
        <CopyButton text={text} />
      </div>
      <pre>
        <code className={className}>{text}</code>
      </pre>
    </div>
  );
}

/**
 * HTML, SVG and Mermaid that a model wrote: diagrams and SVG are drawn in
 * place (with their code a click away), a whole HTML page shows as a card that
 * opens it next to the chat, and HTML snippets get a Preview button.
 */
function Artifact({ kind, code, lang, className, id }: { kind: "html" | "svg" | "mermaid"; code: string; lang?: string; className?: string; id: string }) {
  const openPreview = useStore((s) => s.openPreview);
  const open = useStore((s) => s.previewId === id);
  const [showCode, setShowCode] = useState(false);

  if (kind === "html" && isFullPage(kind, code) && !showCode) {
    const title = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(code)?.[1]?.trim();
    return (
      <div className={cn("flex items-center gap-3 rounded-xl border bg-panel px-3 py-2.5", open ? "border-accent" : "border-line")}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <FileCode2 className="h-4 w-4" />
        </span>
        <button className="min-w-0 flex-1 text-left" onClick={() => openPreview(id)}>
          <span className="block truncate text-[13px] font-medium">{title || "HTML page"}</span>
          <span className="block text-[11px] text-subtle">
            HTML · {code.split("\n").length} lines · {open ? "open in the preview" : "click to preview"}
          </span>
        </button>
        <IconButton label="Show code" className="h-7 w-7" onClick={() => setShowCode(true)}>
          <Code2 className="h-3.5 w-3.5" />
        </IconButton>
        <CopyButton text={code} className="h-7 w-7" />
      </div>
    );
  }

  const previewButton = (
    <IconButton label={kind === "html" ? "Preview" : "Open in the preview pane"} className="h-6 w-6" onClick={() => openPreview(id)}>
      {kind === "html" ? <Eye className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
    </IconButton>
  );

  if (kind === "html" || showCode) {
    return (
      <PlainCode
        text={code}
        lang={lang}
        className={className}
        actions={
          <>
            {kind !== "html" && (
              <IconButton label="Show diagram" className="h-6 w-6" onClick={() => setShowCode(false)}>
                <Eye className="h-3 w-3" />
              </IconButton>
            )}
            {previewButton}
          </>
        }
      />
    );
  }

  return (
    <div className="group relative rounded-xl border border-line bg-panel p-3">
      <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <IconButton label="Show code" className="h-6 w-6" onClick={() => setShowCode(true)}>
          <Code2 className="h-3 w-3" />
        </IconButton>
        {previewButton}
        <CopyButton text={code} />
      </div>
      {kind === "mermaid" ? (
        <MermaidDiagram code={code} className="flex justify-center" />
      ) : (
        // As an image, so scripts in it don't run.
        <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`} alt="SVG" className="mx-auto max-h-96 max-w-full" />
      )}
    </div>
  );
}

/** `messageId`: the reply this text belongs to (once it's complete), so its HTML, SVG and Mermaid can be shown. */
export const Markdown = memo(function Markdown({ text, className, messageId }: { text: string; className?: string; messageId?: string }) {
  return (
    <ReplyContext.Provider value={messageId}>
      <div className={`prose-moka ${className ?? ""}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            pre: ({ children }) => <>{children}</>,
            code: ({ className: cls, children, ...props }) => {
              const inline = !cls && !String(children).includes("\n");
              if (inline) return <code {...props}>{children}</code>;
              return <CodeBlock className={cls}>{children}</CodeBlock>;
            },
            a: ({ children, href }) => (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    </ReplyContext.Provider>
  );
});
