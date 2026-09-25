/**
 * Generative / interactive UI support.
 *
 * Moka understands three ways an agent can put UI in front of the user:
 *
 * 1. **MCP Apps** (official MCP extension, SEP-1865): a tool declares
 *    `_meta.ui.resourceUri` pointing at a `ui://` resource whose mimeType is
 *    `text/html;profile=mcp-app`. The host renders it in a sandboxed iframe
 *    and talks JSON-RPC over postMessage.
 * 2. **MCP-UI (legacy)**: a tool result embeds a `resource` whose uri starts
 *    with `ui://` (rawHtml `text/html` or externalUrl `text/uri-list`).
 * 3. **A2UI** (declarative, v0.9): JSON messages (`createSurface`,
 *    `updateComponents`, `updateDataModel`, `deleteSurface`) rendered with
 *    native components. Any model can emit it through the built-in
 *    `render_ui` tool, and MCP servers can return it in tool results.
 */

export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const A2UI_MIME = "application/json+a2ui";
export const A2UI_VERSION = "v0.9";
export const A2UI_CATALOG = "https://a2ui.org/specification/v0_9/standard_catalog.json";

export type UiDescriptor =
  | { kind: "mcp-app"; serverId: string; resourceUri: string }
  | { kind: "mcp-ui"; serverId: string; uri: string; mimeType: string; html?: string; url?: string }
  | { kind: "a2ui"; messages: A2uiMessage[] };

export type A2uiMessage = Record<string, any>;

/** The UI a tool declares up front (MCP Apps). Supports the pre-release flat key too. */
export function toolUiResourceUri(tool: { _meta?: Record<string, any> } | undefined): string | undefined {
  const meta = tool?._meta;
  if (!meta) return undefined;
  const uri = meta.ui?.resourceUri ?? meta["ui/resourceUri"];
  return typeof uri === "string" && uri.startsWith("ui://") ? uri : undefined;
}

/** Whether the model may see this tool (MCP Apps `visibility`). */
export function toolVisibleToModel(tool: { _meta?: Record<string, any> } | undefined): boolean {
  const visibility = tool?._meta?.ui?.visibility;
  return !Array.isArray(visibility) || visibility.includes("model");
}

/** Find UI inside an MCP tool result: legacy MCP-UI resources or A2UI payloads. */
export function detectResultUi(serverId: string, result: { content?: unknown[]; structuredContent?: unknown }): UiDescriptor | undefined {
  for (const block of (result.content ?? []) as any[]) {
    const resource = block?.type === "resource" ? block.resource : undefined;
    if (!resource) continue;
    const mimeType = String(resource.mimeType ?? "");
    if (mimeType.startsWith(A2UI_MIME) && typeof resource.text === "string") {
      const messages = parseA2ui(resource.text);
      if (messages) return { kind: "a2ui", messages };
    }
    if (typeof resource.uri === "string" && resource.uri.startsWith("ui://")) {
      if (mimeType === "text/uri-list") {
        const url = String(resource.text ?? "").split(/\r?\n/).find((l: string) => l && !l.startsWith("#"));
        if (url) return { kind: "mcp-ui", serverId, uri: resource.uri, mimeType, url: url.trim() };
      }
      if (mimeType.startsWith("text/html")) {
        const html = typeof resource.text === "string" ? resource.text : resource.blob ? decodeBase64(resource.blob) : undefined;
        if (html) return { kind: "mcp-ui", serverId, uri: resource.uri, mimeType, html };
      }
    }
  }
  const structured = result.structuredContent as any;
  const fromStructured = structured && (parseA2ui(structured.a2ui) ?? parseA2ui(structured));
  return fromStructured ? { kind: "a2ui", messages: fromStructured } : undefined;
}

function decodeBase64(data: string): string | undefined {
  try {
    return Buffer.from(data, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

const A2UI_KEYS = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface", "surfaceUpdate", "dataModelUpdate", "beginRendering"];

/** Accept an A2UI message, an array of them, or JSON / JSONL text. Returns undefined if it isn't A2UI. */
export function parseA2ui(input: unknown): A2uiMessage[] | undefined {
  let value = input;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return undefined;
    try {
      value = JSON.parse(text);
    } catch {
      const lines = text.split(/\r?\n/).filter(Boolean);
      try {
        value = lines.map((l) => JSON.parse(l));
      } catch {
        return undefined;
      }
    }
  }
  const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as any).messages) ? (value as any).messages : [value];
  const messages = list.filter((m: any) => m && typeof m === "object" && A2UI_KEYS.some((k) => k in m));
  return messages.length ? messages : undefined;
}

/** JSON schema for the built-in `render_ui` tool (kept small so every model handles it). */
export const RENDER_UI_SCHEMA = {
  type: "object",
  properties: {
    surfaceId: { type: "string", description: "Stable id for this UI. Reuse it to update a UI you rendered earlier." },
    components: {
      type: "array",
      description:
        'Flat list of A2UI v0.9 components. Exactly one must have id "root". Each item: {"id": string, "component": TypeName, ...props}. Containers reference children by id.',
      items: { type: "object", properties: { id: { type: "string" }, component: { type: "string" } }, required: ["id", "component"] },
    },
    data: { type: "object", description: "Initial data model. Bind with {\"path\": \"/key\"}." },
  },
  required: ["components"],
} as const;

export const RENDER_UI_DESCRIPTION = `Render interactive UI for the user (A2UI v0.9 standard catalog) instead of plain text when a visual answer is clearly better: forms, choices, cards, comparisons, dashboards, confirmations.
Components (props):
- Text {text, variant?: "h1"|"h2"|"h3"|"h4"|"h5"|"caption"|"body"}
- Image {url, variant?: "icon"|"avatar"|"smallFeature"|"mediumFeature"|"largeFeature"|"header"}
- Icon {name}  (e.g. "check", "star", "calendar", "mail", "phone", "info", "warning", "error", "search", "settings", "person", "home", "shoppingCart", "favorite")
- Row {children: [ids], justify?, align?}   Column {children: [ids], justify?, align?}
- Card {child: id}   Divider {axis?}   List {children: [ids] | {"componentId": templateId, "path": "/items"}}
- Button {child: textComponentId, variant?: "primary"|"borderless", action: {"event": {"name": string, "context": {key: value | {"path": "/x"}}}}}
- TextField {label, value: {"path": "/field"}, variant?: "shortText"|"longText"|"number"|"obscured"}
- CheckBox {label, value: {"path": "/flag"}}   Slider {value: {"path": "/n"}, min?, max?}
- ChoicePicker {label?, options: [{label, value}], value: {"path": "/choice"}, variant?: "mutuallyExclusive"|"multipleSelection"}
- DateTimeInput {value: {"path": "/when"}, enableDate?, enableTime?}
Any string prop may be a literal or {"path": "/pointer"} into data. When the user presses a Button you receive a message starting with "[ui action]" containing the action name and resolved context — continue the task from there. Keep UIs small and focused.`;

/** Normalise `render_ui` input (or raw A2UI messages) into spec messages. */
export function renderUiToMessages(input: any, fallbackId: string): A2uiMessage[] {
  const raw = parseA2ui(input?.messages ?? input);
  if (raw && !Array.isArray(input?.components)) return raw;
  const surfaceId = typeof input?.surfaceId === "string" && input.surfaceId ? input.surfaceId : fallbackId;
  const components = Array.isArray(input?.components) ? input.components : [];
  const messages: A2uiMessage[] = [
    { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: A2UI_CATALOG } },
    { version: A2UI_VERSION, updateComponents: { surfaceId, components } },
  ];
  if (input?.data && typeof input.data === "object") {
    messages.push({ version: A2UI_VERSION, updateDataModel: { surfaceId, path: "/", value: input.data } });
  }
  return messages;
}

/** Light validation so the model gets actionable feedback instead of a blank surface. */
export function validateComponents(components: unknown): string[] {
  if (!Array.isArray(components) || components.length === 0) return ["components must be a non-empty array"];
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const c of components as any[]) {
    if (!c || typeof c.id !== "string" || typeof c.component !== "string") {
      problems.push(`every component needs string "id" and "component" (got ${JSON.stringify(c).slice(0, 80)})`);
      continue;
    }
    ids.add(c.id);
  }
  if (!ids.has("root")) problems.push('no component has id "root"');
  for (const c of components as any[]) {
    const refs = [c?.child, ...(Array.isArray(c?.children) ? c.children : [])].filter((r) => typeof r === "string");
    for (const ref of refs) if (!ids.has(ref)) problems.push(`"${c.id}" references missing component "${ref}"`);
  }
  return problems;
}
