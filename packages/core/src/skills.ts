import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SkillConfig } from "./config.js";

/**
 * Agent Skills: a folder with a SKILL.md (YAML frontmatter + markdown body)
 * plus optional reference files. Moka uses progressive disclosure, same as
 * Claude: the model sees each skill's name + description up front, and loads
 * the full body (and extra files) on demand through built-in tools.
 */
export interface LoadedSkill {
  id: string;
  name: string;
  description: string;
  body: string;
  /** Absolute folder path for path-based skills. */
  dir?: string;
  /** Files in the skill folder, relative to `dir`. */
  files: string[];
  metadata: Record<string, string>;
  error?: string;
}

export function parseFrontmatter(source: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) return { data: {}, body: source };
  const data: Record<string, string> = {};
  const lines = match[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
      value = block.join(value.startsWith("|") ? "\n" : " ");
    } else if (/^(['"]).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    data[kv[1]!] = value;
  }
  return { data, body: match[2]! };
}

const MAX_FILES = 200;
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv"]);

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return out.sort();
}

export async function loadSkill(config: SkillConfig, baseDir = process.cwd()): Promise<LoadedSkill> {
  const fallbackName = config.name ?? config.id;
  try {
    let source: string;
    let dir: string | undefined;
    if (config.path) {
      const resolved = path.resolve(baseDir, expandHome(config.path));
      const info = await stat(resolved);
      const file = info.isDirectory() ? path.join(resolved, "SKILL.md") : resolved;
      dir = path.dirname(file);
      source = await readFile(file, "utf8");
    } else if (config.content != null) {
      source = config.content;
    } else {
      throw new Error("Skill needs either a path or inline content.");
    }
    const { data, body } = parseFrontmatter(source);
    return {
      id: config.id,
      name: config.name || data.name || fallbackName,
      description: config.description || data.description || firstLine(body),
      body: body.trim(),
      dir,
      files: dir ? (await listFiles(dir)).filter((f) => f !== "SKILL.md") : [],
      metadata: data,
    };
  } catch (error) {
    return {
      id: config.id,
      name: fallbackName,
      description: config.description ?? "",
      body: "",
      files: [],
      metadata: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Discover skills under a folder: every sub-folder containing a SKILL.md. */
export async function discoverSkills(root: string): Promise<string[]> {
  const resolved = path.resolve(expandHome(root));
  const found: string[] = [];
  try {
    await stat(path.join(resolved, "SKILL.md"));
    return [resolved];
  } catch {
    // not a skill itself, look one level down
  }
  for (const entry of await readdir(resolved, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await stat(path.join(resolved, entry.name, "SKILL.md"));
      found.push(path.join(resolved, entry.name));
    } catch {
      // skip
    }
  }
  return found.sort();
}

/** Read a file inside a skill folder, refusing paths that escape it. */
export async function readSkillFile(skill: LoadedSkill, relative: string, maxBytes = 200_000): Promise<string> {
  if (!skill.dir) throw new Error(`Skill "${skill.name}" is inline and has no files.`);
  const target = path.resolve(skill.dir, relative);
  if (target !== skill.dir && !target.startsWith(skill.dir + path.sep)) {
    throw new Error("Path escapes the skill folder.");
  }
  const content = await readFile(target, "utf8");
  return content.length > maxBytes ? `${content.slice(0, maxBytes)}\n\n[truncated at ${maxBytes} bytes]` : content;
}

export function skillsSystemPrompt(skills: LoadedSkill[]): string {
  const usable = skills.filter((s) => !s.error);
  if (usable.length === 0) return "";
  const list = usable.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
  return [
    "## Skills",
    "You have access to the following skills. When a task matches a skill's description, call `load_skill` with its name BEFORE answering, then follow its instructions. Use `read_skill_file` for any files the skill references.",
    list,
  ].join("\n\n");
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find(Boolean)
      ?.slice(0, 200) ?? ""
  );
}

export function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", p.slice(1));
  return p;
}
