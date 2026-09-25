import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoverSkills,
  exportCode,
  importMcpJson,
  loadSkill,
  mcpContentToText,
  mokaJsonSchema,
  parseConfig,
  parseFrontmatter,
  readSkillFile,
  redactConfig,
  resolveSecret,
  skillsSystemPrompt,
  toolKey,
  uniqueId,
} from "../src/index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("config", () => {
  it("fills defaults and guarantees a workspace", () => {
    const config = parseConfig({});
    expect(config.workspaces).toHaveLength(1);
    expect(config.activeWorkspaceId).toBe(config.workspaces[0]!.id);
    expect(config.llms).toEqual([]);
  });

  it("repairs a dangling activeWorkspaceId", () => {
    const config = parseConfig({ activeWorkspaceId: "nope", workspaces: [{ id: "a", name: "A" }] });
    expect(config.activeWorkspaceId).toBe("a");
  });

  it("rejects unknown providers", () => {
    expect(() => parseConfig({ llms: [{ id: "x", name: "X", provider: "nope", model: "m" }] })).toThrow();
  });

  it("resolves env references", () => {
    const env = { KEY: "secret", HOST: "example.com" };
    expect(resolveSecret("env:KEY", env)).toBe("secret");
    expect(resolveSecret("Bearer ${KEY}", env)).toBe("Bearer secret");
    expect(resolveSecret("https://${HOST}/v1", env)).toBe("https://example.com/v1");
    expect(resolveSecret("env:MISSING", env)).toBe("");
    expect(resolveSecret("literal", env)).toBe("literal");
    expect(resolveSecret(undefined, env)).toBeUndefined();
  });

  it("redacts literal secrets but keeps env references", () => {
    const config = parseConfig({
      llms: [
        { id: "a", name: "A", provider: "openai", model: "m", apiKey: "sk-live-123", headers: { Authorization: "Bearer x", "X-Org": "acme" } },
        { id: "b", name: "B", provider: "openai", model: "m", apiKey: "env:OPENAI_API_KEY" },
      ],
      mcpServers: [{ id: "s", name: "S", transport: "stdio", command: "x", env: { GITHUB_TOKEN: "ghp_123", DEBUG: "1" } }],
    });
    const safe = redactConfig(config);
    expect(safe.llms[0]!.apiKey).toBe("<set-me>");
    expect(safe.llms[0]!.headers).toEqual({ Authorization: "<redacted>", "X-Org": "acme" });
    expect(safe.llms[1]!.apiKey).toBe("env:OPENAI_API_KEY");
    expect(safe.mcpServers[0]!.env).toEqual({ GITHUB_TOKEN: "<redacted>", DEBUG: "1" });
  });

  it("generates unique ids", () => {
    expect(uniqueId("My Server!", [])).toBe("my-server");
    expect(uniqueId("a", ["a", "a-2"])).toBe("a-3");
  });

  it("produces a JSON schema", () => {
    const schema = mokaJsonSchema() as any;
    expect(schema.properties.llms).toBeDefined();
    expect(schema.title).toBe("Moka config");
  });
});

describe("interop", () => {
  it("imports Claude Desktop / Cursor mcpServers JSON", () => {
    const servers = importMcpJson({
      mcpServers: {
        fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], env: { A: "1" } },
        remote: { type: "sse", url: "https://example.com/sse" },
        http: { url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } },
      },
    });
    expect(servers.map((s) => [s.id, s.transport])).toEqual([
      ["fs", "stdio"],
      ["remote", "sse"],
      ["http", "http"],
    ]);
    expect(servers[0]!.env).toEqual({ A: "1" });
  });

  it("imports VS Code servers JSON from a string and avoids id clashes", () => {
    const servers = importMcpJson(JSON.stringify({ servers: { fs: { command: "node" } } }), ["fs"]);
    expect(servers[0]!.id).toBe("fs-2");
  });

  it("throws on JSON without servers", () => {
    expect(() => importMcpJson({ mcpServers: {} })).toThrow(/No MCP servers/);
  });

  it("exports code for every target", () => {
    const config = parseConfig({
      llms: [{ id: "a", name: "A", provider: "anthropic", model: "claude-sonnet-5", apiKey: "env:ANTHROPIC_API_KEY" }],
      mcpServers: [
        { id: "demo", name: "Demo", transport: "stdio", command: "moka:demo" },
        { id: "wiki", name: "Wiki", transport: "http", url: "https://mcp.deepwiki.com/mcp" },
      ],
      workspaces: [{ id: "w", name: "W", llmId: "a", mcpServerIds: ["demo", "wiki"], systemPrompt: "Be brief." }],
    });
    const input = { config, workspace: config.workspaces[0]!, llm: config.llms[0], servers: config.mcpServers };
    const ts = exportCode("ai-sdk", input);
    expect(ts).toContain('createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })("claude-sonnet-5")');
    expect(ts).toContain("@mokalabs/sandbox");
    expect(ts).not.toContain("moka:demo");
    const py = exportCode("langgraph", input);
    expect(py).toContain("ChatAnthropic");
    expect(py).toContain('"transport": "streamable_http"');
    const json = JSON.parse(exportCode("mcp-json", input));
    expect(json.mcpServers.Wiki).toEqual({ type: "http", url: "https://mcp.deepwiki.com/mcp" });
  });
});

describe("agent helpers", () => {
  it("builds provider-safe tool names", () => {
    expect(toolKey("my server", "do.thing")).toBe("my_server__do_thing");
    expect(toolKey("x".repeat(40), "y".repeat(40))).toHaveLength(64);
  });

  it("flattens MCP content", () => {
    expect(mcpContentToText({ content: [{ type: "text", text: "a" }, { type: "image", mimeType: "image/png", data: "…" }] })).toBe("a\n[image image/png]");
    expect(mcpContentToText({ content: [], structuredContent: { ok: true } })).toBe('{"ok":true}');
  });
});

describe("skills", () => {
  it("parses frontmatter including folded blocks", () => {
    const { data, body } = parseFrontmatter("---\nname: x\ndescription: >\n  one\n  two\nquoted: \"hi\"\n---\nBody");
    expect(data).toEqual({ name: "x", description: "one two", quoted: "hi" });
    expect(body).toBe("Body");
  });

  it("loads a folder skill with its files", async () => {
    const skill = await loadSkill({ id: "g", path: "skills/greeter" }, fixtures);
    expect(skill.error).toBeUndefined();
    expect(skill.name).toBe("greeter");
    expect(skill.description).toBe("Greets people warmly. Use for hellos.");
    expect(skill.files).toEqual(["notes.md"]);
    expect(await readSkillFile(skill, "notes.md")).toContain("wave");
    await expect(readSkillFile(skill, "../../core.test.ts")).rejects.toThrow(/escapes/);
    expect(skillsSystemPrompt([skill])).toContain("**greeter**");
  });

  it("loads inline skills and reports broken ones", async () => {
    const inline = await loadSkill({ id: "i", content: "---\nname: inline\ndescription: d\n---\nDo it" });
    expect(inline).toMatchObject({ name: "inline", description: "d", body: "Do it" });
    const broken = await loadSkill({ id: "b", path: "does/not/exist" }, fixtures);
    expect(broken.error).toBeTruthy();
  });

  it("discovers skills in a folder", async () => {
    const found = await discoverSkills(path.join(fixtures, "skills"));
    expect(found.map((p) => path.basename(p))).toEqual(["greeter"]);
  });
});
