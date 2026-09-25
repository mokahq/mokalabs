import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./ui";

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const text = String(children ?? "").replace(/\n$/, "");
  const lang = /language-(\w+)/.exec(className ?? "")?.[1];
  return (
    <div className="group relative">
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {lang && <span className="font-mono text-[10px] text-subtle uppercase">{lang}</span>}
        <CopyButton text={text} />
      </div>
      <pre>
        <code className={className}>{text}</code>
      </pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
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
  );
});
