import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CatalogConfig, GenerativeUiConfig, Workspace } from "./config.js";
import { A2UI_CATALOG, A2UI_VERSION, parseA2ui, type A2uiMessage } from "./ui.js";

/**
 * A2UI component catalogs.
 *
 * A catalog is the vocabulary a model may use when it renders UI. Moka ships
 * the A2UI v0.9 standard catalog (rendered natively) and lets you add your
 * own components in two flavours, neither of which needs a build step:
 *
 * - **Template components** are declared as a small tree of existing
 *   components with `{{prop}}` placeholders. Moka expands them before
 *   rendering, so they inherit theming, data binding and actions for free.
 * - **HTML components** are a snippet of HTML/JS that runs in a sandboxed
 *   iframe (no network by default). They receive resolved props, can emit
 *   actions and can write back to bound props.
 */

type JsonSchema = Record<string, any>;
type A2uiComponent = Record<string, any>;

export interface CatalogComponent {
  description?: string;
  /** JSON Schema for each prop. Any prop may also be a `{"path": "/x"}` binding. */
  props?: Record<string, JsonSchema>;
  required?: string[];
  /** Template components: a tree of components; the one with id "root" becomes the instance. */
  template?: A2uiComponent[];
  /** HTML components: inline markup (scripts allowed, sandboxed). */
  html?: string;
  /** HTML components: file path relative to the catalog file. Loaded into `html`. */
  htmlFile?: string;
  /** Extra origins an HTML component may load scripts/styles/images from (e.g. a chart CDN). */
  csp?: { resourceDomains?: string[]; connectDomains?: string[] };
  /** Initial iframe height for HTML components (it auto-resizes afterwards). */
  height?: number;
  /** Sample props used by the catalog browser preview. */
  example?: Record<string, unknown>;
  /** Built-in components rendered natively by Moka. */
  builtin?: boolean;
}

export interface CatalogExample {
  title?: string;
  prompt?: string;
  components: A2uiComponent[];
  data?: Record<string, unknown>;
}

export interface SurfaceTheme {
  primaryColor?: string;
  font?: string;
  /** Corner radius in px. */
  radius?: number;
  density?: "compact" | "comfortable";
  agentDisplayName?: string;
  iconUrl?: string;
}

export interface Catalog {
  catalogId: string;
  name: string;
  description?: string;
  version?: string;
  /** Extra guidance appended to the render_ui tool description. */
  instructions?: string;
  theme?: SurfaceTheme;
  components: Record<string, CatalogComponent>;
  examples?: CatalogExample[];
}

export interface LoadedCatalog extends Catalog {
  /** Config id ("standard" for the built-in catalog). */
  id: string;
  source: "builtin" | "file" | "url" | "inline" | "mcp";
  path?: string;
  error?: string;
}

/* ------------------------------------------------------------------ standard */

const str = (description?: string): JsonSchema => ({ type: "string", ...(description ? { description } : {}) });
const oneOf = (...values: string[]): JsonSchema => ({ type: "string", enum: values });
const ids: JsonSchema = { type: "array", items: { type: "string" }, description: "component ids" };
const binding: JsonSchema = { type: "object", description: '{"path": "/field"}' };

export const STANDARD_CATALOG_ID = "standard";

export const STANDARD_CATALOG: LoadedCatalog = {
  id: STANDARD_CATALOG_ID,
  source: "builtin",
  catalogId: A2UI_CATALOG,
  name: "A2UI standard",
  description: "The A2UI v0.9 standard catalog, rendered natively by Moka.",
  version: A2UI_VERSION,
  components: {
    Text: { builtin: true, description: "Text or a heading", props: { text: str(), variant: oneOf("h1", "h2", "h3", "h4", "h5", "caption", "body") }, required: ["text"], example: { text: "Hello from A2UI", variant: "h3" } },
    Image: { builtin: true, description: "An image from a URL", props: { url: str(), variant: oneOf("icon", "avatar", "smallFeature", "mediumFeature", "largeFeature", "header") }, required: ["url"] },
    Icon: { builtin: true, description: 'e.g. "check", "star", "calendar", "mail", "phone", "info", "warning", "error", "search", "settings", "person", "home", "shoppingCart", "favorite"', props: { name: str() }, required: ["name"], example: { name: "coffee" } },
    Row: { builtin: true, description: "Horizontal layout", props: { children: ids, justify: str(), align: str() }, required: ["children"] },
    Column: { builtin: true, description: "Vertical layout", props: { children: ids, justify: str(), align: str() }, required: ["children"] },
    Card: { builtin: true, description: "A bordered container", props: { child: str("component id") }, required: ["child"] },
    Divider: { builtin: true, props: { axis: oneOf("horizontal", "vertical") } },
    List: { builtin: true, description: 'Static children, or a template: {"componentId": templateId, "path": "/items"}', props: { children: { description: "[ids] | {componentId, path}" }, direction: oneOf("vertical", "horizontal") }, required: ["children"] },
    Button: {
      builtin: true,
      description: 'Sends {"event": {"name", "context"}} back to you when pressed',
      props: { child: str("id of a Text component"), variant: oneOf("primary", "borderless"), action: { type: "object", description: '{"event": {"name": string, "context": {key: value | {"path": "/x"}}}}' } },
      required: ["action"],
    },
    TextField: { builtin: true, props: { label: str(), value: binding, variant: oneOf("shortText", "longText", "number", "obscured") }, example: { label: "Your name" } },
    CheckBox: { builtin: true, props: { label: str(), value: binding }, example: { label: "Subscribe" } },
    Slider: { builtin: true, props: { value: binding, min: { type: "number" }, max: { type: "number" }, label: str() } },
    ChoicePicker: {
      builtin: true,
      props: { label: str(), options: { type: "array", description: "[{label, value}]" }, value: binding, variant: oneOf("mutuallyExclusive", "multipleSelection") },
      required: ["options"],
      example: { label: "Size", options: [{ label: "Small", value: "s" }, { label: "Large", value: "l" }] },
    },
    DateTimeInput: { builtin: true, props: { value: binding, enableDate: { type: "boolean" }, enableTime: { type: "boolean" }, label: str() } },
    Tabs: { builtin: true, props: { tabs: { type: "array", description: "[{title, child: id}]" } }, required: ["tabs"] },
  },
};

/* ------------------------------------------------------------------ loading */

const catalogFileSchema = z
  .object({
    catalogId: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
    instructions: z.string().optional(),
    theme: z.record(z.string(), z.any()).optional(),
    components: z.record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, "component names must be identifiers"),
      z
        .object({
          description: z.string().optional(),
          props: z.record(z.string(), z.any()).optional(),
          required: z.array(z.string()).optional(),
          template: z.array(z.record(z.string(), z.any())).optional(),
          html: z.string().optional(),
          htmlFile: z.string().optional(),
          csp: z.object({ resourceDomains: z.array(z.string()).optional(), connectDomains: z.array(z.string()).optional() }).optional(),
          height: z.number().optional(),
          example: z.record(z.string(), z.any()).optional(),
        })
        .refine((c) => c.template || c.html || c.htmlFile, "each component needs a template, html or htmlFile"),
    ),
    examples: z.array(z.object({ title: z.string().optional(), prompt: z.string().optional(), components: z.array(z.any()), data: z.any().optional() })).optional(),
  })
  .passthrough();

/** Validate a catalog object (from a file, URL, inline config or MCP resource). */
export function parseCatalog(input: unknown, fallback: { id: string; name?: string }): Catalog {
  const parsed = catalogFileSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "catalog"}: ${i.message}`).join("; "));
  }
  const c = parsed.data;
  for (const name of Object.keys(c.components)) {
    if (STANDARD_CATALOG.components[name]) throw new Error(`"${name}" is a standard component; pick another name`);
  }
  return {
    catalogId: c.catalogId ?? fallback.id,
    name: c.name ?? fallback.name ?? fallback.id,
    description: c.description,
    version: c.version,
    instructions: c.instructions,
    theme: c.theme as SurfaceTheme | undefined,
    components: c.components as Record<string, CatalogComponent>,
    examples: c.examples as CatalogExample[] | undefined,
  };
}

const urlCache = new Map<string, { at: number; json: unknown }>();
const URL_TTL = 60_000;

/** Load one configured catalog. Errors are reported on the result, never thrown. */
export async function loadCatalog(config: CatalogConfig, baseDir: string): Promise<LoadedCatalog> {
  const base = { id: config.id, catalogId: config.id, name: config.name ?? config.id, components: {} };
  try {
    if (config.catalog) {
      return { ...parseCatalog(config.catalog, { id: config.id, name: config.name }), id: config.id, source: "inline", ...(config.name ? { name: config.name } : {}) };
    }
    if (config.url) {
      const cached = urlCache.get(config.url);
      let json = cached && Date.now() - cached.at < URL_TTL ? cached.json : undefined;
      if (json === undefined) {
        const res = await fetch(config.url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        json = await res.json();
        urlCache.set(config.url, { at: Date.now(), json });
      }
      return { ...parseCatalog(json, { id: config.id, name: config.name }), id: config.id, source: "url", ...(config.name ? { name: config.name } : {}) };
    }
    if (config.path) {
      const file = path.resolve(baseDir, config.path);
      const catalog = parseCatalog(JSON.parse(await readFile(file, "utf8")), { id: config.id, name: config.name });
      for (const [name, component] of Object.entries(catalog.components)) {
        if (component.htmlFile && !component.html) {
          const htmlPath = path.resolve(path.dirname(file), component.htmlFile);
          try {
            component.html = await readFile(htmlPath, "utf8");
          } catch {
            throw new Error(`${name}: cannot read htmlFile ${component.htmlFile}`);
          }
        }
      }
      return { ...catalog, id: config.id, source: "file", path: file, ...(config.name ? { name: config.name } : {}) };
    }
    throw new Error("A catalog needs a path, url or inline catalog");
  } catch (error: any) {
    return { ...base, source: config.url ? "url" : config.path ? "file" : "inline", error: error?.message ?? String(error) };
  }
}

/* ------------------------------------------------------------------ settings */

export interface ResolvedGenerativeUi {
  enabled: boolean;
  toolName: string;
  description?: string;
  instructions?: string;
  standard: boolean;
  catalogIds: string[];
  allow?: string[];
  deny?: string[];
  theme?: SurfaceTheme;
  examples: boolean;
  repair: boolean;
}

/** Normalise `workspace.generativeUi` (boolean or object) into concrete settings. */
export function resolveGenerativeUi(workspace: Pick<Workspace, "generativeUi">): ResolvedGenerativeUi {
  const raw = workspace.generativeUi;
  const cfg: GenerativeUiConfig = typeof raw === "object" && raw ? raw : {};
  return {
    enabled: raw === false ? false : cfg.enabled !== false,
    toolName: cfg.toolName || "render_ui",
    description: cfg.description || undefined,
    instructions: cfg.instructions || undefined,
    standard: cfg.standard !== false,
    catalogIds: cfg.catalogIds ?? [],
    allow: cfg.allow?.length ? cfg.allow : undefined,
    deny: cfg.deny?.length ? cfg.deny : undefined,
    theme: cfg.theme,
    examples: cfg.examples !== false,
    repair: cfg.repair !== false,
  };
}

/** The set of components a model may use, in catalog order. */
export class ComponentRegistry {
  readonly components = new Map<string, { catalog: LoadedCatalog; component: CatalogComponent }>();

  constructor(
    readonly catalogs: LoadedCatalog[],
    options: { allow?: string[]; deny?: string[] } = {},
  ) {
    const allow = options.allow ? new Set(options.allow) : undefined;
    const deny = new Set(options.deny ?? []);
    for (const catalog of catalogs) {
      if (catalog.error) continue;
      for (const [name, component] of Object.entries(catalog.components)) {
        if (deny.has(name) || (allow && !allow.has(name))) continue;
        if (!this.components.has(name)) this.components.set(name, { catalog, component });
      }
    }
  }

  names(): string[] {
    return [...this.components.keys()];
  }

  get(name: string) {
    return this.components.get(name);
  }

  isCustom(name: string): boolean {
    const entry = this.components.get(name);
    return Boolean(entry && !entry.component.builtin);
  }

  /** Custom catalogs (no standard) keyed by catalogId, for MCP-provided surfaces. */
  byCatalogId(catalogId: string): LoadedCatalog | undefined {
    return this.catalogs.find((c) => c.catalogId === catalogId || c.id === catalogId);
  }
}

/** Build the registry a workspace's render_ui tool uses. */
export function workspaceRegistry(settings: ResolvedGenerativeUi, catalogs: LoadedCatalog[]): ComponentRegistry {
  const custom = settings.catalogIds.map((id) => catalogs.find((c) => c.id === id)).filter((c): c is LoadedCatalog => Boolean(c));
  return new ComponentRegistry([...(settings.standard ? [STANDARD_CATALOG] : []), ...custom], { allow: settings.allow, deny: settings.deny });
}

/* ------------------------------------------------------------------ tool definition */

function propSignature(name: string, schema: JsonSchema, required: boolean): string {
  const opt = required ? "" : "?";
  if (Array.isArray(schema?.enum) && schema.enum.length) return `${name}${opt}: ${schema.enum.map((v: unknown) => JSON.stringify(v)).join("|")}`;
  return `${name}${opt}`;
}

export function componentSignature(name: string, component: CatalogComponent): string {
  const required = new Set(component.required ?? []);
  const props = Object.entries(component.props ?? {})
    .sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a)))
    .map(([prop, schema]) => propSignature(prop, schema, required.has(prop)));
  const detail = [component.description, ...Object.entries(component.props ?? {}).filter(([, s]) => s?.description && !s.enum && s.type !== "object").map(([p, s]) => `${p}: ${s.description}`)]
    .filter(Boolean)
    .join("; ");
  return `- ${name} {${props.join(", ")}}${detail ? ` — ${detail}` : ""}`;
}

/** The render_ui tool description generated from the active catalogs and settings. */
export function buildRenderUiDescription(settings: ResolvedGenerativeUi, registry: ComponentRegistry): string {
  if (settings.description) return settings.description;
  const standard: string[] = [];
  const custom = new Map<LoadedCatalog, string[]>();
  for (const [name, { catalog, component }] of registry.components) {
    const line = componentSignature(name, component);
    if (component.builtin) standard.push(line);
    else custom.set(catalog, [...(custom.get(catalog) ?? []), line]);
  }
  const sections = [
    "Render interactive UI for the user (A2UI v0.9) instead of plain text when a visual answer is clearly better: forms, choices, cards, comparisons, dashboards, confirmations.",
    "Send a flat list of components; exactly one has id \"root\". Containers reference children by id.",
  ];
  if (standard.length) sections.push(`Components (props):\n${standard.join("\n")}`);
  for (const [catalog, lines] of custom) {
    sections.push(`Custom components from "${catalog.name}"${catalog.description ? ` (${catalog.description})` : ""} — prefer these when they fit:\n${lines.join("\n")}`);
    if (catalog.instructions) sections.push(catalog.instructions.trim());
  }
  sections.push(
    'Any prop may be a literal or {"path": "/pointer"} into data. When the user presses a Button you receive a message starting with "[ui action]" containing the action name and resolved context — continue the task from there. Keep UIs small and focused.',
  );
  if (settings.examples) {
    const examples = [...custom.keys()].flatMap((c) => c.examples ?? []).slice(0, 3);
    for (const example of examples) {
      sections.push(`Example${example.prompt ? ` for "${example.prompt}"` : ""}: ${JSON.stringify({ components: example.components, ...(example.data ? { data: example.data } : {}) })}`);
    }
  }
  if (settings.instructions) sections.push(settings.instructions.trim());
  return sections.join("\n\n");
}

/** JSON schema for the render_ui tool, with the allowed component names enumerated. */
export function buildRenderUiSchema(registry: ComponentRegistry): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      surfaceId: { type: "string", description: "Stable id for this UI. Reuse it to update a UI you rendered earlier." },
      components: {
        type: "array",
        description: 'Flat list of components. Exactly one must have id "root". Each item: {"id": string, "component": TypeName, ...props}.',
        items: {
          type: "object",
          properties: { id: { type: "string" }, component: { type: "string", enum: registry.names() } },
          required: ["id", "component"],
        },
      },
      data: { type: "object", description: 'Initial data model. Bind with {"path": "/key"}.' },
    },
    required: ["components"],
  };
}

/* ------------------------------------------------------------------ validation */

function isBinding(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as any).path === "string");
}

function refsOf(c: A2uiComponent): string[] {
  const refs: string[] = [];
  if (typeof c.child === "string") refs.push(c.child);
  if (Array.isArray(c.children)) refs.push(...c.children.filter((r: unknown) => typeof r === "string"));
  else if (c.children && typeof c.children === "object" && typeof c.children.componentId === "string") refs.push(c.children.componentId);
  if (Array.isArray(c.tabs)) for (const t of c.tabs) if (typeof t?.child === "string") refs.push(t.child);
  return refs;
}

/**
 * Check a component list against the registry. Returns human-readable problems
 * the model can act on (unknown components, missing props, bad enum values,
 * dangling references). An empty array means the UI is valid.
 */
export function validateUi(components: unknown, registry?: ComponentRegistry, options: { partial?: boolean } = {}): string[] {
  if (!Array.isArray(components) || components.length === 0) return ["components must be a non-empty array"];
  const problems: string[] = [];
  const known = new Set<string>();
  for (const c of components as any[]) {
    if (!c || typeof c.id !== "string" || typeof c.component !== "string") {
      problems.push(`every component needs string "id" and "component" (got ${JSON.stringify(c).slice(0, 80)})`);
      continue;
    }
    if (known.has(c.id)) problems.push(`duplicate id "${c.id}"`);
    known.add(c.id);
  }
  if (!options.partial && !known.has("root")) problems.push('no component has id "root"');
  for (const c of components as any[]) {
    if (!c || typeof c.id !== "string") continue;
    if (!options.partial) for (const ref of refsOf(c)) if (!known.has(ref)) problems.push(`"${c.id}" references missing component "${ref}"`);
    if (!registry || typeof c.component !== "string") continue;
    const entry = registry.get(c.component);
    if (!entry) {
      problems.push(`"${c.id}" uses unknown component "${c.component}". Allowed: ${registry.names().join(", ")}`);
      continue;
    }
    const { component } = entry;
    for (const prop of component.required ?? []) {
      if (c[prop] === undefined && !(c.component === "Button" && prop === "action" && c.label !== undefined)) {
        problems.push(`"${c.id}" (${c.component}) is missing required prop "${prop}"`);
      }
    }
    for (const [prop, schema] of Object.entries(component.props ?? {})) {
      const value = c[prop];
      if (value === undefined || isBinding(value)) continue;
      if (Array.isArray(schema?.enum) && !schema.enum.includes(value)) {
        problems.push(`"${c.id}".${prop} must be one of ${schema.enum.map((v: unknown) => JSON.stringify(v)).join(", ")}`);
      } else if (!component.builtin && schema?.type && !matchesType(value, schema.type)) {
        problems.push(`"${c.id}".${prop} should be ${Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type}`);
      }
    }
  }
  return problems;
}

function matchesType(value: unknown, type: string | string[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    switch (t) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number";
      case "integer":
        return Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "array":
        return Array.isArray(value);
      case "object":
        return typeof value === "object" && value !== null && !Array.isArray(value);
      case "null":
        return value === null;
      default:
        return true;
    }
  });
}

/* ------------------------------------------------------------------ expansion */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/;
const MAX_DEPTH = 8;

/** Component type the web renderer uses for HTML catalog components. */
export const HTML_COMPONENT = "MokaHtml";

function substitute(value: unknown, props: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_PLACEHOLDER.exec(value);
    if (whole) return props[whole[1]!];
    return value.replace(PLACEHOLDER, (_, name: string) => {
      const v = props[name];
      return v == null || typeof v === "object" ? "" : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, props)).filter((v) => v !== undefined);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const next = substitute(v, props);
      if (next !== undefined) out[k] = next;
    }
    return out;
  }
  return value;
}

function remapRefs(c: A2uiComponent, map: (id: string) => string): A2uiComponent {
  const out = { ...c };
  if (typeof out.child === "string") out.child = map(out.child);
  if (Array.isArray(out.children)) out.children = out.children.map((r: unknown) => (typeof r === "string" ? map(r) : r));
  else if (out.children && typeof out.children === "object" && typeof out.children.componentId === "string") {
    out.children = { ...out.children, componentId: map(out.children.componentId) };
  }
  if (Array.isArray(out.tabs)) out.tabs = out.tabs.map((t: any) => (typeof t?.child === "string" ? { ...t, child: map(t.child) } : t));
  return out;
}

function withDefaults(component: CatalogComponent, instance: A2uiComponent): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(component.props ?? {})) {
    if (schema && "default" in schema) props[name] = schema.default;
  }
  for (const [k, v] of Object.entries(instance)) if (k !== "id" && k !== "component") props[k] = v;
  return props;
}

function expandOne(instance: A2uiComponent, registry: ComponentRegistry, depth: number): A2uiComponent[] {
  const entry = registry.get(instance.component);
  if (!entry || entry.component.builtin) return [instance];
  const { component } = entry;
  if (depth > MAX_DEPTH) return [{ id: instance.id, component: "Text", text: `[${instance.component}: nesting too deep]` }];
  const props = withDefaults(component, instance);

  if (component.template) {
    const internal = new Set(component.template.map((t) => t.id).filter((id): id is string => typeof id === "string"));
    const rootId = internal.has("root") ? "root" : component.template[0]?.id;
    const map = (id: string) => (!internal.has(id) ? id : id === rootId ? instance.id : `${instance.id}__${id}`);
    const out: A2uiComponent[] = [];
    for (const raw of component.template) {
      const remapped = remapRefs({ ...raw, id: map(raw.id) }, map);
      const filled = substitute(remapped, props) as A2uiComponent;
      if (instance.weight !== undefined && filled.id === instance.id) filled.weight = instance.weight;
      out.push(...expandOne(filled, registry, depth + 1));
    }
    return out;
  }

  return [
    {
      id: instance.id,
      component: HTML_COMPONENT,
      name: instance.component,
      html: component.html ?? "",
      props,
      csp: component.csp,
      height: component.height,
      ...(instance.weight !== undefined ? { weight: instance.weight } : {}),
    },
  ];
}

/** Expand custom catalog components into standard components (templates) or sandboxed HTML. */
export function expandComponents(components: A2uiComponent[], registry: ComponentRegistry): A2uiComponent[] {
  return components.flatMap((c) => (c && typeof c.component === "string" ? expandOne(c, registry, 0) : [c]));
}

/** Expand every component-bearing message in an A2UI stream. */
export function expandMessages(messages: A2uiMessage[], registry: ComponentRegistry): A2uiMessage[] {
  return messages.map((m) => {
    if (m.updateComponents?.components) {
      return { ...m, updateComponents: { ...m.updateComponents, components: expandComponents(m.updateComponents.components, registry) } };
    }
    if (m.createSurface?.components) {
      return { ...m, createSurface: { ...m.createSurface, components: expandComponents(m.createSurface.components, registry) } };
    }
    return m;
  });
}

/** Catalog ids referenced by `createSurface` messages. */
export function surfaceCatalogIds(messages: A2uiMessage[]): string[] {
  return messages.map((m) => m.createSurface?.catalogId).filter((id): id is string => typeof id === "string");
}

/** Build spec messages for render_ui input: validate, expand, and theme. */
export function renderUi(
  input: any,
  options: { fallbackId: string; registry: ComponentRegistry; theme?: SurfaceTheme; catalogId?: string },
): { messages: A2uiMessage[]; problems: string[] } {
  const raw = parseA2ui(input?.messages ?? input);
  if (raw && !Array.isArray(input?.components)) {
    const problems = raw.flatMap((m) => (m.updateComponents?.components ? validateUi(m.updateComponents.components, options.registry, { partial: true }) : []));
    return { messages: expandMessages(raw, options.registry), problems };
  }
  const problems = validateUi(input?.components, options.registry);
  if (problems.length) return { messages: [], problems };
  const surfaceId = typeof input?.surfaceId === "string" && input.surfaceId ? input.surfaceId : options.fallbackId;
  const theme = options.theme && Object.keys(options.theme).length ? options.theme : undefined;
  const messages: A2uiMessage[] = [
    { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: options.catalogId ?? A2UI_CATALOG, ...(theme ? { theme } : {}) } },
    { version: A2UI_VERSION, updateComponents: { surfaceId, components: expandComponents(input.components, options.registry) } },
  ];
  if (input?.data && typeof input.data === "object") {
    messages.push({ version: A2UI_VERSION, updateDataModel: { surfaceId, path: "/", value: input.data } });
  }
  return { messages, problems: [] };
}

/** Sample render_ui input that previews one component (for catalog browsers). */
export function previewInput(name: string, component: CatalogComponent): { components: A2uiComponent[]; data: Record<string, unknown> } {
  const props: Record<string, unknown> = { ...(component.example ?? {}) };
  if (name === "Button") {
    return {
      components: [
        { id: "root", component: "Button", child: "label", variant: "primary", action: { event: { name: "preview" } } },
        { id: "label", component: "Text", text: "Press me" },
      ],
      data: {},
    };
  }
  if (["Row", "Column", "List"].includes(name)) {
    return {
      components: [
        { id: "root", component: name, children: ["a", "b"] },
        { id: "a", component: "Text", text: "First" },
        { id: "b", component: "Text", text: "Second" },
      ],
      data: {},
    };
  }
  if (name === "Card") {
    return { components: [{ id: "root", component: "Card", child: "t" }, { id: "t", component: "Text", text: "Inside a card" }], data: {} };
  }
  if (name === "Tabs") {
    return {
      components: [
        { id: "root", component: "Tabs", tabs: [{ title: "One", child: "a" }, { title: "Two", child: "b" }] },
        { id: "a", component: "Text", text: "Tab one" },
        { id: "b", component: "Text", text: "Tab two" },
      ],
      data: {},
    };
  }
  for (const [prop, schema] of Object.entries(component.props ?? {})) {
    if (props[prop] !== undefined) continue;
    if (schema === binding || schema?.description === binding.description) props[prop] = { path: `/${prop}` };
    else if ((component.required ?? []).includes(prop)) props[prop] = sampleValue(prop, schema);
  }
  if (name === "Image" && !props.url) props.url = "https://picsum.photos/seed/moka/640/320";
  return { components: [{ id: "root", component: name, ...props }], data: {} };
}

function sampleValue(prop: string, schema: JsonSchema): unknown {
  if ("default" in (schema ?? {})) return schema.default;
  if (Array.isArray(schema?.enum)) return schema.enum[0];
  switch (schema?.type) {
    case "number":
    case "integer":
      return 42;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return prop.charAt(0).toUpperCase() + prop.slice(1);
  }
}
