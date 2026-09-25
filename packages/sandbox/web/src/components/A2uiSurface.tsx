import * as Icons from "lucide-react";
import { LayoutTemplate } from "lucide-react";
import { Component, createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useStore } from "../store";
import type { SurfaceTheme } from "../types";
import { buildCsp } from "./McpAppFrame";
import { cn } from "./ui";

/**
 * A2UI v0.9 renderer (standard catalog) with v0.8 message compatibility.
 * Surfaces are built from a flat component map + a JSON data model; inputs
 * bind two-way to the data model and Buttons emit actions to the agent.
 */

type Json = any;
interface Surface {
  id: string;
  root: string;
  components: Map<string, Json>;
  data: Json;
  theme?: SurfaceTheme;
  deleted?: boolean;
}

export interface A2uiAction {
  name: string;
  surfaceId: string;
  sourceComponentId: string;
  timestamp: string;
  context: Record<string, unknown>;
}

/* ---------------------------------------------------------------- data model */

function pointerTokens(path: string): string[] {
  if (!path || path === "/") return [];
  return path
    .replace(/^\//, "")
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function getAt(data: Json, path: string): Json {
  let cur = data;
  for (const token of pointerTokens(path)) {
    if (cur == null) return undefined;
    cur = cur[token];
  }
  return cur;
}

function setAt(data: Json, path: string, value: Json): Json {
  const tokens = pointerTokens(path);
  if (tokens.length === 0) return value;
  const root = Array.isArray(data) ? [...data] : { ...(data ?? {}) };
  let cur: any = root;
  tokens.forEach((token, i) => {
    if (i === tokens.length - 1) {
      if (value === undefined) delete cur[token];
      else cur[token] = value;
    } else {
      const next = cur[token];
      cur[token] = Array.isArray(next) ? [...next] : { ...(next ?? {}) };
      cur = cur[token];
    }
  });
  return root;
}

function joinPath(scope: string, path: string): string {
  if (path.startsWith("/")) return path;
  return `${scope.replace(/\/$/, "")}/${path}`;
}

/* ---------------------------------------------------------------- messages */

/** Convert a v0.8 `{"Text": {...}}` component wrapper into v0.9 flat form. */
function normaliseComponent(c: Json): Json {
  if (c && typeof c.component === "object" && c.component !== null) {
    const [type, props] = Object.entries(c.component)[0] ?? ["Unknown", {}];
    return { id: c.id, component: type, ...(props as object), weight: c.weight };
  }
  return c;
}

function contentsToValue(contents: Json[]): Json {
  const out: Record<string, Json> = {};
  for (const entry of contents ?? []) {
    const v = entry.valueString ?? entry.valueNumber ?? entry.valueBoolean ?? (entry.valueMap ? contentsToValue(entry.valueMap) : undefined);
    out[entry.key] = v;
  }
  return out;
}

export function applyMessages(messages: Json[]): Surface[] {
  const surfaces = new Map<string, Surface>();
  const get = (id: string) => {
    let s = surfaces.get(id);
    if (!s) {
      s = { id, root: "root", components: new Map(), data: {} };
      surfaces.set(id, s);
    }
    return s;
  };
  for (const m of messages) {
    if (m.createSurface) {
      const s = get(m.createSurface.surfaceId);
      s.deleted = false;
      if (m.createSurface.theme && typeof m.createSurface.theme === "object") s.theme = m.createSurface.theme;
      for (const c of m.createSurface.components ?? []) s.components.set(c.id, normaliseComponent(c));
      if (m.createSurface.dataModel !== undefined) s.data = m.createSurface.dataModel;
    } else if (m.beginRendering) {
      const s = get(m.beginRendering.surfaceId);
      if (m.beginRendering.root) s.root = m.beginRendering.root;
    } else if (m.updateComponents || m.surfaceUpdate) {
      const u = m.updateComponents ?? m.surfaceUpdate;
      const s = get(u.surfaceId);
      for (const c of u.components ?? []) s.components.set(c.id, normaliseComponent(c));
    } else if (m.updateDataModel) {
      const u = m.updateDataModel;
      const s = get(u.surfaceId);
      s.data = setAt(s.data, u.path ?? "/", u.value);
    } else if (m.dataModelUpdate) {
      const u = m.dataModelUpdate;
      const s = get(u.surfaceId);
      const value = Array.isArray(u.contents) ? contentsToValue(u.contents) : u.contents;
      s.data = u.path && u.path !== "/" ? setAt(s.data, u.path, value) : { ...s.data, ...value };
    } else if (m.deleteSurface) {
      get(m.deleteSurface.surfaceId).deleted = true;
    }
  }
  return [...surfaces.values()].filter((s) => !s.deleted);
}

/* ---------------------------------------------------------------- rendering */

interface Ctx {
  surface: Surface;
  data: Json;
  setData: (path: string, value: Json) => void;
  onAction: (action: A2uiAction) => void;
  sent: string | undefined;
}
const SurfaceContext = createContext<Ctx | null>(null);

function useSurface(): Ctx {
  const ctx = useContext(SurfaceContext);
  if (!ctx) throw new Error("A2UI component outside a surface");
  return ctx;
}

/** Resolve a dynamic value: literal, {path}, v0.8 {literalString}, etc. */
function useResolver(scope: string) {
  const { data } = useSurface();
  return (value: Json): Json => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (typeof value.path === "string") return getAt(data, joinPath(scope, value.path));
      for (const key of ["literalString", "literalNumber", "literalBoolean", "literal"]) if (key in value) return value[key];
    }
    return value;
  };
}

function bindingPath(value: Json, scope: string): string | undefined {
  return value && typeof value === "object" && typeof value.path === "string" ? joinPath(scope, value.path) : undefined;
}

const ICONS: Record<string, keyof typeof Icons> = {
  check: "Check", close: "X", add: "Plus", remove: "Minus", star: "Star", starHalf: "StarHalf", starOff: "StarOff",
  calendar: "Calendar", calendarToday: "CalendarDays", mail: "Mail", phone: "Phone", info: "Info", warning: "TriangleAlert",
  error: "CircleAlert", help: "CircleHelp", search: "Search", settings: "Settings", person: "User", accountCircle: "CircleUser",
  home: "House", shoppingCart: "ShoppingCart", favorite: "Heart", favoriteOff: "HeartOff", locationOn: "MapPin", event: "CalendarClock",
  send: "Send", share: "Share2", edit: "Pencil", delete: "Trash2", download: "Download", upload: "Upload", lock: "Lock", lockOpen: "LockOpen",
  notifications: "Bell", payment: "CreditCard", camera: "Camera", photo: "Image", attachFile: "Paperclip", refresh: "RefreshCw",
  arrowBack: "ArrowLeft", arrowForward: "ArrowRight", menu: "Menu", moreVert: "EllipsisVertical", moreHoriz: "Ellipsis", print: "Printer",
  visibility: "Eye", visibilityOff: "EyeOff", play: "Play", pause: "Pause", time: "Clock", coffee: "Coffee",
};

function A2Icon({ name, className }: { name: string; className?: string }) {
  const key = ICONS[name] ?? (name.charAt(0).toUpperCase() + name.slice(1)) as keyof typeof Icons;
  const Icon = (Icons as any)[key] ?? Icons.Circle;
  return <Icon className={className ?? "h-4 w-4"} />;
}

const JUSTIFY: Record<string, string> = {
  start: "justify-start", center: "justify-center", end: "justify-end",
  spaceBetween: "justify-between", spaceAround: "justify-around", spaceEvenly: "justify-evenly", stretch: "justify-stretch",
};
const ALIGN: Record<string, string> = { start: "items-start", center: "items-center", end: "items-end", stretch: "items-stretch" };

function Children({ node, scope }: { node: Json; scope: string }) {
  const { data } = useSurface();
  const children = node.children;
  if (Array.isArray(children)) return <>{children.map((id: string) => <Node key={id} id={id} scope={scope} />)}</>;
  if (children && typeof children === "object") {
    // Template list: { componentId | template, path }
    const template = children.componentId ?? children.template ?? children.template?.componentId;
    const listPath = joinPath(scope, children.path ?? children.dataBinding ?? "/");
    const items = getAt(data, listPath);
    const entries: Array<[string, unknown]> = Array.isArray(items)
      ? items.map((_, i) => [String(i), _])
      : items && typeof items === "object"
        ? Object.entries(items)
        : [];
    return <>{entries.map(([key]) => <Node key={key} id={template} scope={`${listPath}/${key}`} />)}</>;
  }
  if (typeof node.child === "string") return <Node id={node.child} scope={scope} />;
  return null;
}

function Node({ id, scope }: { id: string; scope: string }) {
  const ctx = useSurface();
  const resolve = useResolver(scope);
  const node = ctx.surface.components.get(id);
  if (!node) return <span className="text-[12px] text-err">[missing component “{id}”]</span>;
  const weight = typeof node.weight === "number" ? { flexGrow: node.weight, flexBasis: 0 } : undefined;

  switch (node.component) {
    case "Text": {
      const text = String(resolve(node.text) ?? "");
      const variant = node.variant ?? node.usageHint ?? "body";
      const cls: Record<string, string> = {
        h1: "text-2xl font-semibold tracking-tight",
        h2: "text-xl font-semibold tracking-tight",
        h3: "text-[17px] font-semibold",
        h4: "text-[15px] font-semibold",
        h5: "text-[13px] font-semibold uppercase tracking-wide text-muted",
        caption: "text-[12.5px] text-muted",
        body: "text-[14px] leading-relaxed",
      };
      return (
        <p style={weight} className={cn("whitespace-pre-wrap", cls[variant] ?? cls.body)}>
          {text}
        </p>
      );
    }
    case "Image": {
      const url = String(resolve(node.url) ?? "");
      const variant = node.variant ?? node.usageHint;
      const size: Record<string, string> = {
        icon: "h-6 w-6", avatar: "h-10 w-10 rounded-full", smallFeature: "h-20 w-20",
        mediumFeature: "h-40 w-full", largeFeature: "h-64 w-full", header: "h-44 w-full",
      };
      return url ? (
        <img src={url} alt={String(resolve(node.altText ?? node.description) ?? "")} style={weight}
          className={cn("rounded-lg border border-line object-cover", size[variant] ?? "max-h-72 w-full", node.fit === "contain" && "object-contain")} />
      ) : null;
    }
    case "Icon":
      return <A2Icon name={String(resolve(node.name) ?? "info")} className="h-5 w-5 text-accent" />;
    case "Row":
      return (
        <div style={weight} className={cn("flex flex-wrap gap-[var(--a2-gap-sm,0.625rem)]", JUSTIFY[node.justify ?? node.distribution] ?? "justify-start", ALIGN[node.align ?? node.alignment] ?? "items-center")}>
          <Children node={node} scope={scope} />
        </div>
      );
    case "Column":
      return (
        <div style={weight} className={cn("flex flex-col gap-[var(--a2-gap,0.75rem)]", JUSTIFY[node.justify ?? node.distribution] ?? "", ALIGN[node.align ?? node.alignment] ?? "items-stretch")}>
          <Children node={node} scope={scope} />
        </div>
      );
    case "List":
      return (
        <div style={weight} className={cn("flex gap-2.5", (node.direction ?? "vertical") === "horizontal" ? "flex-row overflow-x-auto" : "flex-col")}>
          <Children node={node} scope={scope} />
        </div>
      );
    case "Card":
      return (
        <div style={weight} className="rounded-[var(--a2-radius,0.75rem)] border border-line bg-panel p-[var(--a2-pad,1rem)] shadow-sm">
          <Children node={node} scope={scope} />
        </div>
      );
    case "Divider":
      return node.axis === "vertical" ? <div className="w-px self-stretch bg-line" /> : <hr className="border-line" />;
    case "Button":
      return <ButtonNode node={node} scope={scope} />;
    case "TextField":
      return <TextFieldNode node={node} scope={scope} />;
    case "CheckBox": {
      const path = bindingPath(node.value, scope);
      const checked = Boolean(resolve(node.value));
      return (
        <label className="flex cursor-pointer items-center gap-2 text-[14px]">
          <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={checked} onChange={(e) => path && ctx.setData(path, e.target.checked)} />
          {String(resolve(node.label) ?? "")}
        </label>
      );
    }
    case "Slider": {
      const path = bindingPath(node.value, scope);
      const value = Number(resolve(node.value) ?? node.min ?? 0);
      const min = Number(resolve(node.min ?? node.minValue) ?? 0);
      const max = Number(resolve(node.max ?? node.maxValue) ?? 100);
      return (
        <label className="block">
          {node.label && <span className="mb-1 block text-[13px] font-medium">{String(resolve(node.label))}</span>}
          <div className="flex items-center gap-3">
            <input type="range" min={min} max={max} step={node.step ?? 1} value={value} className="flex-1 accent-[var(--accent)]"
              onChange={(e) => path && ctx.setData(path, Number(e.target.value))} />
            <span className="w-10 text-right font-mono text-[13px]">{value}</span>
          </div>
        </label>
      );
    }
    case "ChoicePicker":
    case "MultipleChoice":
      return <ChoiceNode node={node} scope={scope} />;
    case "DateTimeInput": {
      const path = bindingPath(node.value, scope);
      const date = node.enableDate !== false;
      const time = node.enableTime === true || (node.enableTime === undefined && !node.enableDate);
      const type = date && time ? "datetime-local" : time ? "time" : "date";
      return (
        <label className="block">
          {node.label && <span className="mb-1 block text-[13px] font-medium">{String(resolve(node.label))}</span>}
          <input type={type} value={String(resolve(node.value) ?? "")} onChange={(e) => path && ctx.setData(path, e.target.value)}
            className="h-9 w-full rounded-lg border border-line bg-panel px-3 text-[14px] focus:border-accent/60 focus:outline-none" />
        </label>
      );
    }
    case "Tabs": {
      return <TabsNode node={node} scope={scope} />;
    }
    case "MokaHtml":
      return <HtmlNode node={node} scope={scope} />;
    default:
      return (
        <div className="rounded-lg border border-dashed border-line px-3 py-2 font-mono text-[11px] text-subtle">
          Unsupported component “{String(node.component)}”
        </div>
      );
  }
}

function ButtonNode({ node, scope }: { node: Json; scope: string }) {
  const ctx = useSurface();
  const resolve = useResolver(scope);
  const action = node.action?.event ?? node.action;
  const name = String(action?.name ?? node.id);
  const primary = (node.variant ?? (node.primary ? "primary" : "")) === "primary";
  const done = ctx.sent === node.id;
  const fire = () => {
    const raw = action?.context ?? {};
    const context: Record<string, unknown> = {};
    if (Array.isArray(raw)) for (const entry of raw) context[entry.key] = resolve(entry.value);
    else for (const [k, v] of Object.entries(raw)) context[k] = resolve(v);
    ctx.onAction({ name, surfaceId: ctx.surface.id, sourceComponentId: node.id, timestamp: new Date().toISOString(), context });
  };
  return (
    <button
      type="button"
      onClick={fire}
      disabled={!!ctx.sent}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-[var(--a2-radius-sm,0.5rem)] px-3.5 text-[13.5px] font-medium transition-all disabled:opacity-60",
        primary ? "bg-accent text-accent-fg hover:brightness-110" : node.variant === "borderless" ? "text-muted hover:text-fg" : "border border-line-strong hover:bg-panel-2",
        done && "ring-2 ring-accent/40",
      )}
    >
      {done && <Icons.Check className="h-3.5 w-3.5" />}
      {node.child ? <InlineChild id={node.child} scope={scope} /> : String(resolve(node.label) ?? name)}
    </button>
  );
}

/** Button labels are components too; render Text/Icon children inline. */
function InlineChild({ id, scope }: { id: string; scope: string }) {
  const ctx = useSurface();
  const resolve = useResolver(scope);
  const child = ctx.surface.components.get(id);
  if (!child) return null;
  if (child.component === "Text") return <>{String(resolve(child.text) ?? "")}</>;
  if (child.component === "Icon") return <A2Icon name={String(resolve(child.name))} />;
  if (child.component === "Row")
    return <>{(child.children ?? []).map((c: string) => <InlineChild key={c} id={c} scope={scope} />)}</>;
  return <Node id={id} scope={scope} />;
}

function TextFieldNode({ node, scope }: { node: Json; scope: string }) {
  const ctx = useSurface();
  const resolve = useResolver(scope);
  const path = bindingPath(node.value ?? node.text, scope);
  const value = String(resolve(node.value ?? node.text) ?? "");
  const variant = node.variant ?? node.textFieldType ?? "shortText";
  const cls = "w-full rounded-[var(--a2-radius-sm,0.5rem)] border border-line bg-panel px-3 text-[14px] placeholder:text-subtle focus:border-accent/60 focus:outline-none focus:ring-3 focus:ring-accent/15";
  const onChange = (v: string) => path && ctx.setData(path, variant === "number" ? (v === "" ? "" : Number(v)) : v);
  return (
    <label className="block">
      {node.label && <span className="mb-1 block text-[13px] font-medium">{String(resolve(node.label))}</span>}
      {variant === "longText" ? (
        <textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} className={cn(cls, "py-2")} placeholder={String(resolve(node.placeholder) ?? "")} />
      ) : (
        <input
          type={variant === "number" ? "number" : variant === "obscured" ? "password" : variant === "date" ? "date" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(cls, "h-9")}
          placeholder={String(resolve(node.placeholder) ?? "")}
        />
      )}
    </label>
  );
}

function ChoiceNode({ node, scope }: { node: Json; scope: string }) {
  const ctx = useSurface();
  const resolve = useResolver(scope);
  const path = bindingPath(node.value ?? node.selections, scope);
  const multi = node.variant === "multipleSelection" || (node.maxAllowedSelections ?? 1) > 1;
  const current = resolve(node.value ?? node.selections);
  const selected: unknown[] = Array.isArray(current) ? current : current == null || current === "" ? [] : [current];
  const options: Array<{ label: string; value: unknown }> = (resolve(node.options) ?? []).map((o: Json) =>
    typeof o === "object" ? { label: String(resolve(o.label) ?? o.value), value: o.value } : { label: String(o), value: o },
  );
  const toggle = (value: unknown) => {
    if (!path) return;
    if (multi) ctx.setData(path, selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
    else ctx.setData(path, value);
  };
  return (
    <div>
      {node.label && <span className="mb-1.5 block text-[13px] font-medium">{String(resolve(node.label))}</span>}
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = selected.includes(o.value);
          return (
            <button key={String(o.value)} type="button" onClick={() => toggle(o.value)}
              className={cn("rounded-full border px-3 py-1 text-[13px] transition-colors", on ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-panel-2")}>
              {on && <Icons.Check className="mr-1 inline h-3 w-3" />}
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TabsNode({ node, scope }: { node: Json; scope: string }) {
  const resolve = useResolver(scope);
  const tabs: Array<{ title: Json; child: string }> = node.tabs ?? node.tabItems ?? [];
  const [active, setActive] = useState(0);
  return (
    <div>
      <div className="mb-3 flex gap-1 border-b border-line">
        {tabs.map((t, i) => (
          <button key={i} onClick={() => setActive(i)}
            className={cn("-mb-px border-b-2 px-3 py-1.5 text-[13px]", i === active ? "border-accent text-fg" : "border-transparent text-muted")}>
            {String(resolve(t.title) ?? `Tab ${i + 1}`)}
          </button>
        ))}
      </div>
      {tabs[active] && <Node id={tabs[active]!.child} scope={scope} />}
    </div>
  );
}

/* ---------------------------------------------------------------- HTML components */

/** Script injected into HTML catalog components: exposes `window.moka`. */
const HTML_BOOTSTRAP = `<script>(function(){
var listeners=[],props={};
window.moka={
  get props(){return props},
  onProps:function(cb){listeners.push(cb);try{cb(props)}catch(e){console.error(e)}},
  action:function(name,context){parent.postMessage({moka:"action",name:String(name),context:context||{}},"*")},
  update:function(prop,value){parent.postMessage({moka:"update",prop:String(prop),value:value},"*")}
};
addEventListener("message",function(e){
  if(e.source!==parent||!e.data||e.data.moka!=="props")return;
  props=e.data.props||{};var t=e.data.theme||{};
  for(var k in t)document.documentElement.style.setProperty(k,t[k]);
  document.documentElement.setAttribute("data-theme",e.data.mode||"light");
  listeners.forEach(function(cb){try{cb(props)}catch(err){console.error(err)}});
});
function size(){parent.postMessage({moka:"resize",height:Math.ceil(document.documentElement.getBoundingClientRect().height)},"*")}
new ResizeObserver(size).observe(document.documentElement);addEventListener("load",size);
parent.postMessage({moka:"ready"},"*");
})();</script>
<style>html,body{margin:0;background:transparent;color:var(--moka-fg);font:14px/1.5 var(--moka-font,system-ui)}</style>`;

function htmlDocument(html: string, csp?: { resourceDomains?: string[]; connectDomains?: string[] }): string {
  const policy = buildCsp({ resourceDomains: csp?.resourceDomains, connectDomains: csp?.connectDomains });
  const head = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}">${HTML_BOOTSTRAP}`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${head}`);
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${html}</body></html>`;
}

function hostTheme(el: Element | null): Record<string, string> {
  const style = getComputedStyle(el ?? document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim();
  return {
    "--moka-fg": v("--fg"),
    "--moka-muted": v("--muted"),
    "--moka-accent": v("--accent"),
    "--moka-accent-fg": v("--accent-fg"),
    "--moka-panel": v("--panel"),
    "--moka-panel-2": v("--panel-2"),
    "--moka-line": v("--line"),
    "--moka-radius": v("--a2-radius") || "0.75rem",
    "--moka-font": style.fontFamily,
  };
}

function HtmlNode({ node, scope }: { node: Json; scope: string }) {
  const ctx = useSurface();
  const resolve = useResolver(scope);
  const mode = useStore((s) => s.theme);
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>(typeof node.height === "number" ? node.height : 120);
  const rawProps: Record<string, Json> = node.props ?? {};
  const props = Object.fromEntries(Object.entries(rawProps).map(([k, v]) => [k, resolve(v)]));
  const propsJson = JSON.stringify(props);
  const srcDoc = useMemo(() => htmlDocument(String(node.html ?? ""), node.csp), [node.html, node.csp]);

  const post = () =>
    frame.current?.contentWindow?.postMessage({ moka: "props", props: JSON.parse(propsJson), theme: hostTheme(frame.current), mode }, "*");

  useEffect(post, [propsJson, mode]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const msg = event.data as Json;
      if (!msg || typeof msg !== "object") return;
      if (msg.moka === "ready") post();
      else if (msg.moka === "resize" && typeof msg.height === "number") setHeight(Math.min(Math.max(msg.height, 24), 1200));
      else if (msg.moka === "action" && !ctx.sent) {
        ctx.onAction({ name: String(msg.name), surfaceId: ctx.surface.id, sourceComponentId: node.id, timestamp: new Date().toISOString(), context: msg.context ?? {} });
      } else if (msg.moka === "update") {
        const path = bindingPath(rawProps[msg.prop], scope);
        if (path) ctx.setData(path, msg.value);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  const weight = typeof node.weight === "number" ? { flexGrow: node.weight, flexBasis: 0 } : undefined;
  return (
    <iframe
      ref={frame}
      title={String(node.name ?? "component")}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className="block w-full border-0 bg-transparent"
      style={{ height, ...weight }}
    />
  );
}

/* ---------------------------------------------------------------- surface */

function luminance(hex: string): number | undefined {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const h = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Map an A2UI surface theme onto Moka's CSS variables for this surface only. */
export function themeStyle(theme?: SurfaceTheme): CSSProperties | undefined {
  if (!theme) return undefined;
  const style: Record<string, string> = {};
  if (theme.primaryColor) {
    // Tailwind resolves --color-* at :root, so override both layers for this subtree.
    const soft = `color-mix(in srgb, ${theme.primaryColor} 16%, transparent)`;
    style["--accent"] = style["--color-accent"] = theme.primaryColor;
    style["--accent-soft"] = style["--color-accent-soft"] = soft;
    const lum = luminance(theme.primaryColor);
    if (lum !== undefined) style["--accent-fg"] = style["--color-accent-fg"] = lum > 0.45 ? "#111111" : "#ffffff";
  }
  if (typeof theme.radius === "number") {
    style["--a2-radius"] = `${theme.radius}px`;
    style["--a2-radius-sm"] = `${Math.round(theme.radius * 0.7)}px`;
  }
  if (theme.density === "compact") {
    style["--a2-gap"] = "0.4rem";
    style["--a2-gap-sm"] = "0.35rem";
    style["--a2-pad"] = "0.65rem";
  }
  if (theme.font) style.fontFamily = `${theme.font}, var(--font-sans)`;
  return style as CSSProperties;
}

function SurfaceView({ surface, onAction }: { surface: Surface; onAction: (a: A2uiAction) => void }) {
  const [data, dispatch] = useReducer((state: Json, [path, value]: [string, Json]) => setAt(state, path, value), surface.data);
  const [sent, setSent] = useState<string>();
  const ctx = useMemo<Ctx>(
    () => ({
      surface,
      data,
      setData: (path, value) => dispatch([path, value]),
      onAction: (action) => {
        setSent(action.sourceComponentId);
        onAction(action);
      },
      sent,
    }),
    [surface, data, onAction, sent],
  );
  return (
    <SurfaceContext.Provider value={ctx}>
      <div style={themeStyle(surface.theme)}>
        <Node id={surface.root} scope="/" />
      </div>
    </SurfaceContext.Provider>
  );
}

export function A2uiSurfaces({ messages, onAction, header = true }: { messages: Json[]; onAction: (a: A2uiAction) => void; header?: boolean }) {
  const surfaces = useMemo(() => applyMessages(messages), [messages]);
  if (surfaces.length === 0) return null;
  return (
    <div className="animate-in space-y-2">
      {surfaces.map((s) => (
        <div key={s.id}>
          {s.theme?.agentDisplayName ? (
            <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-muted">
              {s.theme.iconUrl ? <img src={s.theme.iconUrl} alt="" className="h-4 w-4 rounded" /> : <LayoutTemplate className="h-3 w-3 text-violet" />}
              {s.theme.agentDisplayName}
            </div>
          ) : (
            header && (
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-subtle">
                <LayoutTemplate className="h-3 w-3 text-violet" /> A2UI · {s.id}
              </div>
            )
          )}
          <ErrorBoundaryLite>
            <SurfaceView surface={s} onAction={onAction} />
          </ErrorBoundaryLite>
        </div>
      ))}
    </div>
  );
}

class ErrorBoundaryLite extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    if (this.state.error) return <div className="rounded-lg border border-err/30 bg-err/5 px-3 py-2 text-[12.5px] text-err">Could not render UI: {this.state.error}</div>;
    return this.props.children;
  }
}
