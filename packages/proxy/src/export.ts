import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { SessionRecord } from "./session.js";
import { VERSION } from "./version.js";

/** Everything the proxy recorded for some sessions, in one JSON file. */
export interface ProxyExport {
  format: "moka-proxy-export";
  version: 1;
  exportedAt: string;
  proxyVersion: string;
  /** Whether secret-looking values were replaced with "<redacted>". */
  redacted: boolean;
  sessions: ExportedSession[];
}

export interface ExportedSession {
  id: string;
  /** --client label and --name, from the session's start record. */
  client?: string;
  name?: string;
  startedAt?: number;
  endedAt?: number;
  /** Every line of the session log, in order. */
  records: SessionRecord[];
}

export interface ExportOptions {
  /** Only these session ids. */
  ids?: string[];
  /** Only sessions of this --client label / --name. */
  client?: string;
  name?: string;
  /** Only sessions with activity at or after this time (ms). */
  since?: number;
  /** Replace secret-looking values (default true). */
  redact?: boolean;
}

/** Read the recorded sessions in `dir` into one export, newest session first. */
export function exportSessions(dir: string, options: ExportOptions = {}): ProxyExport {
  const redact = options.redact ?? true;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    // nothing recorded yet
  }
  const sessions: ExportedSession[] = [];
  for (const file of files) {
    const id = file.slice(0, -".jsonl".length);
    if (options.ids && !options.ids.includes(id)) continue;
    const full = path.join(dir, file);
    try {
      if (options.since && statSync(full).mtimeMs < options.since) continue;
    } catch {
      continue;
    }
    const records = readRecords(full);
    const start = records.find((r): r is Extract<SessionRecord, { type: "start" }> => r.type === "start");
    if (options.client && start?.client !== options.client) continue;
    if (options.name && start?.name !== options.name) continue;
    const exit = records.find((r) => r.type === "exit");
    sessions.push({
      id,
      client: start?.client,
      name: start?.name,
      startedAt: start?.t,
      endedAt: exit?.t,
      records: redact ? records.map(redactRecord) : records,
    });
  }
  sessions.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return { format: "moka-proxy-export", version: 1, exportedAt: new Date().toISOString(), proxyVersion: VERSION, redacted: redact, sessions };
}

/** A file name for an export, e.g. moka-proxy-vscode-github-2026-10-06T18-30-00.json */
export function exportFileName(parts: Array<string | undefined> = []): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const label = parts.filter(Boolean).map((p) => p!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).filter(Boolean);
  return `moka-proxy-${[...label, stamp].join("-")}.json`;
}

function readRecords(file: string): SessionRecord[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records: SessionRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // a torn last line while the proxy is still writing
    }
  }
  return records;
}

// --- redaction ---------------------------------------------------------------

const REDACTED = "<redacted>";
/** Keys whose values are secrets: api_key, GITHUB_TOKEN, accessToken, Authorization, password… */
const SECRET_KEY = /(^|_)(api_?key|apikey|token|secret|password|passwd|authorization|cookie|private_?key|access_?key|client_?secret|session_?id)$/;
/** Well-known credential shapes inside any string. */
const SECRET_VALUE =
  /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,})\b/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** Protocol fields that only look like secrets. */
const NOT_SECRET = new Set(["progress_token"]);

function isSecretKey(key: string): boolean {
  const snake = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
  return SECRET_KEY.test(snake) && !NOT_SECRET.has(snake);
}

function redactString(value: string): string {
  return value.replace(BEARER, (_, scheme) => `${scheme} ${REDACTED}`).replace(SECRET_VALUE, REDACTED);
}

function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && typeof value === "string" && value !== "" && isSecretKey(key)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, k)]));
  return value;
}

/** Command-line args: `--token abc`, `--api-key=abc`, `GITHUB_TOKEN=abc`, and known key shapes. */
export function redactArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = /^--?([A-Za-z][\w-]*)$/.exec(arg);
    if (flag && isSecretKey(flag[1]!) && i + 1 < args.length) {
      out.push(arg, REDACTED);
      i++;
      continue;
    }
    const pair = /^(--?)?([A-Za-z][\w-]*)=(.+)$/.exec(arg);
    if (pair && isSecretKey(pair[2]!)) {
      out.push(`${pair[1] ?? ""}${pair[2]}=${REDACTED}`);
      continue;
    }
    out.push(redactString(arg));
  }
  return out;
}

/** A record with secret-looking values replaced. Message structure, methods and ids are kept. */
export function redactRecord(record: SessionRecord): SessionRecord {
  switch (record.type) {
    case "start":
      return { ...record, command: redactString(record.command), args: redactArgs(record.args) };
    case "msg":
      return { ...record, msg: redactValue(record.msg) };
    case "raw":
    case "stderr":
      return { ...record, text: redactString(record.text) };
    case "error":
      return { ...record, message: redactString(record.message) };
    default:
      return record;
  }
}
