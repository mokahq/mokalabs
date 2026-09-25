import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyConfig, parseConfig, type MokaConfig } from "./config.js";

export function mokaHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MOKA_HOME ? path.resolve(env.MOKA_HOME) : path.join(os.homedir(), ".moka");
}

async function writeAtomic(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
}

/** JSON config persisted on disk (e.g. ./moka.json or ~/.moka/config.json). */
export class ConfigStore {
  constructor(readonly file: string) {}

  async load(): Promise<{ config: MokaConfig; existed: boolean }> {
    try {
      const raw = await readFile(this.file, "utf8");
      return { config: parseConfig(JSON.parse(raw)), existed: true };
    } catch (error: any) {
      if (error?.code === "ENOENT") return { config: emptyConfig(), existed: false };
      throw new Error(`Could not read ${this.file}: ${error?.message ?? error}`);
    }
  }

  async save(config: MokaConfig): Promise<MokaConfig> {
    const parsed = parseConfig(config);
    await writeAtomic(this.file, `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  }
}

export interface SessionSummary {
  id: string;
  title: string;
  workspaceId?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface StoredSession extends SessionSummary {
  /** Opaque UI payload (display messages + model messages). */
  data: unknown;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Chat sessions, one JSON file each. */
export class SessionStore {
  constructor(readonly dir: string) {}

  private file(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error("Invalid session id");
    return path.join(this.dir, `${id}.json`);
  }

  async list(): Promise<SessionSummary[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const sessions = await Promise.all(
      names.map(async (name) => {
        try {
          const { data: _data, ...summary } = JSON.parse(await readFile(path.join(this.dir, name), "utf8")) as StoredSession;
          return summary;
        } catch {
          return undefined;
        }
      }),
    );
    return sessions.filter((s): s is SessionSummary => !!s).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<StoredSession | undefined> {
    try {
      return JSON.parse(await readFile(this.file(id), "utf8"));
    } catch {
      return undefined;
    }
  }

  async put(session: StoredSession): Promise<void> {
    await writeAtomic(this.file(session.id), JSON.stringify(session));
  }

  async delete(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }
}
