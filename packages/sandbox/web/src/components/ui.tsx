import { Check, ChevronDown, Copy, Plus, Trash2, X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "xs" | "sm" | "md";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110 shadow-sm",
  secondary: "bg-panel-2 text-fg hover:bg-elev border border-line",
  outline: "border border-line-strong text-fg hover:bg-panel-2",
  ghost: "text-muted hover:text-fg hover:bg-panel-2",
  danger: "text-err hover:bg-err/10",
};
const sizes: Record<Size, string> = {
  xs: "h-7 px-2 text-xs gap-1 rounded-md",
  sm: "h-8 px-2.5 text-[13px] gap-1.5 rounded-lg",
  md: "h-9 px-3.5 text-sm gap-2 rounded-lg",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: ReactNode; loading?: boolean }
>(function Button({ variant = "secondary", size = "md", icon, loading, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center font-medium whitespace-nowrap transition-all select-none",
        "disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-accent/60 focus-visible:outline-offset-1",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});

export function IconButton({
  label,
  className,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-panel-2 hover:text-fg",
        active && "bg-panel-2 text-fg",
        className,
      )}
      {...rest}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("h-3.5 w-3.5 animate-spin", className)} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

const field =
  "w-full rounded-lg border border-line bg-panel px-3 text-sm text-fg placeholder:text-subtle transition-colors focus:border-accent/60 focus:outline-none focus:ring-3 focus:ring-accent/15";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  function Input({ className, mono, ...rest }, ref) {
    return <input ref={ref} className={cn(field, "h-9", mono && "font-mono text-[13px]", className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(
  function Textarea({ className, mono, ...rest }, ref) {
    return <textarea ref={ref} className={cn(field, "py-2 leading-relaxed", mono && "font-mono text-[13px]", className)} {...rest} />;
  },
);

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={cn(field, "h-9 appearance-none pr-8", className)} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2 text-subtle" />
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
  right,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
  right?: ReactNode;
}) {
  return (
    <label className={cn("block", className)}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-fg">{label}</span>
        {right}
      </div>
      {children}
      {error ? <p className="mt-1 text-xs text-err">{error}</p> : hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </label>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-accent" : "bg-line-strong",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "ok" | "warn" | "err" | "info" | "violet";
  className?: string;
}) {
  const tones = {
    neutral: "bg-panel-2 text-muted border-line",
    accent: "bg-accent-soft text-accent border-accent/20",
    ok: "bg-ok/10 text-ok border-ok/20",
    warn: "bg-warn/10 text-warn border-warn/20",
    err: "bg-err/10 text-err border-err/20",
    info: "bg-info/10 text-info border-info/20",
    violet: "bg-violet/10 text-violet border-violet/20",
  };
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none", tones[tone], className)}>
      {children}
    </span>
  );
}

export function StatusDot({ status }: { status: string }) {
  const color =
    status === "connected" ? "bg-ok" : status === "connecting" ? "bg-warn animate-pulse" : status === "error" ? "bg-err" : "bg-subtle";
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", color)} />;
}

export function Modal({
  open,
  onClose,
  children,
  className,
  title,
  description,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        className={cn("animate-in relative flex max-h-[90vh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-soft", className?.includes("max-w-") ? "" : "max-w-lg", className)}
      >
        {title && (
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 className="text-[15px] font-semibold">{title}</h2>
              {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
            </div>
            <IconButton label="Close" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  items: Array<{ value: T; label: ReactNode; icon?: ReactNode }>;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={cn("inline-flex items-center gap-0.5 rounded-lg border border-line bg-panel-2 p-0.5", className)}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => onChange(item.value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-all",
            size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-2.5 text-[13px]",
            value === item.value ? "bg-panel text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ text, className, label = "Copy" }: { text: string; className?: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={label}
      className={cn("h-7 w-7", className)}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
    </IconButton>
  );
}

/** Editable list of key/value pairs (headers, env vars). */
export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = "KEY",
  valuePlaceholder = "value",
  secretKeys = /(key|token|secret|password|authorization)/i,
}: {
  value: Record<string, string> | undefined;
  onChange: (next: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  secretKeys?: RegExp;
}) {
  const [rows, setRows] = useState<Array<[string, string]>>(() => Object.entries(value ?? {}));
  useEffect(() => {
    const current = Object.entries(value ?? {});
    const fromRows = Object.fromEntries(rows.filter(([k]) => k));
    if (JSON.stringify(current) !== JSON.stringify(Object.entries(fromRows))) setRows(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);
  const commit = (next: Array<[string, string]>) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter(([k]) => k.trim())));
  };
  return (
    <div className="space-y-1.5">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex gap-1.5">
          <Input mono className="w-2/5" placeholder={keyPlaceholder} value={k} onChange={(e) => commit(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          <Input
            mono
            className="flex-1"
            placeholder={valuePlaceholder}
            type={secretKeys.test(k) && !v.startsWith("env:") && !v.startsWith("${") ? "password" : "text"}
            value={v}
            onChange={(e) => commit(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
          />
          <IconButton label="Remove" className="h-9 w-9 shrink-0" onClick={() => commit(rows.filter((_, j) => j !== i))}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      ))}
      <Button type="button" size="xs" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setRows([...rows, ["", ""]])}>
        Add
      </Button>
    </div>
  );
}

/** Collapsible, syntax-tinted JSON viewer. */
export function JsonView({ value, className, maxHeight = "24rem" }: { value: unknown; className?: string; maxHeight?: string }) {
  const text = typeof value === "string" ? value : safeStringify(value);
  const html = typeof value === "string" ? escapeHtml(text) : highlightJson(text);
  return (
    <div className={cn("group relative rounded-lg border border-line bg-panel-2", className)}>
      <CopyButton text={text} className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100" />
      <pre
        className="overflow-auto p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all"
        style={{ maxHeight }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightJson(json: string): string {
  return escapeHtml(json).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let color = "var(--ok)";
      if (/^"/.test(match)) color = /:$/.test(match) ? "var(--info)" : "var(--accent)";
      else if (/true|false/.test(match)) color = "var(--violet)";
      else if (/null/.test(match)) color = "var(--subtle)";
      else color = "var(--warn)";
      return `<span style="color:${color}">${match}</span>`;
    },
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-panel-2 text-muted">{icon}</div>}
      <h3 className="text-sm font-semibold">{title}</h3>
      {children && <p className="mt-1 max-w-sm text-[13px] text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">{children}</kbd>;
}

export function formatMs(ms?: number): string {
  if (ms === undefined || ms === null) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatNumber(n?: number): string {
  if (n === undefined || n === null) return "–";
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
}
