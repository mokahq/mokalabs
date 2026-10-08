import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { applyPlan, isWrapped, knownLocations, locationForFile, planConfig } from "../src/index.js";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

const VSCODE = `{
  // Servers for this repo
  "servers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "\${input:token}" }
    },
    /* docs search, remote */
    "docs": { "type": "http", "url": "https://example.com/mcp" },
    "local": { "command": "node", "args": ["server.js"] }
  }
}
`;

const CURSOR = `{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
  }
}
`;

const GEMINI = `{
  "mcpServers": {
    "notes": { "command": "uvx", "args": ["mcp-notes"] }
  }
}
`;

// Gemini CLI: servers live next to the CLI's other settings.
const GEMINI_SETTINGS = `{
  "theme": "Dracula",
  "mcpServers": {
    "git": { "command": "uvx", "args": ["mcp-server-git"], "timeout": 30000 }
  }
}
`;

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moka-wrap-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  mkdirSync(path.join(project, ".vscode"), { recursive: true });
  mkdirSync(path.join(home, ".cursor"), { recursive: true });
  mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
  writeFileSync(path.join(project, ".vscode", "mcp.json"), VSCODE);
  writeFileSync(path.join(home, ".cursor", "mcp.json"), CURSOR);
  writeFileSync(path.join(home, ".gemini", "config", "mcp_config.json"), GEMINI);
  writeFileSync(path.join(home, ".gemini", "settings.json"), GEMINI_SETTINGS);
  return { root, home, project };
}

describe("wrap", () => {
  it("finds client configs globally and in the project, and plans each server", () => {
    const { home, project } = setup();
    const plans = knownLocations({ home, cwd: project, platform: "linux", env: {} })
      .map((l) => planConfig(l))
      .filter((p) => p.error !== "not found");
    expect(plans.map((p) => [p.client, p.label])).toEqual([
      ["vscode", "VS Code (this project)"],
      ["cursor", "Cursor (all projects)"],
      ["gemini", "Gemini CLI (all projects)"],
      ["gemini", "Gemini"],
    ]);
    expect(plans[3]!.servers).toEqual([{ name: "notes", state: "wrap", command: "uvx", args: ["mcp-notes"] }]);
    expect(plans[0]!.servers.map((s) => [s.name, s.state, s.reason ?? null])).toEqual([
      ["github", "wrap", null],
      ["docs", "skip", "HTTP servers aren't supported yet"],
      ["local", "wrap", null],
    ]);
  });

  it("wraps only command and args, keeps comments, and unwraps back", () => {
    const { project } = setup();
    const file = path.join(project, ".vscode", "mcp.json");
    const location = locationForFile(file);
    expect(location).toMatchObject({ client: "vscode", key: "servers" });

    expect(applyPlan(planConfig(location), "wrap")).toEqual(["github", "local"]);
    const wrapped = readFileSync(file, "utf8");
    expect(wrapped).toContain("// Servers for this repo");
    expect(wrapped).toContain("/* docs search, remote */");
    const json = parse(wrapped);
    expect(json.servers.github).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@mokalabs/proxy", "--client", "vscode", "--name", "github", "--", "npx", "-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "${input:token}" },
    });
    expect(json.servers.docs).toEqual({ type: "http", url: "https://example.com/mcp" });
    expect(isWrapped(json.servers.local)).toBe(true);
    expect(readFileSync(`${file}.moka-backup`, "utf8")).toBe(VSCODE);

    // Wrapping again changes nothing.
    expect(applyPlan(planConfig(location), "wrap")).toEqual([]);

    expect(applyPlan(planConfig(location), "unwrap")).toEqual(["github", "local"]);
    const restored = readFileSync(file, "utf8");
    expect(parse(restored)).toEqual(parse(VSCODE));
    expect(restored).toContain("// Servers for this repo");
  });

  it("wraps Gemini CLI servers and leaves its other settings alone", () => {
    const { home } = setup();
    const file = path.join(home, ".gemini", "settings.json");
    const location = locationForFile(file);
    expect(location).toMatchObject({ client: "gemini", key: "mcpServers" });
    expect(applyPlan(planConfig(location), "wrap")).toEqual(["git"]);
    const json = parse(readFileSync(file, "utf8"));
    expect(json.theme).toBe("Dracula");
    expect(json.mcpServers.git).toEqual({
      command: "npx",
      args: ["-y", "@mokalabs/proxy", "--client", "gemini", "--name", "git", "--", "uvx", "mcp-server-git"],
      timeout: 30000,
    });
  });

  it("wraps from the command line with --yes, and --only picks servers", () => {
    const { home, project } = setup();
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), MOKA_HOME: path.join(home, ".moka") };
    const dry = spawnSync(process.execPath, [cli, "wrap", "--dry-run"], { cwd: project, env, encoding: "utf8" });
    expect(dry.stdout).toMatch(/VS Code \(this project\)/);
    expect(dry.stdout).toMatch(/Cursor \(all projects\)/);
    expect(dry.stdout).toMatch(/Gemini CLI \(all projects\)/);
    expect(dry.stdout).toMatch(/Wrap 5 servers in 4 files\? .*Dry run: nothing changed/);
    expect(isWrapped(parse(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.filesystem)).toBe(false);

    const run = spawnSync(process.execPath, [cli, "wrap", "--only", "filesystem", "--yes"], { cwd: project, env, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/wrapped filesystem in .*\.cursor/);
    expect(isWrapped(parse(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.filesystem)).toBe(true);
    expect(isWrapped(parse(readFileSync(path.join(project, ".vscode", "mcp.json"), "utf8")).servers.github)).toBe(false);

    const status = spawnSync(process.execPath, [cli, "status"], { cwd: project, env, encoding: "utf8" });
    expect(status.stdout).toMatch(/Cursor \(all projects\)\s+wrapped: filesystem/);

    // --local points the config at this build of the proxy instead of npx, and unwrap still recognises it.
    const local = spawnSync(process.execPath, [cli, "wrap", "--only", "github", "--local", "--yes"], { cwd: project, env, encoding: "utf8" });
    expect(local.status).toBe(0);
    const github = parse(readFileSync(path.join(project, ".vscode", "mcp.json"), "utf8")).servers.github;
    expect(github.command).toBe(process.execPath);
    expect(github.args.slice(0, 6)).toEqual([cli, "--client", "vscode", "--name", "github", "--"]);
    expect(isWrapped(github)).toBe(true);

    // Without a terminal, it never changes files without --yes.
    const unconfirmed = spawnSync(process.execPath, [cli, "unwrap"], { cwd: project, env, encoding: "utf8", input: "" });
    expect(unconfirmed.status).toBe(1);
    expect(unconfirmed.stdout).toMatch(/Run again with --yes/);
    expect(existsSync(path.join(home, ".cursor", "mcp.json.moka-backup"))).toBe(true);
  });
});
