import type { McpServerConfig, ToolOverride } from "./config.js";
import type { McpTool } from "./mcp.js";

/** Per server, per tool: what to change in a tool's definition before a model sees it. */
export type ToolOverrides = Record<string, Record<string, ToolOverride>>;

/**
 * A tool as the model should see it: the server's definition with an override
 * applied (`toolOverrides` in moka.json, or one being tried by Improve). Only
 * wording changes: the description, and descriptions and examples of
 * parameters the tool already has. Names, types and required fields stay the
 * server's, so calls still match what the server accepts.
 */
export function applyToolOverride(tool: McpTool, override: ToolOverride | undefined): McpTool {
  if (!override) return tool;
  const schema = tool.inputSchema ?? {};
  const properties = (schema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
  const params = Object.entries(override.params ?? {}).filter(([name]) => properties[name]);
  return {
    ...tool,
    ...(override.description !== undefined ? { description: override.description } : {}),
    ...(params.length
      ? {
          inputSchema: {
            ...schema,
            properties: {
              ...properties,
              ...Object.fromEntries(
                params.map(([name, p]) => [
                  name,
                  { ...properties[name], ...(p.description !== undefined ? { description: p.description } : {}), ...(p.examples?.length ? { examples: p.examples } : {}) },
                ]),
              ),
            },
          },
        }
      : {}),
  };
}

/** The override for one tool: one being tried wins over the saved one. */
export function toolOverrideFor(server: Pick<McpServerConfig, "id" | "toolOverrides">, tool: string, trying?: ToolOverrides): ToolOverride | undefined {
  return trying?.[server.id]?.[tool] ?? server.toolOverrides?.[tool];
}
