import { ChevronDown, Code2, Download, Eye, File, FileImage, FileText, FileType2, Film, Globe, Maximize2, Minimize2, Minus, Music, Plus, Sheet, Workflow, X } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { docxToMarkdown } from "../docx";
import { openPdf } from "../pdf";
import { collectPreviews, dataUrlBytes, externalHosts, formatBytes, offline, parseCsv, previewKind, toolFiles, type PreviewItem, type PreviewKind } from "../preview";
import { useStore } from "../store";
import type { Part } from "../types";
import { MermaidDiagram } from "./Diagram";
import { Markdown } from "./Markdown";
import { CopyButton, IconButton, JsonView, Spinner, cn } from "./ui";

const WIDTH_KEY = "moka.preview.width";
const MAX_ROWS = 1000;

function savedWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    if (n >= 320) return n;
  } catch {
    // storage blocked
  }
  return Math.round(Math.max(420, window.innerWidth * 0.42));
}

const KIND_LABEL: Record<PreviewKind, string> = {
  image: "Image", svg: "SVG", pdf: "PDF", html: "HTML", markdown: "Markdown", mermaid: "Diagram", json: "JSON", csv: "Table", docx: "Word", audio: "Audio", video: "Video", text: "Text", binary: "File",
};

export function KindIcon({ kind, className }: { kind: PreviewKind; className?: string }) {
  const Icon = kind === "mermaid" ? Workflow : kind === "image" || kind === "svg" ? FileImage : kind === "pdf" || kind === "docx" ? FileType2 : kind === "csv" ? Sheet : kind === "audio" ? Music : kind === "video" ? Film : kind === "binary" ? File : FileText;
  return <Icon className={className} />;
}

/** What the viewer needs: text for text-like kinds, bytes for the rest. */
interface Loaded {
  dataUrl?: string;
  text?: string;
  mediaType: string;
}

const TEXTUAL: PreviewKind[] = ["svg", "html", "markdown", "mermaid", "json", "csv", "text"];

/** Reads a resource link from its MCP server; decodes inline data to text when the viewer wants text. */
function useContent(item: PreviewItem | undefined): { content?: Loaded; error?: string } {
  const [state, setState] = useState<{ id?: string; content?: Loaded; error?: string }>({});
  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    const kind = previewKind(item.mediaType, item.name);
    const finish = (content: Loaded) => {
      if (TEXTUAL.includes(kind) && content.text === undefined && content.dataUrl) content = { ...content, text: new TextDecoder().decode(dataUrlBytes(content.dataUrl)) };
      if (!cancelled) setState({ id: item.id, content });
    };
    if (item.text !== undefined || item.dataUrl) {
      finish({ text: item.text, dataUrl: item.dataUrl, mediaType: item.mediaType });
    } else if (item.link) {
      setState({ id: item.id });
      api<{ result: any }>(`/api/mcp/${encodeURIComponent(item.link.serverId)}/resource`, { body: { uri: item.link.uri } })
        .then(({ result }) => {
          const c = result?.contents?.[0];
          if (!c) throw new Error("The server returned no content for this resource");
          const mediaType = c.mimeType ?? item.mediaType;
          finish(typeof c.text === "string" ? { text: c.text, mediaType } : { dataUrl: `data:${mediaType};base64,${c.blob ?? ""}`, mediaType });
        })
        .catch((e) => !cancelled && setState({ id: item.id, error: e?.message ?? String(e) }));
    } else {
      setState({ id: item.id, error: "This file's content wasn't kept with the chat." });
    }
    return () => {
      cancelled = true;
    };
  }, [item?.id, item?.text, item?.dataUrl]);
  return state.id === item?.id ? state : {};
}

/** An object URL for bytes, revoked when it's no longer shown. */
function useObjectUrl(dataUrl: string | undefined, mediaType: string): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!dataUrl) return setUrl(undefined);
    const next = URL.createObjectURL(new Blob([dataUrlBytes(dataUrl) as BlobPart], { type: mediaType }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [dataUrl, mediaType]);
  return url;
}

function download(item: PreviewItem, content: Loaded) {
  const blob = content.dataUrl ? new Blob([dataUrlBytes(content.dataUrl) as BlobPart], { type: content.mediaType }) : new Blob([content.text ?? ""], { type: content.mediaType || "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = item.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Files from the chat, side by side with it: what you attached, and what
 * tools returned (images, PDFs, HTML, Markdown, Word, CSV, code). Documents a
 * tool makes open here on their own.
 */
export function PreviewPane() {
  const session = useStore((s) => s.session);
  const previewId = useStore((s) => s.previewId);
  const openPreview = useStore((s) => s.openPreview);
  const items = useMemo(() => collectPreviews(session.messages, session.modelMessages), [session.messages, session.modelMessages]);
  const item = items.find((i) => i.id === previewId);
  const [width, setWidth] = useState(savedWidth);
  const [source, setSource] = useState(false);
  const [menu, setMenu] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { content, error } = useContent(item);

  useEffect(() => setSource(false), [previewId]);

  if (!item) return null;
  const kind = previewKind(content?.mediaType ?? item.mediaType, item.name);
  const canSource = kind === "html" || kind === "svg" || kind === "markdown" || kind === "mermaid";
  // Expanded: as wide as it can be while the chat stays readable.
  const paneWidth = expanded ? Math.max(320, window.innerWidth - 520) : Math.min(width, Math.max(320, window.innerWidth - 520));

  const startResize = (down: React.PointerEvent) => {
    down.preventDefault();
    const startX = down.clientX;
    let last = paneWidth;
    setExpanded(false);
    const move = (e: PointerEvent) => {
      last = Math.round(Math.min(window.innerWidth - 480, Math.max(320, paneWidth + startX - e.clientX)));
      setWidth(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.removeProperty("cursor");
      try {
        localStorage.setItem(WIDTH_KEY, String(last));
      } catch {
        // storage blocked
      }
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside className="relative hidden min-w-[320px] shrink flex-col border-l border-line bg-panel md:flex" style={{ width: paneWidth }} aria-label="File preview">
      <div className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-accent/20" onPointerDown={startResize} title="Drag to resize" />
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <KindIcon kind={kind} className="h-4 w-4 shrink-0 text-accent" />
        <div className="relative min-w-0 flex-1">
          <button className="flex max-w-full items-center gap-1 text-left" onClick={() => setMenu(!menu)} disabled={items.length < 2} title={items.length > 1 ? "Files in this chat" : undefined}>
            <span className="truncate text-[13px] font-medium">{item.name}</span>
            {items.length > 1 && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-subtle" />}
          </button>
          <div className="truncate text-[11px] text-subtle">{[KIND_LABEL[kind], formatBytes(item.size), item.origin].filter(Boolean).join(" · ")}</div>
          {menu && <FileMenu items={items} current={item.id} onPick={(id) => (setMenu(false), openPreview(id))} onClose={() => setMenu(false)} />}
        </div>
        {canSource && (
          <IconButton label={source ? "Show preview" : "Show source"} className="h-7 w-7" onClick={() => setSource(!source)}>
            {source ? <Eye className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
          </IconButton>
        )}
        {content?.text !== undefined && <CopyButton text={content.text} className="h-7 w-7" />}
        {content && (
          <IconButton label="Download" className="h-7 w-7" onClick={() => download(item, content)}>
            <Download className="h-3.5 w-3.5" />
          </IconButton>
        )}
        <IconButton label={expanded ? "Restore width" : "Expand"} className="h-7 w-7" onClick={() => setExpanded(!expanded)}>
          {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </IconButton>
        <IconButton label="Close preview" className="h-7 w-7" onClick={() => openPreview(undefined)}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <Notice title="Couldn't open this file">{error}</Notice>
        ) : !content ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="h-5 w-5 text-accent" />
          </div>
        ) : (
          <Viewer key={item.id} kind={kind} item={item} content={content} source={source} />
        )}
      </div>
    </aside>
  );
}

function FileMenu({ items, current, onPick, onClose }: { items: PreviewItem[]; current: string; onPick: (id: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [onClose]);
  return (
    <div ref={ref} className="absolute top-full left-0 z-20 mt-1 max-h-80 w-80 overflow-y-auto rounded-xl border border-line bg-panel p-1 shadow-soft">
      <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">Files in this chat</div>
      {[...items].reverse().map((i) => (
        <button key={i.id} onClick={() => onPick(i.id)} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left", i.id === current ? "bg-panel-2" : "hover:bg-panel-2")}>
          <KindIcon kind={previewKind(i.mediaType, i.name)} className="h-3.5 w-3.5 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px]">{i.name}</span>
            <span className="block truncate text-[11px] text-subtle">{i.origin}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function Notice({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
      <p className="text-[13px] font-medium">{title}</p>
      {children && <p className="max-w-sm text-[12.5px] text-muted">{children}</p>}
    </div>
  );
}

function Viewer({ kind, item, content, source }: { kind: PreviewKind; item: PreviewItem; content: Loaded; source: boolean }) {
  const url = useObjectUrl(kind === "image" || kind === "audio" || kind === "video" ? content.dataUrl : undefined, content.mediaType);
  const text = content.text ?? "";
  if (source && (kind === "html" || kind === "svg" || kind === "markdown" || kind === "mermaid")) return <pre className="p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{text}</pre>;
  switch (kind) {
    case "pdf":
      return content.dataUrl ? <PdfView dataUrl={content.dataUrl} /> : null;
    case "image":
      return url ? (
        <div className="checkerboard flex min-h-full items-center justify-center p-4">
          <img src={url} alt={item.name} className="max-h-full max-w-full object-contain" />
        </div>
      ) : null;
    case "svg":
      // As an image, so scripts in it don't run.
      return (
        <div className="checkerboard flex min-h-full items-center justify-center p-4">
          <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`} alt={item.name} className="max-h-full max-w-full object-contain" />
        </div>
      );
    case "html":
      return <HtmlView html={text} title={item.name} />;
    case "mermaid":
      return (
        <div className="flex min-h-full items-center justify-center p-6">
          <MermaidDiagram code={text} />
        </div>
      );
    case "markdown":
      return (
        <div className="mx-auto max-w-3xl px-6 py-5">
          <Markdown text={text} />
        </div>
      );
    case "json":
      return (
        <div className="p-3">
          <JsonView value={parseJson(text)} maxHeight="none" />
        </div>
      );
    case "csv":
      return <CsvTable text={text} />;
    case "docx":
      return <DocxView dataUrl={content.dataUrl} />;
    case "audio":
      return url ? (
        <div className="flex h-full items-center justify-center p-6">
          <audio controls src={url} className="w-full max-w-md" />
        </div>
      ) : null;
    case "video":
      return url ? <video controls src={url} className="h-full w-full bg-black object-contain" /> : null;
    case "text":
      return <pre className="p-4 font-mono text-[12px] leading-relaxed">{text}</pre>;
    default:
      return <Notice title="No preview for this type">{content.mediaType}. Download it to open it in another app.</Notice>;
  }
}

/**
 * An HTML page in a sandbox with no access to Moka (no allow-same-origin: it
 * can't reach Moka's API or your token). If it loads anything from the
 * network, a banner says from where, and one click blocks it.
 */
function HtmlView({ html, title }: { html: string; title: string }) {
  const hosts = useMemo(() => externalHosts(html), [html]);
  const [blocked, setBlocked] = useState(false);
  return (
    <div className="flex h-full flex-col">
      {hosts.length > 0 && (
        <div className={cn("flex items-center gap-2 border-b px-3 py-1.5 text-[11.5px]", blocked ? "border-line bg-panel-2/40 text-muted" : "border-warn/30 bg-warn/10 text-warn")}>
          <Globe className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={hosts.join(", ")}>
            {blocked ? "Offline: network requests blocked" : `Loads from ${hosts.join(", ")}`}
          </span>
          <button className="shrink-0 font-medium underline-offset-2 hover:underline" onClick={() => setBlocked(!blocked)}>
            {blocked ? "Allow" : "Block"}
          </button>
        </div>
      )}
      <iframe key={String(blocked)} srcDoc={blocked ? offline(html) : html} sandbox="allow-scripts" title={title} className="min-h-0 w-full flex-1 border-0 bg-white" />
    </div>
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function CsvTable({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text), [text]);
  if (!rows.length) return <Notice title="Empty table" />;
  const [head, ...body] = rows;
  return (
    <div className="p-3">
      <table className="w-full border-collapse font-mono text-[12px]">
        <thead className="sticky top-0 bg-panel-2">
          <tr>
            {head!.map((h, i) => (
              <th key={i} className="border border-line px-2 py-1 text-left font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, MAX_ROWS).map((r, i) => (
            <tr key={i} className="odd:bg-panel-2/40">
              {r.map((c, j) => (
                <td key={j} className="border border-line px-2 py-1 align-top whitespace-pre-wrap">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > MAX_ROWS && <p className="mt-2 text-[12px] text-subtle">Showing the first {MAX_ROWS} of {body.length} rows. Download the file to see them all.</p>}
    </div>
  );
}

/** PDF pages drawn by pdf.js, rendered as they scroll into view, fit to the pane's width. */
function PdfView({ dataUrl }: { dataUrl: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [error, setError] = useState<string>();
  const [ratio, setRatio] = useState(1.414);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let close: (() => void) | undefined;
    openPdf(dataUrlBytes(dataUrl))
      .then(async (opened) => {
        close = opened.close;
        const first = (await opened.doc.getPage(1)).getViewport({ scale: 1 });
        if (cancelled) return close();
        setRatio(first.height / first.width);
        setDoc(opened.doc);
      })
      .catch((e) => !cancelled && setError(e?.message ?? String(e)));
    return () => {
      cancelled = true;
      close?.();
    };
  }, [dataUrl]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [doc]);

  if (error) return <Notice title="Couldn't read this PDF">{error}</Notice>;
  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-5 w-5 text-accent" />
      </div>
    );
  }
  const pageWidth = Math.max(200, Math.round((width - 32) * zoom));
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-line bg-panel-2/40 px-3 py-1 text-[11.5px] text-muted">
        <span className="font-mono">
          {current} / {doc.numPages}
        </span>
        <span className="flex-1" />
        <IconButton label="Zoom out" className="h-6 w-6" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}>
          <Minus className="h-3 w-3" />
        </IconButton>
        <button className="w-11 font-mono hover:text-fg" onClick={() => setZoom(1)} title="Fit to width">
          {Math.round(zoom * 100)}%
        </button>
        <IconButton label="Zoom in" className="h-6 w-6" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}>
          <Plus className="h-3 w-3" />
        </IconButton>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-panel-2/60">
        {width > 0 &&
          Array.from({ length: doc.numPages }, (_, i) => (
            <PdfPage key={i} doc={doc} n={i + 1} width={pageWidth} height={Math.round(pageWidth * ratio)} root={scroller} onVisible={setCurrent} />
          ))}
      </div>
    </div>
  );
}

function PdfPage({ doc, n, width, height, root, onVisible }: { doc: PDFDocumentProxy; n: number; width: number; height: number; root: React.RefObject<HTMLDivElement | null>; onVisible: (n: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(n <= 2);
  const [size, setSize] = useState({ width, height });

  useEffect(() => {
    const el = canvas.current?.parentElement;
    if (!el) return;
    // Render a little ahead of the scroll; report the page that's mostly in view.
    const ahead = new IntersectionObserver(([e]) => e?.isIntersecting && setNear(true), { root: root.current, rootMargin: "800px 0px" });
    const inView = new IntersectionObserver(([e]) => e?.isIntersecting && onVisible(n), { root: root.current, threshold: 0.5 });
    ahead.observe(el);
    inView.observe(el);
    return () => {
      ahead.disconnect();
      inView.disconnect();
    };
  }, [n, root, onVisible]);

  useEffect(() => {
    if (!near || !canvas.current) return;
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    let cancelled = false;
    void doc.getPage(n).then((page) => {
      if (cancelled || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: (width / base.width) * (window.devicePixelRatio || 1) });
      canvas.current.width = Math.floor(viewport.width);
      canvas.current.height = Math.floor(viewport.height);
      setSize({ width, height: Math.round((width * base.height) / base.width) });
      task = page.render({ canvas: canvas.current, viewport });
      task.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, n, near, width]);

  return (
    <div className="mx-auto my-4 bg-white shadow-soft" style={{ width: size.width, height: size.height }}>
      <canvas ref={canvas} style={{ width: size.width, height: size.height }} aria-label={`Page ${n}`} />
    </div>
  );
}

function DocxView({ dataUrl }: { dataUrl?: string }) {
  const [state, setState] = useState<{ markdown?: string; error?: string }>({});
  useEffect(() => {
    if (!dataUrl) return;
    let cancelled = false;
    docxToMarkdown(dataUrlBytes(dataUrl))
      .then((markdown) => !cancelled && setState({ markdown }))
      .catch((e) => !cancelled && setState({ error: e?.message ?? String(e) }));
    return () => {
      cancelled = true;
    };
  }, [dataUrl]);
  if (state.error) return <Notice title="Couldn't read this Word document">{state.error}</Notice>;
  if (state.markdown === undefined) return null;
  return (
    <div className="mx-auto my-4 max-w-3xl rounded-lg border border-line bg-bg px-8 py-7 shadow-soft">
      <Markdown text={state.markdown || "_This document has no text._"} />
    </div>
  );
}

/** Clickable cards for the files a tool returned, under its call in the chat. */
export function ToolFiles({ part, messageId }: { part: Extract<Part, { type: "tool" }>; messageId: string }) {
  const files = useMemo(() => toolFiles(part, messageId), [part, messageId]);
  const openPreview = useStore((s) => s.openPreview);
  const previewId = useStore((s) => s.previewId);
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {files.map((f) => {
        const kind = previewKind(f.mediaType, f.name);
        return kind === "image" && f.dataUrl ? (
          <button key={f.id} onClick={() => openPreview(f.id)} className={cn("overflow-hidden rounded-xl border", f.id === previewId ? "border-accent" : "border-line hover:border-accent/50")} title={`Open ${f.name}`}>
            <img src={f.dataUrl} alt={f.name} className="max-h-48 max-w-64 object-cover" />
          </button>
        ) : (
          <button
            key={f.id}
            onClick={() => openPreview(f.id)}
            className={cn("flex w-64 items-center gap-3 rounded-xl border bg-panel px-3 py-2.5 text-left transition-colors", f.id === previewId ? "border-accent" : "border-line hover:border-accent/50")}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <KindIcon kind={kind} className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{f.name}</span>
              <span className="block truncate text-[11px] text-subtle">{[KIND_LABEL[kind], formatBytes(f.size)].filter(Boolean).join(" · ")}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
