import { AppWindow, ExternalLink, Maximize2, Minimize2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { RawToolResult, UiDescriptor } from "../types";
import { IconButton, Spinner, cn } from "./ui";

/**
 * Host for MCP Apps (SEP-1865, `text/html;profile=mcp-app`) and legacy MCP-UI
 * resources. The app runs in an iframe with an opaque origin (no
 * allow-same-origin), so it can never read Moka's token or storage. All
 * communication is JSON-RPC 2.0 (or MCP-UI messages) over postMessage.
 */

const PROTOCOL_VERSION = "2026-01-26";

type AppUi = Extract<UiDescriptor, { kind: "mcp-app" | "mcp-ui" }>;

interface Props {
  ui: AppUi;
  toolName: string;
  input: unknown;
  raw?: RawToolResult;
  running: boolean;
}

interface LoadedResource {
  html?: string;
  url?: string;
  csp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[] };
  prefersBorder?: boolean;
}

function report(kind: "ui.rpc" | "ui.action", title: string, direction: "in" | "out" | undefined, serverId: string, data: unknown) {
  void api("/api/events/ui", { body: { kind, title, direction, serverId, data } }).catch(() => {});
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Theme tokens in the MCP Apps standard variable names. */
function hostStyles() {
  return {
    variables: {
      "--color-background-primary": cssVar("--panel"),
      "--color-background-secondary": cssVar("--panel-2"),
      "--color-text-primary": cssVar("--fg"),
      "--color-text-secondary": cssVar("--muted"),
      "--color-border-primary": cssVar("--line"),
      "--color-accent": cssVar("--accent"),
      "--color-accent-foreground": cssVar("--accent-fg"),
      "--font-sans": getComputedStyle(document.body).fontFamily,
      "--border-radius-md": "10px",
    },
  };
}

export function buildCsp(csp: LoadedResource["csp"] = {}): string {
  const list = (items?: string[]) => (items ?? []).filter((d) => /^https?:\/\/[^\s;'"]+$/.test(d)).join(" ");
  const res = list(csp.resourceDomains);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${res}`,
    `style-src 'unsafe-inline' ${res}`,
    `img-src data: blob: ${res}`,
    `font-src data: ${res}`,
    `media-src data: blob: ${res}`,
    `connect-src ${list(csp.connectDomains) || "'none'"}`,
    `frame-src ${list(csp.frameDomains) || "'none'"}`,
    "object-src 'none'",
    `base-uri ${list(csp.baseUriDomains) || "'none'"}`,
    "form-action 'none'",
  ].join("; ");
}

function injectCsp(html: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  return `${meta}${html}`;
}

export function McpAppFrame({ ui, toolName, input, raw, running }: Props) {
  const theme = useStore((s) => s.theme);
  const version = useStore((s) => s.version);
  const send = useStore((s) => s.send);
  const set = useStore((s) => s.set);
  const toast = useStore((s) => s.toast);
  const frame = useRef<HTMLIFrameElement>(null);
  const [resource, setResource] = useState<LoadedResource>();
  const [error, setError] = useState<string>();
  const [height, setHeight] = useState(160);
  const [fullscreen, setFullscreen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const initialized = useRef(false);
  const sentResult = useRef(false);
  const serverId = ui.serverId;

  // Load the UI resource.
  useEffect(() => {
    setError(undefined);
    initialized.current = false;
    sentResult.current = false;
    if (ui.kind === "mcp-ui") {
      setResource({ html: ui.html, url: ui.url, prefersBorder: true });
      return;
    }
    let cancelled = false;
    api<{ result: any }>(`/api/mcp/${encodeURIComponent(serverId)}/resource`, { body: { uri: ui.resourceUri } })
      .then(({ result }) => {
        if (cancelled) return;
        const content = (result?.contents ?? []).find((c: any) => typeof c.text === "string" || typeof c.blob === "string");
        if (!content) throw new Error(`Resource ${ui.resourceUri} has no HTML`);
        const html = typeof content.text === "string" ? content.text : new TextDecoder().decode(Uint8Array.from(atob(content.blob), (c) => c.charCodeAt(0)));
        const meta = content._meta?.ui ?? {};
        setResource({ html, csp: meta.csp, prefersBorder: meta.prefersBorder !== false });
      })
      .catch((e) => !cancelled && setError(e?.message ?? String(e)));
    return () => {
      cancelled = true;
    };
  }, [ui, serverId, reloadKey]);

  const post = useCallback(
    (message: unknown, log = true) => {
      frame.current?.contentWindow?.postMessage(message, "*");
      const m = message as any;
      if (log) report("ui.rpc", `→ app ${m.method ?? (m.error ? `error #${m.id}` : `result #${m.id}`)}`, "out", serverId, message);
    },
    [serverId],
  );

  const sendToolResult = useCallback(() => {
    if (!initialized.current || sentResult.current || !raw) return;
    sentResult.current = true;
    post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: raw });
  }, [raw, post]);

  useEffect(sendToolResult, [sendToolResult]);

  useEffect(() => {
    if (!initialized.current || ui.kind !== "mcp-app") return;
    post({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme, styles: hostStyles() } });
  }, [theme, post, ui.kind]);

  const callTool = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      const res = await api<{ result: any; error?: string }>(`/api/mcp/${encodeURIComponent(serverId)}/call`, {
        body: { tool: name, args, source: "app" },
      });
      return res.result;
    },
    [serverId],
  );

  // JSON-RPC (MCP Apps) and MCP-UI message handling.
  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const msg = event.data as any;
      if (!msg || typeof msg !== "object") return;

      // ---- Legacy MCP-UI (mcp-ui.dev) -------------------------------------
      if (typeof msg.type === "string" && msg.jsonrpc === undefined) {
        const reply = (payload: unknown) =>
          msg.messageId && frame.current?.contentWindow?.postMessage({ type: "ui-message-response", messageId: msg.messageId, payload }, "*");
        report("ui.rpc", `← app ${msg.type}`, "in", serverId, msg);
        try {
          switch (msg.type) {
            case "tool":
              reply({ response: await callTool(msg.payload?.toolName, msg.payload?.params ?? {}) });
              break;
            case "prompt":
              void send(String(msg.payload?.prompt ?? ""), { via: "mcp-app" });
              reply({ response: "ok" });
              break;
            case "intent":
              void send(`${msg.payload?.intent}: ${JSON.stringify(msg.payload?.params ?? {})}`, { via: "mcp-app" });
              break;
            case "link":
              window.open(String(msg.payload?.url), "_blank", "noopener,noreferrer");
              break;
            case "notify":
              toast(String(msg.payload?.message ?? ""));
              break;
            case "ui-size-change":
              if (typeof msg.payload?.height === "number") setHeight(Math.min(Math.max(msg.payload.height, 60), 1200));
              break;
            case "ui-lifecycle-iframe-ready":
              frame.current?.contentWindow?.postMessage({ type: "ui-lifecycle-iframe-render-data", payload: { renderData: { toolInput: input, toolOutput: raw } } }, "*");
              break;
          }
        } catch (e: any) {
          reply({ error: e?.message ?? String(e) });
        }
        return;
      }

      // ---- MCP Apps: JSON-RPC 2.0 ------------------------------------------
      if (msg.jsonrpc !== "2.0") return;
      const quiet = msg.method === "ui/notifications/size-changed";
      if (!quiet) report("ui.rpc", `← app ${msg.method ?? `response #${msg.id}`}`, "in", serverId, msg);
      const respond = (result: unknown) => post({ jsonrpc: "2.0", id: msg.id, result });
      const fail = (code: number, message: string) => post({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

      try {
        switch (msg.method) {
          case "ui/initialize": {
            const rect = frame.current.getBoundingClientRect();
            respond({
              protocolVersion: PROTOCOL_VERSION,
              hostInfo: { name: "moka", version },
              hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {} },
              hostContext: {
                toolInfo: { id: 0, tool: { name: toolName } },
                theme,
                styles: hostStyles(),
                displayMode: fullscreen ? "fullscreen" : "inline",
                availableDisplayModes: ["inline", "fullscreen"],
                containerDimensions: { width: Math.round(rect.width), maxHeight: 1200 },
                locale: navigator.language,
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                platform: "web",
              },
            });
            break;
          }
          case "ui/notifications/initialized":
            initialized.current = true;
            post({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: input ?? {} } });
            sendToolResult();
            break;
          case "ui/notifications/size-changed":
            if (typeof msg.params?.height === "number") setHeight(Math.min(Math.max(Math.ceil(msg.params.height), 60), 1200));
            break;
          case "tools/call":
            respond(await callTool(msg.params?.name, msg.params?.arguments ?? {}));
            break;
          case "resources/read":
            respond((await api(`/api/mcp/${encodeURIComponent(serverId)}/resource`, { body: { uri: msg.params?.uri } })).result);
            break;
          case "ui/message": {
            const content = msg.params?.content;
            const text = Array.isArray(content)
              ? content.map((c: any) => c?.text ?? "").join("\n")
              : typeof content === "string"
                ? content
                : content?.text ?? "";
            respond({});
            if (text.trim()) void send(text, { via: "mcp-app" });
            break;
          }
          case "ui/open-link":
            window.open(String(msg.params?.url), "_blank", "noopener,noreferrer");
            respond({});
            break;
          case "ui/request-display-mode": {
            const mode = msg.params?.mode === "fullscreen" ? "fullscreen" : "inline";
            setFullscreen(mode === "fullscreen");
            respond({ mode });
            break;
          }
          case "ui/update-model-context": {
            const parts = [
              ...(msg.params?.content ?? []).map((c: any) => c?.text).filter(Boolean),
              msg.params?.structuredContent !== undefined ? JSON.stringify(msg.params.structuredContent) : "",
            ].filter(Boolean);
            set({ appContext: parts.join("\n") || undefined });
            respond({});
            break;
          }
          case "notifications/message":
          case "ui/notifications/request-teardown":
            break;
          case "ping":
            respond({});
            break;
          default:
            if (msg.id !== undefined && msg.method) fail(-32601, `Method not supported by Moka: ${msg.method}`);
        }
      } catch (e: any) {
        if (msg.id !== undefined) fail(-32000, e?.message ?? String(e));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [serverId, input, raw, theme, version, toolName, fullscreen, post, callTool, send, set, toast, sendToolResult]);

  const srcDoc = useMemo(() => (resource?.html ? injectCsp(resource.html, buildCsp(resource.csp)) : undefined), [resource]);

  const header = (
    <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11.5px] text-subtle">
      <AppWindow className="h-3.5 w-3.5 text-accent" />
      <span className="font-medium text-muted">{ui.kind === "mcp-app" ? "MCP App" : "MCP-UI"}</span>
      <span className="truncate font-mono">{ui.kind === "mcp-app" ? ui.resourceUri : ui.uri}</span>
      <span className="flex-1" />
      {running && <Spinner className="text-accent" />}
      {resource?.url && (
        <IconButton label="Open in new tab" className="h-6 w-6" onClick={() => window.open(resource.url, "_blank", "noopener")}>
          <ExternalLink className="h-3 w-3" />
        </IconButton>
      )}
      <IconButton label="Reload app" className="h-6 w-6" onClick={() => setReloadKey((k) => k + 1)}>
        <RotateCcw className="h-3 w-3" />
      </IconButton>
      <IconButton label={fullscreen ? "Exit fullscreen" : "Fullscreen"} className="h-6 w-6" onClick={() => setFullscreen(!fullscreen)}>
        {fullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
      </IconButton>
    </div>
  );

  const body = error ? (
    <div className="px-4 py-3 text-[13px] text-err">Could not load app: {error}</div>
  ) : !resource ? (
    <div className="flex items-center gap-2 px-4 py-6 text-[13px] text-muted">
      <Spinner /> Loading app…
    </div>
  ) : (
    <iframe
      key={reloadKey}
      ref={frame}
      title={`${toolName} app`}
      // Opaque origin: scripts run, but the app cannot touch Moka's origin, cookies or storage.
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      src={srcDoc ? undefined : resource.url}
      className="block w-full border-0 bg-transparent"
      style={{ height: fullscreen ? "calc(100vh - 7rem)" : height }}
    />
  );

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-bg p-4">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-soft">
          {header}
          <div className="min-h-0 flex-1">{body}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={cn("animate-in overflow-hidden rounded-xl bg-panel", resource?.prefersBorder !== false && "border border-line shadow-sm")}>
      {header}
      {body}
    </div>
  );
}
