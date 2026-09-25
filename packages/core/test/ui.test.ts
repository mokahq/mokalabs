import { describe, expect, it } from "vitest";
import {
  detectResultUi,
  mcpContentToText,
  parseA2ui,
  renderUiToMessages,
  toolUiResourceUri,
  toolVisibleToModel,
  validateComponents,
} from "../src/index.js";

describe("MCP Apps", () => {
  it("reads the tool's UI resource and visibility", () => {
    expect(toolUiResourceUri({ _meta: { ui: { resourceUri: "ui://s/app" } } })).toBe("ui://s/app");
    expect(toolUiResourceUri({ _meta: { "ui/resourceUri": "ui://s/legacy" } })).toBe("ui://s/legacy");
    expect(toolUiResourceUri({ _meta: { ui: { resourceUri: "https://nope" } } })).toBeUndefined();
    expect(toolVisibleToModel({ _meta: { ui: { visibility: ["app"] } } })).toBe(false);
    expect(toolVisibleToModel({ _meta: { ui: { visibility: ["model", "app"] } } })).toBe(true);
    expect(toolVisibleToModel({})).toBe(true);
  });
});

describe("legacy MCP-UI", () => {
  it("detects rawHtml and externalUrl resources and hides them from the model", () => {
    const html = { content: [{ type: "resource", resource: { uri: "ui://s/card", mimeType: "text/html", text: "<b>hi</b>" } }] };
    expect(detectResultUi("s", html)).toMatchObject({ kind: "mcp-ui", html: "<b>hi</b>" });
    const url = { content: [{ type: "resource", resource: { uri: "ui://s/x", mimeType: "text/uri-list", text: "# c\nhttps://example.com" } }] };
    expect(detectResultUi("s", url)).toMatchObject({ kind: "mcp-ui", url: "https://example.com" });
    expect(mcpContentToText(html)).toBe("[interactive UI shown to the user: ui://s/card]");
  });
});

describe("A2UI", () => {
  const messages = [
    { version: "v0.9", createSurface: { surfaceId: "a", catalogId: "c" } },
    { version: "v0.9", updateComponents: { surfaceId: "a", components: [{ id: "root", component: "Text", text: "hi" }] } },
  ];

  it("parses messages from arrays, objects, JSON and JSONL", () => {
    expect(parseA2ui(messages)).toHaveLength(2);
    expect(parseA2ui(JSON.stringify(messages))).toHaveLength(2);
    expect(parseA2ui(messages.map((m) => JSON.stringify(m)).join("\n"))).toHaveLength(2);
    expect(parseA2ui({ messages })).toHaveLength(2);
    expect(parseA2ui({ hello: 1 })).toBeUndefined();
    expect(parseA2ui("not json")).toBeUndefined();
  });

  it("detects A2UI in MCP results", () => {
    const viaResource = { content: [{ type: "resource", resource: { uri: "a2ui://x", mimeType: "application/json+a2ui", text: JSON.stringify(messages) } }] };
    expect(detectResultUi("s", viaResource)).toEqual({ kind: "a2ui", messages });
    expect(detectResultUi("s", { structuredContent: { a2ui: messages } })).toEqual({ kind: "a2ui", messages });
    expect(detectResultUi("s", { content: [{ type: "text", text: "plain" }] })).toBeUndefined();
  });

  it("turns render_ui input into spec messages", () => {
    const out = renderUiToMessages({ components: [{ id: "root", component: "Text", text: "x" }], data: { a: 1 } }, "fallback");
    expect(out.map((m) => Object.keys(m).find((k) => k !== "version"))).toEqual(["createSurface", "updateComponents", "updateDataModel"]);
    expect(out[0]!.createSurface.surfaceId).toBe("fallback");
    expect(renderUiToMessages({ messages }, "f")).toEqual(messages);
  });

  it("validates component trees", () => {
    expect(validateComponents([{ id: "root", component: "Column", children: ["a"] }, { id: "a", component: "Text" }])).toEqual([]);
    expect(validateComponents([{ id: "x", component: "Text" }])).toContain('no component has id "root"');
    expect(validateComponents([{ id: "root", component: "Card", child: "missing" }])[0]).toMatch(/missing/);
    expect(validateComponents([])).toHaveLength(1);
  });
});
