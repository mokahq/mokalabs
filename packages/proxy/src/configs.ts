import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

/** Where an MCP client keeps its servers, and under which key. */
export interface ConfigLocation {
  /** Short label used in the inspector: vscode, cursor, claude-desktop, claude-code, windsurf, gemini, custom. */
  client: string;
  /** Human name, e.g. "VS Code (this project)". */
  label: string;
  path: string;
  /** VS Code uses "servers"; most others "mcpServers". */
  key: "servers" | "mcpServers";
}

export interface FoundServer {
  name: string;
  /** wrap: will be wrapped. wrapped: already is. skip: can't be wrapped (reason). */
  state: "wrap" | "wrapped" | "skip";
  reason?: string;
  command?: string;
  args?: string[];
  /** HTTP servers: what the entry says, to wrap it (and to put back on unwrap). */
  http?: HttpEntry;
  /** A wrapped entry's environment (an HTTP server's headers are kept there). */
  env?: Record<string, string>;
}

/** An HTTP server entry, in whichever shape the client uses. */
export interface HttpEntry {
  url: string;
  transport: "http" | "sse";
  /** Which key held the URL: url (most clients), httpUrl (Gemini, Streamable HTTP), serverUrl (Windsurf). */
  urlKey: "url" | "httpUrl" | "serverUrl";
  /** The entry's "type", if it had one (VS Code, Claude Code). */
  type?: string;
  headers?: Record<string, string>;
}

/** Wrapped HTTP servers keep their headers in the environment, one per variable, not in args (which other users can see). */
export const HEADER_ENV_PREFIX = "MOKA_PROXY_HEADER_";

export interface ConfigPlan extends ConfigLocation {
  servers: FoundServer[];
  /** The file couldn't be read as JSON. */
  error?: string;
}

export const PROXY_PACKAGE = "@mokalabs/proxy";

/**
 * The client configs `wrap` looks at: every client's global config, plus the
 * project configs in `cwd`. Never searches the disk beyond these.
 */
export function knownLocations(options: { home?: string; cwd?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): ConfigLocation[] {
  const home = options.home ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  // Per-user app data: VS Code's and Claude Desktop's settings live here.
  const appData =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : platform === "win32"
        ? (env.APPDATA ?? path.join(home, "AppData", "Roaming"))
        : (env.XDG_CONFIG_HOME ?? path.join(home, ".config"));
  return [
    { client: "vscode", label: "VS Code (all projects)", path: path.join(appData, "Code", "User", "mcp.json"), key: "servers" },
    { client: "vscode", label: "VS Code (this project)", path: path.join(cwd, ".vscode", "mcp.json"), key: "servers" },
    { client: "cursor", label: "Cursor (all projects)", path: path.join(home, ".cursor", "mcp.json"), key: "mcpServers" },
    { client: "cursor", label: "Cursor (this project)", path: path.join(cwd, ".cursor", "mcp.json"), key: "mcpServers" },
    { client: "claude-desktop", label: "Claude Desktop", path: path.join(appData, "Claude", "claude_desktop_config.json"), key: "mcpServers" },
    { client: "claude-code", label: "Claude Code (this project)", path: path.join(cwd, ".mcp.json"), key: "mcpServers" },
    { client: "windsurf", label: "Windsurf", path: path.join(home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" },
    // Gemini CLI keeps servers in its settings (other settings in the file are left alone).
    { client: "gemini", label: "Gemini CLI (all projects)", path: path.join(home, ".gemini", "settings.json"), key: "mcpServers" },
    { client: "gemini", label: "Gemini CLI (this project)", path: path.join(cwd, ".gemini", "settings.json"), key: "mcpServers" },
    { client: "gemini", label: "Gemini", path: path.join(home, ".gemini", "config", "mcp_config.json"), key: "mcpServers" },
  ];
}

/** A config file named on the command line: which client it belongs to, and its key. */
export function locationForFile(file: string, cwd = process.cwd()): ConfigLocation {
  const full = path.resolve(cwd, file);
  const lower = full.toLowerCase().replace(/\\/g, "/");
  const client = lower.includes("/.vscode/") || lower.includes("/code/user/")
    ? "vscode"
    : lower.includes("/.cursor/")
      ? "cursor"
      : lower.includes("claude_desktop_config")
        ? "claude-desktop"
        : lower.includes("windsurf")
          ? "windsurf"
          : lower.includes("/.gemini/")
            ? "gemini"
            : "custom";
  let key: ConfigLocation["key"] = client === "vscode" ? "servers" : "mcpServers";
  try {
    const json = parse(readFileSync(full, "utf8"));
    if (json?.servers && typeof json.servers === "object") key = "servers";
    else if (json?.mcpServers && typeof json.mcpServers === "object") key = "mcpServers";
  } catch {
    // reported when it's planned
  }
  return { client, label: file, path: full, key };
}

/** What wrap would do to one config file, without changing it. */
export function planConfig(location: ConfigLocation, only?: string[]): ConfigPlan {
  let text: string;
  try {
    text = readFileSync(location.path, "utf8");
  } catch (error: any) {
    return { ...location, servers: [], error: error?.code === "ENOENT" ? "not found" : error?.message };
  }
  const errors: ParseError[] = [];
  const json = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !json || typeof json !== "object") return { ...location, servers: [], error: "not valid JSON" };
  const entries = Object.entries((json[location.key] ?? {}) as Record<string, any>);
  const servers = entries
    .filter(([name]) => !only?.length || only.includes(name))
    .map(([name, entry]): FoundServer => {
      if (!entry || typeof entry !== "object") return { name, state: "skip", reason: "not a server entry" };
      if (isWrapped(entry)) return { name, state: "wrapped", command: entry.command, args: entry.args, ...(entry.env ? { env: entry.env } : {}) };
      const http = httpEntry(entry, location.client);
      if (http) return { name, state: "wrap", http };
      if (entry.type && entry.type !== "stdio") return { name, state: "skip", reason: `unknown server type "${entry.type}"` };
      if (typeof entry.command !== "string") return { name, state: "skip", reason: "no command" };
      return { name, state: "wrap", command: entry.command, args: Array.isArray(entry.args) ? entry.args : [] };
    });
  return { ...location, servers };
}

/** The URL, transport and headers of an HTTP server entry; undefined for stdio servers. */
export function httpEntry(entry: Record<string, any>, client?: string): HttpEntry | undefined {
  const urlKey = (["httpUrl", "serverUrl", "url"] as const).find((k) => typeof entry[k] === "string" && entry[k]);
  if (!urlKey || (typeof entry.command === "string" && entry.command)) return undefined;
  const type = typeof entry.type === "string" ? entry.type : undefined;
  // Gemini: httpUrl is Streamable HTTP, url is SSE. Elsewhere "sse" says so; the rest is Streamable HTTP.
  const transport = type === "sse" || (urlKey === "url" && (client === "gemini" || /\/sse\/?$/.test(entry.url))) ? "sse" : "http";
  const headers = entry.headers && typeof entry.headers === "object" ? Object.fromEntries(Object.entries(entry.headers).map(([k, v]) => [k, String(v)])) : undefined;
  return { url: entry[urlKey], transport, urlKey, ...(type ? { type } : {}), ...(headers && Object.keys(headers).length ? { headers } : {}) };
}

/** Whether a server entry already runs through the proxy. */
export function isWrapped(entry: { command?: unknown; args?: unknown }): boolean {
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const usesProxy =
    args.some((a) => a === PROXY_PACKAGE || a.startsWith(`${PROXY_PACKAGE}@`) || /[\\/]proxy[\\/]dist[\\/]cli\.js$/.test(a)) ||
    /moka-proxy(\.cmd)?$/.test(String(entry.command ?? ""));
  return usesProxy && (args.includes("--") || args.includes("--url"));
}

/** An HTTP server run through the proxy: a stdio entry that bridges to the URL. */
export function wrappedHttpEntry(client: string, name: string, http: HttpEntry, local?: { node: string; script: string }): { command: string; args: string[]; env?: Record<string, string> } {
  const proxyArgs = ["--client", client, "--name", name, "--url", http.url, "--transport", http.transport, "--url-key", http.urlKey, ...(http.type ? ["--type", http.type] : [])];
  const env = http.headers ? Object.fromEntries(Object.entries(http.headers).map(([k, v], i) => [`${HEADER_ENV_PREFIX}${i + 1}`, `${k}: ${v}`])) : undefined;
  const run = local ? { command: local.node, args: [local.script, ...proxyArgs] } : { command: "npx", args: ["-y", PROXY_PACKAGE, ...proxyArgs] };
  return { ...run, ...(env ? { env } : {}) };
}

/** The original HTTP entry of a wrapped one (from its args and env). */
export function unwrappedHttpEntry(args: string[], env: Record<string, string> = {}): HttpEntry | undefined {
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const url = value("--url");
  if (!url) return undefined;
  const headers = headersFromEnv(env);
  const type = value("--type");
  return {
    url,
    transport: value("--transport") === "sse" ? "sse" : "http",
    urlKey: (value("--url-key") as HttpEntry["urlKey"]) ?? "url",
    ...(type ? { type } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

/** Headers kept in MOKA_PROXY_HEADER_n variables ("Name: value"), in order. */
export function headersFromEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([k, v]) => k.startsWith(HEADER_ENV_PREFIX) && typeof v === "string" && v.includes(":"))
      .sort(([a], [b]) => Number(a.slice(HEADER_ENV_PREFIX.length)) - Number(b.slice(HEADER_ENV_PREFIX.length)))
      .map(([, v]) => [v!.slice(0, v!.indexOf(":")).trim(), v!.slice(v!.indexOf(":") + 1).trim()]),
  );
}

/**
 * The server entry's command and args, run through the proxy: `npx -y @mokalabs/proxy …`,
 * or with `local` (a proxy script path) `node <script> …`, e.g. a build from source.
 */
export function wrappedCommand(client: string, name: string, command: string, args: string[], local?: { node: string; script: string }): { command: string; args: string[] } {
  const proxyArgs = ["--client", client, "--name", name, "--", command, ...args];
  return local ? { command: local.node, args: [local.script, ...proxyArgs] } : { command: "npx", args: ["-y", PROXY_PACKAGE, ...proxyArgs] };
}

/** The original command and args of a wrapped entry. */
export function unwrappedCommand(args: string[]): { command: string; args: string[] } | undefined {
  const sep = args.indexOf("--");
  if (sep < 0 || sep + 1 >= args.length) return undefined;
  return { command: args[sep + 1]!, args: args.slice(sep + 2) };
}

/**
 * Wrap (or unwrap) the planned servers in place. Only the `command` and `args`
 * of those entries change; comments and formatting elsewhere are kept. The
 * first time a file is changed, a copy is saved next to it (`.moka-backup`).
 */
export function applyPlan(plan: ConfigPlan, mode: "wrap" | "unwrap", local?: { node: string; script: string }): string[] {
  const targets = plan.servers.filter((s) => (mode === "wrap" ? s.state === "wrap" : s.state === "wrapped"));
  if (!targets.length) return [];
  let text = readFileSync(plan.path, "utf8");
  const formattingOptions = detectFormatting(text);
  const changed: string[] = [];
  const set = (name: string, field: string, value: unknown) => {
    text = applyEdits(text, modify(text, [plan.key, name, field], value, { formattingOptions }));
  };
  for (const server of targets) {
    // HTTP servers: the entry becomes a stdio entry that runs the bridge, and back.
    const http = mode === "wrap" ? server.http : unwrappedHttpEntry(server.args ?? [], server.env);
    if (http) {
      if (mode === "wrap") {
        const next = wrappedHttpEntry(plan.client, server.name, http, local);
        for (const key of ["url", "httpUrl", "serverUrl", "headers"]) set(server.name, key, undefined);
        if (http.type) set(server.name, "type", "stdio");
        set(server.name, "command", next.command);
        set(server.name, "args", next.args);
        if (next.env) set(server.name, "env", next.env);
      } else {
        const rest = Object.fromEntries(Object.entries(server.env ?? {}).filter(([k]) => !k.startsWith(HEADER_ENV_PREFIX)));
        for (const key of ["command", "args"]) set(server.name, key, undefined);
        set(server.name, "env", Object.keys(rest).length ? rest : undefined);
        if (http.type) set(server.name, "type", http.type);
        set(server.name, http.urlKey, http.url);
        if (http.headers) set(server.name, "headers", http.headers);
      }
      changed.push(server.name);
      continue;
    }
    const next =
      mode === "wrap"
        ? wrappedCommand(plan.client, server.name, server.command!, server.args ?? [], local)
        : unwrappedCommand(server.args ?? []);
    if (!next) continue;
    for (const field of ["command", "args"] as const) {
      const value = field === "args" && next.args.length === 0 ? undefined : next[field];
      set(server.name, field, value);
    }
    changed.push(server.name);
  }
  if (changed.length) {
    const backup = `${plan.path}.moka-backup`;
    if (mode === "wrap" && !existsSync(backup)) copyFileSync(plan.path, backup);
    writeFileSync(plan.path, text);
  }
  return changed;
}

function detectFormatting(text: string) {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ";
  return indent.includes("\t") ? { insertSpaces: false, tabSize: 1 } : { insertSpaces: true, tabSize: indent.length };
}
