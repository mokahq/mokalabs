import { describe, expect, it } from "vitest";
import { contextBudget, estimateTokens } from "../src/budget.js";

const tool = (name: string, description: string, props: Record<string, unknown> = {}) => ({ name, description, inputSchema: { type: "object", properties: props } });
const state = (tools: any[], extra: Record<string, unknown> = {}) => ({ id: "s", name: "S", status: "connected", tools, prompts: [], resources: [], resourceTemplates: [], subscriptions: [], stderr: [], ...extra }) as any;

describe("context budget", () => {
  const workspace = { id: "w", name: "W", mcpServerIds: ["fs", "gh"], skillIds: [], systemPrompt: "You are helpful.", generativeUi: false } as any;
  const servers = [
    { id: "fs", name: "Files", transport: "stdio", disabledTools: ["delete_file"] },
    { id: "gh", name: "GitHub", transport: "stdio" },
  ] as any[];

  it("counts the system prompt, instructions and each visible tool; hidden tools show but don't count", () => {
    const budget = contextBudget({
      workspace,
      servers,
      states: [
        state([tool("read_file", "Read a file", { path: { type: "string" } }), tool("delete_file", "Delete a file. ".repeat(50))], { instructions: "Use absolute paths." }),
        undefined,
      ],
      skills: [],
      catalogs: [],
    });
    const byName = Object.fromEntries(budget.items.map((i) => [i.name, i]));
    expect(byName["System prompt"]!.tokens).toBe(estimateTokens("You are helpful."));
    expect(byName["Server instructions"]).toMatchObject({ source: "Files", serverId: "fs" });
    expect(byName.read_file).toMatchObject({ kind: "tool", source: "Files", serverId: "fs" });
    expect(byName.delete_file).toMatchObject({ hidden: true });
    expect(byName.delete_file!.tokens).toBeGreaterThan(byName.read_file!.tokens * 5);
    expect(budget.total).toBe(budget.items.filter((i) => !i.hidden).reduce((n, i) => n + i.tokens, 0));
    expect(budget.notConnected).toEqual([{ id: "gh", name: "GitHub", status: "idle" }]);
  });

  it("includes Moka's render_ui tool when generative UI is on", () => {
    const budget = contextBudget({ workspace: { ...workspace, generativeUi: true }, servers: [], states: [], skills: [], catalogs: [] });
    const render = budget.items.find((i) => i.source === "generative UI");
    expect(render?.name).toBe("render_ui");
    expect(render!.tokens).toBeGreaterThan(200);
  });

  it("estimates about 4 characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd".repeat(25))).toBe(25);
  });
});
