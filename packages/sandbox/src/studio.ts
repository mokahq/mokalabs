import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import nodeModule, { createRequire, register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { McpServerConfig, MokaEngine } from "@mokalabs/core";

/**
 * Server Studio: MCP servers written in Moka. A Studio server is a folder with
 * a `server.ts` (a normal MCP server using `@modelcontextprotocol/server` and
 * `zod`), run as `command: "moka:studio", args: ["<folder>"]`. Moka runs it
 * with Node's TypeScript type stripping and supplies the SDK and zod itself,
 * so the folder needs no `npm install`; saving a file restarts it.
 */

export const STUDIO_COMMAND = "moka:studio";
export const ENTRY_FILES = ["server.ts", "server.mts", "server.js", "server.mjs"];
/** Files Studio shows and edits. */
const EDITABLE = /\.(ts|mts|js|mjs|json|md|txt|html|css)$/i;
const MAX_FILE = 1_000_000;

export function studioRoot(home: string): string {
  return path.join(home, "studio");
}

/**
 * Node flags that let it run `.ts` files, or undefined when this Node can't
 * (before 22.6). Type stripping is on by default from 22.18 and 23.6.
 */
export function typeStrippingFlags(versions = process.versions.node, features: { typescript?: unknown } = process.features as { typescript?: unknown }): string[] | undefined {
  if (features.typescript) return ["--disable-warning=ExperimentalWarning"];
  const [major = 0, minor = 0] = versions.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 6)) return ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
  return undefined;
}

/** The modules Moka supplies, as file URLs: its bundled copies (published package), or its own dependencies (development). */
function supplied(): Record<string, string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = (name: string) => path.join(here, "studio", `${name}.js`);
  if (existsSync(bundled("sdk-server"))) {
    const server = pathToFileURL(bundled("sdk-server")).href;
    const zod = pathToFileURL(bundled("zod")).href;
    return { "@modelcontextprotocol/server": server, "@modelcontextprotocol/server/stdio": pathToFileURL(bundled("sdk-server-stdio")).href, zod, "zod/v4": zod };
  }
  const require = createRequire(import.meta.url);
  const url = (id: string) => pathToFileURL(require.resolve(id)).href;
  return {
    "@modelcontextprotocol/server": url("@modelcontextprotocol/server"),
    "@modelcontextprotocol/server/stdio": url("@modelcontextprotocol/server/stdio"),
    zod: url("zod"),
    "zod/v4": url("zod/v4"),
  };
}

// Resolve hook: the folder's own node_modules first, then Moka's copies of the SDK and zod.
const HOOKS = `
let map = {};
export async function initialize(data) { map = data.map; }
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (map[specifier]) return { url: map[specifier], shortCircuit: true };
    throw error;
  }
}`;

/** `moka studio-run <folder>`: run a Studio server on stdio (Moka starts this for `moka:studio`). */
export async function runStudioServer(dir: string): Promise<void> {
  const folder = path.resolve(dir);
  const entry = ENTRY_FILES.map((f) => path.join(folder, f)).find((f) => existsSync(f));
  if (!entry) throw new Error(`No server.ts in ${folder}.`);
  if (/\.m?ts$/.test(entry) && !typeStrippingFlags()) throw new Error(`Node ${process.versions.node} can't run TypeScript. Use Node 22.18 or later, or rename server.ts to server.mjs and write plain JavaScript.`);
  const map = supplied();
  // Synchronous hooks (Node 22.15+) cover require() too. Older Nodes get an async resolve hook for
  // import, plus a CommonJS fallback for require() (a loader like tsx may compile server.ts to CommonJS).
  const registerHooks = process.env.MOKA_STUDIO_ASYNC_HOOKS === "1" ? undefined : (nodeModule as { registerHooks?: (hooks: { resolve: (specifier: string, context: unknown, next: (s: string, c: unknown) => { url: string }) => { url: string; shortCircuit?: boolean } }) => void }).registerHooks;
  if (!registerHooks) {
    const cjs = nodeModule as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
    const original = cjs._resolveFilename;
    cjs._resolveFilename = function (request: string, ...rest: unknown[]) {
      try {
        return original.call(this, request, ...rest);
      } catch (error) {
        if (map[request]) return fileURLToPath(map[request]);
        throw error;
      }
    };
  }
  if (registerHooks) {
    registerHooks({
      resolve(specifier, context, next) {
        try {
          return next(specifier, context);
        } catch (error) {
          if (map[specifier]) return { url: map[specifier], shortCircuit: true };
          throw error;
        }
      },
    });
  } else register(`data:text/javascript,${encodeURIComponent(HOOKS)}`, { data: { map } });
  await import(pathToFileURL(entry).href);
}

export interface StudioFile {
  path: string;
  size: number;
}

/** The files Studio shows for a folder (no node_modules, no dot-folders). */
export function listFiles(dir: string): StudioFile[] {
  const out: StudioFile[] = [];
  const walk = (at: string, depth: number) => {
    if (depth > 3) return;
    for (const name of readdirSync(at)) {
      if (name.startsWith(".") || name === "node_modules" || name === "dist") continue;
      const full = path.join(at, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full, depth + 1);
      else if (EDITABLE.test(name)) out.push({ path: path.relative(dir, full).split(path.sep).join("/"), size: info.size });
    }
  };
  if (existsSync(dir)) walk(dir, 0);
  return out.sort((a, b) => (ENTRY_FILES.includes(a.path) ? -1 : ENTRY_FILES.includes(b.path) ? 1 : a.path.localeCompare(b.path)));
}

/** A file path inside a Studio folder, or an error for anything that would leave it. */
export function safePath(dir: string, file: string): string {
  const full = path.resolve(dir, file);
  const rel = path.relative(path.resolve(dir), full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).some((p) => p.startsWith(".") || p === "node_modules")) throw new Error(`Not a file in this server's folder: ${file}`);
  if (!EDITABLE.test(full)) throw new Error("Studio edits .ts, .js, .json, .md, .html and .css files.");
  return full;
}

export function readFile(dir: string, file: string): string {
  const full = safePath(dir, file);
  if (statSync(full).size > MAX_FILE) throw new Error("This file is too big to edit in Studio.");
  return readFileSync(full, "utf8");
}

export function writeFile(dir: string, file: string, content: string): void {
  if (content.length > MAX_FILE) throw new Error("This file is too big to save from Studio.");
  const full = safePath(dir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export type TemplateId = "blank" | "http-api" | "files";

export const TEMPLATES: Record<TemplateId, { label: string; description: string; files: (name: string) => Record<string, string> }> = {
  blank: {
    label: "Blank",
    description: "One tool, ready to change.",
    files: (name) => ({
      "server.ts": `import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

// An MCP server, written in Moka's Studio. Save (⌘S) and it reloads into chat, Tools and Tests.
// console.error() goes to the server's log in the inspector (stdout is the MCP connection).

function createServer() {
  const server = new McpServer({ name: ${JSON.stringify(name)}, version: "0.1.0" });

  server.registerTool(
    "greet",
    {
      title: "Greet someone",
      // The description is what the model reads to decide when to call the tool.
      description: "Say hello to a person by name. Use it when the user asks to greet someone.",
      inputSchema: z.object({ name: z.string().describe("The person's first name") }),
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => ({ content: [{ type: "text", text: \`Hello, \${name}!\` }] }),
  );

  return server;
}

serveStdio(() => createServer());
`,
    }),
  },
  "http-api": {
    label: "HTTP API wrapper",
    description: "A tool that calls a JSON API, with errors the model can act on.",
    files: (name) => ({
      "server.ts": `import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

// Wraps a JSON API as a tool. Change BASE_URL and the tool to your API.
// Secrets: read them from process.env (set "env" on the server in Settings → MCP), never hard-code them.
const BASE_URL = "https://api.github.com";

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": ${JSON.stringify(name)} } });
  if (!res.ok) throw new Error(\`\${res.status} \${res.statusText} from \${url}\`);
  return res.json();
}

function createServer() {
  const server = new McpServer({ name: ${JSON.stringify(name)}, version: "0.1.0" });

  server.registerTool(
    "get_repository",
    {
      title: "Get a GitHub repository",
      description: "Look up a public GitHub repository: description, stars, open issues and default branch. Use it when the user names a repository as owner/name.",
      inputSchema: z.object({
        owner: z.string().describe("Owner (user or organisation), e.g. modelcontextprotocol"),
        repo: z.string().describe("Repository name, e.g. typescript-sdk"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ owner, repo }) => {
      try {
        const data = (await getJson(\`\${BASE_URL}/repos/\${encodeURIComponent(owner)}/\${encodeURIComponent(repo)}\`)) as Record<string, unknown>;
        const summary = { name: data.full_name, description: data.description, stars: data.stargazers_count, openIssues: data.open_issues_count, defaultBranch: data.default_branch };
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }], structuredContent: summary };
      } catch (error) {
        // isError: the model sees what went wrong and can tell the user or try again.
        return { content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }], isError: true };
      }
    },
  );

  return server;
}

serveStdio(() => createServer());
`,
    }),
  },
  files: {
    label: "Read a folder",
    description: "List and read text files in one folder, and nothing outside it.",
    files: (name) => ({
      "server.ts": `import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

// Gives the model read-only access to one folder. Set NOTES_DIR on the server (Settings → MCP → Environment).
const ROOT = path.resolve(process.env.NOTES_DIR ?? process.cwd());

/** A path inside ROOT, or an error: the model can't read anything else. */
function inside(file: string): string {
  const full = path.resolve(ROOT, file);
  if (path.relative(ROOT, full).startsWith("..")) throw new Error(\`\${file} is outside the folder\`);
  return full;
}

function createServer() {
  const server = new McpServer({ name: ${JSON.stringify(name)}, version: "0.1.0" });

  server.registerTool(
    "list_files",
    {
      title: "List files",
      description: "List the files in the notes folder (or a subfolder of it).",
      inputSchema: z.object({ folder: z.string().default(".").describe("Subfolder, relative to the notes folder") }),
      annotations: { readOnlyHint: true },
    },
    async ({ folder }) => {
      const entries = await readdir(inside(folder), { withFileTypes: true });
      const lines = entries.filter((e) => !e.name.startsWith(".")).map((e) => (e.isDirectory() ? \`\${e.name}/\` : e.name));
      return { content: [{ type: "text", text: lines.join("\\n") || "(empty)" }] };
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a file",
      description: "Read a text file from the notes folder. Use list_files first to find its name.",
      inputSchema: z.object({ file: z.string().describe("Path relative to the notes folder, e.g. ideas.md") }),
      annotations: { readOnlyHint: true },
    },
    async ({ file }) => {
      const full = inside(file);
      if ((await stat(full)).size > 200_000) return { content: [{ type: "text", text: "This file is too big to read here." }], isError: true };
      return { content: [{ type: "text", text: await readFile(full, "utf8") }] };
    },
  );

  return server;
}

serveStdio(() => createServer());
`,
    }),
  },
};

/** Files added on export, so the folder works as a project of its own. */
export function exportFiles(name: string, files: Record<string, string>): Record<string, string> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mcp-server";
  const entry = Object.keys(files).find((f) => ENTRY_FILES.includes(f)) ?? "server.ts";
  const ts = entry.endsWith("ts");
  return {
    ...files,
    ...(files["package.json"]
      ? {}
      : {
          "package.json": `${JSON.stringify(
            {
              name: slug,
              version: "0.1.0",
              type: "module",
              bin: { [slug]: ts ? "dist/server.js" : entry },
              files: ["dist"],
              scripts: ts ? { build: "tsc", start: `node ${entry}` } : { start: `node ${entry}` },
              engines: { node: ts ? ">=22.18" : ">=20" },
              dependencies: { "@modelcontextprotocol/server": "^2.2.0", zod: "^4.6.0" },
              ...(ts ? { devDependencies: { typescript: "^5.9.0", "@types/node": "^24.0.0" } } : {}),
            },
            null,
            2,
          )}\n`,
        }),
    ...(ts && !files["tsconfig.json"]
      ? { "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true, outDir: "dist", rewriteRelativeImportExtensions: true, erasableSyntaxOnly: true }, include: [entry] }, null, 2)}\n` }
      : {}),
    ...(files["README.md"]
      ? {}
      : {
          "README.md": `# ${name}\n\nAn MCP server written in [Moka](https://mokalabs.dev) Studio.\n\n## Run it\n\n\`\`\`bash\nnpm install\nnode ${entry}${ts ? "   # Node 22.18+ runs TypeScript directly" : ""}\n\`\`\`\n\n## Use it from an MCP client\n\n\`\`\`json\n{\n  "mcpServers": {\n    "${slug}": { "command": "node", "args": ["/path/to/${slug}/${entry}"] }\n  }\n}\n\`\`\`\n${ts ? "\nTo publish to npm, `npm run build` compiles to `dist/`.\n" : ""}`,
        }),
  };
}

/** A minimal .zip (stored, no compression): enough for a few text files, with no dependency. */
export function zip(files: Record<string, string>, folder: string): Buffer {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc32 = (buf: Buffer) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const file = Buffer.from(`${folder}/${name}`, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(file.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(file.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, file, data);
    centrals.push(central, file);
    offset += local.length + file.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** The folder of a Studio server config. */
export function studioDir(server: Pick<McpServerConfig, "command" | "args">): string | undefined {
  return server.command === STUDIO_COMMAND && server.args?.[0] ? path.resolve(server.args[0]) : undefined;
}

/**
 * Restarts Studio servers when their files change, so tools update in chat,
 * Tools and Tests as you save. Follows the config: servers added or removed
 * are picked up within a couple of seconds.
 */
export class StudioWatcher {
  private watchers = new Map<string, FSWatcher>();
  private timers = new Map<string, NodeJS.Timeout>();
  private scan: NodeJS.Timeout | undefined;

  constructor(private readonly engine: MokaEngine) {}

  start(): void {
    this.sync();
    this.scan = setInterval(() => this.sync(), 2000);
    this.scan.unref?.();
  }

  close(): void {
    if (this.scan) clearInterval(this.scan);
    for (const w of this.watchers.values()) w.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.watchers.clear();
  }

  private sync(): void {
    const servers = this.engine.getConfig().mcpServers.filter((s) => studioDir(s));
    const wanted = new Map(servers.map((s) => [s.id, studioDir(s)!]));
    for (const [id, w] of this.watchers) {
      if (wanted.get(id) !== (w as FSWatcher & { dir?: string }).dir) {
        w.close();
        this.watchers.delete(id);
      }
    }
    for (const [id, dir] of wanted) {
      if (this.watchers.has(id) || !existsSync(dir)) continue;
      try {
        const watcher = watch(dir, { recursive: true }, (_event, file) => {
          const name = String(file ?? "");
          if (!name || name.split(/[\\/]/).some((p) => p.startsWith(".") || p === "node_modules" || p === "dist")) return;
          this.reload(id, name);
        }) as FSWatcher & { dir?: string };
        watcher.dir = dir;
        watcher.on("error", () => this.watchers.delete(id));
        this.watchers.set(id, watcher);
      } catch {
        // can't watch (e.g. too many files): reload by hand with Reconnect
      }
    }
  }

  /** A file was saved from Studio: reload its server now (edits from other editors arrive through the watcher). */
  saved(dir: string, file: string): void {
    const server = this.engine.getConfig().mcpServers.find((s) => studioDir(s) === path.resolve(dir));
    if (server) this.reload(server.id, file);
    this.sync();
  }

  private reload(id: string, file: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        const server = this.engine.getConfig().mcpServers.find((s) => s.id === id);
        if (!server) return;
        this.engine.bus.emit({ kind: "log", serverId: id, title: `Studio: ${server.name} reloaded (${file} changed)` });
        void this.engine.mcp.reconnect(server).catch(() => {});
      }, 250),
    );
  }
}
