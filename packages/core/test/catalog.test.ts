import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvalMode,
  buildRenderUiDescription,
  buildRenderUiSchema,
  ComponentRegistry,
  EventBus,
  expandComponents,
  HTML_COMPONENT,
  InteractionBroker,
  loadCatalog,
  parseCatalog,
  parseConfig,
  previewInput,
  renderUi,
  resolveGenerativeUi,
  STANDARD_CATALOG,
  validateUi,
  workspaceRegistry,
  type LoadedCatalog,
} from "../src/index.js";

const banking: LoadedCatalog = {
  id: "banking",
  source: "inline",
  ...parseCatalog(
    {
      catalogId: "https://example.com/banking/v1",
      name: "Banking",
      instructions: "Always show balances with AccountCard.",
      components: {
        AccountCard: {
          description: "An account and its balance",
          props: { name: { type: "string" }, balance: { type: "string" }, tone: { type: "string", enum: ["good", "bad"], default: "good" } },
          required: ["name", "balance"],
          template: [
            { id: "root", component: "Card", child: "col" },
            { id: "col", component: "Column", children: ["title", "amount"] },
            { id: "title", component: "Text", text: "{{name}}", variant: "h4" },
            { id: "amount", component: "Text", text: "Balance: {{balance}} ({{tone}})" },
          ],
        },
        Sparkline: {
          props: { values: { type: "array" } },
          required: ["values"],
          html: "<svg></svg>",
          csp: { resourceDomains: ["https://cdn.jsdelivr.net"] },
        },
      },
      examples: [{ prompt: "show my account", components: [{ id: "root", component: "AccountCard", name: "Main", balance: "$10" }] }],
    },
    { id: "banking" },
  ),
};

describe("generative UI settings", () => {
  it("accepts the old boolean and the new object form", () => {
    expect(resolveGenerativeUi({}).enabled).toBe(true);
    expect(resolveGenerativeUi({ generativeUi: false }).enabled).toBe(false);
    const custom = resolveGenerativeUi({ generativeUi: { toolName: "show_ui", catalogIds: ["banking"], deny: ["Slider"] } });
    expect(custom).toMatchObject({ enabled: true, toolName: "show_ui", standard: true, catalogIds: ["banking"], deny: ["Slider"] });
    const config = parseConfig({ catalogs: [{ id: "b", path: "./b.json" }], workspaces: [{ id: "w", name: "W", generativeUi: { standard: false, catalogIds: ["b"] } }] });
    expect(config.catalogs[0]!.id).toBe("b");
    expect(() => parseConfig({ workspaces: [{ id: "w", name: "W", generativeUi: { toolName: "bad name!" } }] })).toThrow();
  });

  it("builds the registry from standard + chosen catalogs with allow/deny", () => {
    const registry = workspaceRegistry(resolveGenerativeUi({ generativeUi: { catalogIds: ["banking"], deny: ["Slider"] } }), [banking]);
    expect(registry.names()).toContain("AccountCard");
    expect(registry.names()).toContain("Text");
    expect(registry.names()).not.toContain("Slider");
    const only = workspaceRegistry(resolveGenerativeUi({ generativeUi: { standard: false, catalogIds: ["banking"] } }), [banking]);
    expect(only.names()).toEqual(["AccountCard", "Sparkline"]);
  });
});

describe("tool definition", () => {
  const settings = resolveGenerativeUi({ generativeUi: { catalogIds: ["banking"], instructions: "Be brief." } });
  const registry = workspaceRegistry(settings, [banking]);

  it("describes custom components, catalog instructions, examples and workspace instructions", () => {
    const description = buildRenderUiDescription(settings, registry);
    expect(description).toMatch(/- AccountCard \{name, balance, tone\?: "good"\|"bad"\} — An account and its balance/);
    expect(description).toContain("Always show balances with AccountCard.");
    expect(description).toContain('Example for "show my account"');
    expect(description.trim().endsWith("Be brief.")).toBe(true);
    expect(buildRenderUiDescription({ ...settings, description: "custom" }, registry)).toBe("custom");
  });

  it("enumerates allowed components in the schema", () => {
    const schema: any = buildRenderUiSchema(registry);
    expect(schema.properties.components.items.properties.component.enum).toContain("AccountCard");
  });
});

describe("validation", () => {
  const registry = new ComponentRegistry([STANDARD_CATALOG, banking]);

  it("reports unknown components, missing props, enum and type errors", () => {
    const problems = validateUi(
      [
        { id: "root", component: "Column", children: ["a", "b", "c", "d"] },
        { id: "a", component: "Carousel" },
        { id: "b", component: "AccountCard", name: "x" },
        { id: "c", component: "Text", text: "hi", variant: "huge" },
        { id: "d", component: "Sparkline", values: "1,2,3" },
      ],
      registry,
    );
    expect(problems.join("\n")).toMatch(/unknown component "Carousel"\. Allowed: .*AccountCard/);
    expect(problems.join("\n")).toMatch(/"b" \(AccountCard\) is missing required prop "balance"/);
    expect(problems.join("\n")).toMatch(/"c"\.variant must be one of/);
    expect(problems.join("\n")).toMatch(/"d"\.values should be array/);
  });

  it("accepts bindings for any prop and partial updates", () => {
    expect(validateUi([{ id: "root", component: "AccountCard", name: { path: "/n" }, balance: { path: "/b" } }], registry)).toEqual([]);
    expect(validateUi([{ id: "x", component: "Text", text: "t" }], registry, { partial: true })).toEqual([]);
  });
});

describe("expansion", () => {
  const registry = new ComponentRegistry([STANDARD_CATALOG, banking]);

  it("expands templates with namespaced ids, props, defaults and bindings", () => {
    const out = expandComponents(
      [
        { id: "root", component: "Column", children: ["acct"] },
        { id: "acct", component: "AccountCard", name: { path: "/name" }, balance: "$5", weight: 1 },
      ],
      registry,
    );
    const byId = Object.fromEntries(out.map((c) => [c.id, c]));
    expect(byId.acct).toMatchObject({ component: "Card", child: "acct__col", weight: 1 });
    expect(byId["acct__col"]).toMatchObject({ children: ["acct__title", "acct__amount"] });
    expect(byId["acct__title"]!.text).toEqual({ path: "/name" });
    expect(byId["acct__amount"]!.text).toBe("Balance: $5 (good)");
    expect(validateUi(out)).toEqual([]);
  });

  it("turns HTML components into sandboxed MokaHtml nodes", () => {
    const [node] = expandComponents([{ id: "root", component: "Sparkline", values: [1, 2] }], registry);
    expect(node).toMatchObject({ id: "root", component: HTML_COMPONENT, name: "Sparkline", html: "<svg></svg>", props: { values: [1, 2] } });
  });

  it("renders render_ui input end to end with a theme", () => {
    const { messages, problems } = renderUi(
      { surfaceId: "s", components: [{ id: "root", component: "AccountCard", name: "Main", balance: "$1" }] },
      { fallbackId: "f", registry, theme: { primaryColor: "#0a5cff" } },
    );
    expect(problems).toEqual([]);
    expect(messages[0]!.createSurface).toMatchObject({ surfaceId: "s", theme: { primaryColor: "#0a5cff" } });
    expect(messages[1]!.updateComponents.components.map((c: any) => c.component)).toEqual(["Card", "Column", "Text", "Text"]);
    expect(renderUi({ components: [{ id: "root", component: "Nope" }] }, { fallbackId: "f", registry }).problems).toHaveLength(1);
  });

  it("builds previews for every standard component", () => {
    for (const [name, component] of Object.entries(STANDARD_CATALOG.components)) {
      const { components } = previewInput(name, component);
      expect(validateUi(components, registry), name).toEqual([]);
    }
  });
});

describe("catalog loading", () => {
  it("loads files with htmlFile and reports errors instead of throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "moka-cat-"));
    await writeFile(path.join(dir, "chart.html"), "<div>chart</div>");
    await writeFile(path.join(dir, "cat.json"), JSON.stringify({ name: "Charts", components: { Chart: { htmlFile: "chart.html" } } }));
    const ok = await loadCatalog({ id: "charts", path: "cat.json" }, dir);
    expect(ok.error).toBeUndefined();
    expect(ok.components.Chart!.html).toBe("<div>chart</div>");
    expect(ok.catalogId).toBe("charts");
    const bad = await loadCatalog({ id: "bad", catalog: { components: { Text: { template: [] } } } }, dir);
    expect(bad.error).toMatch(/standard component/);
    const missing = await loadCatalog({ id: "m", path: "nope.json" }, dir);
    expect(missing.error).toBeTruthy();
  });
});

describe("approvals", () => {
  const server = { id: "s", name: "S", transport: "stdio" as const };

  it("resolves the approval mode with the right precedence", () => {
    expect(approvalMode(server, { name: "t" })).toBe("auto");
    expect(approvalMode(server, { name: "t", annotations: { destructiveHint: true } })).toBe("ask");
    expect(approvalMode({ ...server, approval: { default: "ask" } }, { name: "t" })).toBe("ask");
    expect(approvalMode({ ...server, approval: { default: "ask", tools: { t: "auto" } } }, { name: "t" })).toBe("auto");
    expect(approvalMode(server, { name: "t" }, { id: "w", name: "W", mcpServerIds: [], skillIds: [], requireApproval: true })).toBe("ask");
  });

  it("brokers requests over the event bus", async () => {
    const bus = new EventBus();
    const broker = new InteractionBroker(bus);
    const pending = broker.request({ kind: "tool-approval", toolCallId: "c", serverId: "s", serverName: "S", tool: "t", input: {} });
    const [request] = broker.pending();
    expect(bus.history().at(-1)).toMatchObject({ kind: "interaction.request", data: { id: request!.id } });
    expect(broker.respond(request!.id, { approved: true })).toBe(true);
    await expect(pending).resolves.toEqual({ approved: true });
    expect(bus.history().at(-1)!.kind).toBe("interaction.resolved");
    expect(broker.respond(request!.id, { approved: true })).toBe(false);

    const controller = new AbortController();
    const cancelled = broker.request({ kind: "elicitation", serverId: "s", serverName: "S", message: "?", mode: "form" }, controller.signal);
    controller.abort();
    await expect(cancelled).resolves.toEqual({ action: "cancel" });
  });
});
