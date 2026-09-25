import { create } from "zustand";
import { api, subscribeEvents } from "./api";
import { runTurn, uid } from "./runner";
import type {
  Bootstrap,
  LoadedSkill,
  McpServerState,
  MokaConfig,
  MokaEvent,
  ProviderPreset,
  SessionSummary,
  UiMessage,
  Workspace,
} from "./types";

export type View = "chat" | "compare" | "tools";
export type SettingsTab = "models" | "mcp" | "skills" | "workspaces" | "config";

interface Toast {
  id: string;
  message: string;
  kind: "info" | "success" | "error";
}

interface Session {
  id: string;
  title: string;
  workspaceId?: string;
  createdAt: number;
  messages: UiMessage[];
  modelMessages: unknown[];
}

interface State {
  ready: boolean;
  authError: boolean;
  fatal?: string;
  version: string;
  configPath: string;
  config: MokaConfig;
  presets: ProviderPreset[];
  env: Record<string, boolean>;
  mcp: Record<string, McpServerState>;
  skills: LoadedSkill[];

  events: MokaEvent[];
  eventIds: Set<string>;
  eventsConnected: boolean;
  selectedEventId?: string;

  sessions: SessionSummary[];
  session: Session;
  streaming: boolean;
  controller?: AbortController;

  view: View;
  toolTarget?: { serverId: string; tool?: string };
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  presenter: boolean;
  theme: "dark" | "light";
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  exportOpen: boolean;
  paletteOpen: boolean;
  toasts: Toast[];

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshMcp: () => Promise<void>;
  saveConfig: (next: MokaConfig, message?: string) => Promise<boolean>;
  workspace: () => Workspace;
  setActiveWorkspace: (id: string) => Promise<void>;
  setWorkspaceModel: (llmId: string) => Promise<void>;
  connectServer: (id: string, force?: boolean) => Promise<McpServerState | undefined>;

  /** `display` replaces what the chat shows (e.g. a UI action chip); the model still gets `text`. */
  send: (text: string, options?: { display?: string; via?: "a2ui" | "mcp-app" }) => Promise<void>;
  /** Extra context an MCP App asked to add to the model's next turn (ui/update-model-context). */
  appContext?: string;
  stop: () => void;
  retry: () => Promise<void>;
  newChat: () => void;
  openSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  loadSessions: () => Promise<void>;

  set: (patch: Partial<State>) => void;
  openSettings: (tab?: SettingsTab) => void;
  toggleTheme: () => void;
  clearEvents: () => Promise<void>;
  toast: (message: string, kind?: Toast["kind"]) => void;
}

const MAX_EVENTS = 3000;

function freshSession(workspaceId?: string): Session {
  return { id: uid("s"), title: "New chat", workspaceId, createdAt: Date.now(), messages: [], modelMessages: [] };
}

function pref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`moka.${key}`);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`moka.${key}`, JSON.stringify(value));
  } catch {
    // ignore
  }
}

let initialised = false;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<State>((set, get) => ({
  ready: false,
  authError: false,
  version: "",
  configPath: "",
  config: { version: 1, llms: [], mcpServers: [], skills: [], workspaces: [] },
  presets: [],
  env: {},
  mcp: {},
  skills: [],

  events: [],
  eventIds: new Set(),
  eventsConnected: false,

  sessions: [],
  session: freshSession(),
  streaming: false,

  view: "chat",
  sidebarOpen: pref("sidebar", true),
  inspectorOpen: pref("inspector", true),
  presenter: false,
  theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
  settingsOpen: false,
  settingsTab: "models",
  exportOpen: false,
  paletteOpen: false,
  toasts: [],

  set: (patch) => {
    if ("sidebarOpen" in patch) savePref("sidebar", patch.sidebarOpen);
    if ("inspectorOpen" in patch) savePref("inspector", patch.inspectorOpen);
    set(patch as any);
  },

  init: async () => {
    if (initialised) return;
    initialised = true;
    try {
      await get().refresh();
    } catch (error: any) {
      if (error?.status === 401) set({ authError: true });
      else set({ fatal: error?.message ?? String(error) });
      return;
    }
    set({ ready: true, session: freshSession(get().config.activeWorkspaceId) });
    subscribeEvents(
      (event) => {
        const { eventIds } = get();
        if (eventIds.has(event.id)) return;
        eventIds.add(event.id);
        set((s) => {
          const events = s.events.length >= MAX_EVENTS ? s.events.slice(-MAX_EVENTS + 1) : s.events.slice();
          events.push(event);
          return { events };
        });
        if (event.kind === "mcp.status") {
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => void get().refreshMcp(), 150);
        }
      },
      (connected) => set({ eventsConnected: connected }),
    );
    void get().loadSessions();
    // Warm up MCP connections for the active workspace so tools are ready.
    for (const id of get().workspace().mcpServerIds) void get().connectServer(id);
  },

  refresh: async () => {
    const boot = await api<Bootstrap>("/api/bootstrap");
    set({
      version: boot.version,
      configPath: boot.configPath,
      config: boot.config,
      presets: boot.presets,
      env: boot.env,
      mcp: Object.fromEntries(boot.mcp.map((s) => [s.id, s])),
      skills: boot.skills,
    });
  },

  refreshMcp: async () => {
    const { servers } = await api<{ servers: McpServerState[] }>("/api/mcp");
    set({ mcp: Object.fromEntries(servers.map((s) => [s.id, s])) });
  },

  saveConfig: async (next, message) => {
    try {
      const { config } = await api<{ config: MokaConfig }>("/api/config", { method: "PUT", body: next });
      set({ config });
      await get().refresh();
      if (message) get().toast(message, "success");
      return true;
    } catch (error: any) {
      get().toast(error?.message ?? "Could not save", "error");
      return false;
    }
  },

  workspace: () => {
    const { config, session } = get();
    const id = session.workspaceId ?? config.activeWorkspaceId;
    return config.workspaces.find((w) => w.id === id) ?? config.workspaces[0]!;
  },

  setActiveWorkspace: async (id) => {
    const { config, session } = get();
    await get().saveConfig({ ...config, activeWorkspaceId: id });
    if (session.messages.length === 0) set({ session: { ...session, workspaceId: id } });
    else set({ session: freshSession(id) });
    for (const sid of get().workspace().mcpServerIds) void get().connectServer(sid);
  },

  setWorkspaceModel: async (llmId) => {
    const { config } = get();
    const ws = get().workspace();
    await get().saveConfig({
      ...config,
      workspaces: config.workspaces.map((w) => (w.id === ws.id ? { ...w, llmId } : w)),
    });
  },

  connectServer: async (id, force) => {
    set((s) => ({ mcp: { ...s.mcp, [id]: { ...(s.mcp[id] ?? emptyState(id, s.config)), status: "connecting", error: undefined } } }));
    try {
      const { state } = await api<{ state: McpServerState }>(`/api/mcp/${encodeURIComponent(id)}/connect`, { body: { force } });
      set((s) => ({ mcp: { ...s.mcp, [id]: state } }));
      return state;
    } catch (error: any) {
      set((s) => ({ mcp: { ...s.mcp, [id]: { ...(s.mcp[id] ?? emptyState(id, s.config)), status: "error", error: error?.message } } }));
      return undefined;
    }
  },

  send: async (text, options) => {
    let content = text.trim();
    if (!content || get().streaming) return;
    const shown = options?.display ?? content;
    const appContext = get().appContext;
    if (appContext) {
      content = `${content}\n\n<app_context>\n${appContext}\n</app_context>`;
      set({ appContext: undefined });
    }
    const controller = new AbortController();
    const base = get().session;
    const user: UiMessage = { id: uid("u"), role: "user", parts: [{ type: "text", text: shown }], meta: options?.via ? { via: options.via } : undefined };
    const modelMessages = [...base.modelMessages, { role: "user", content }];
    const title = base.messages.length === 0 ? shown.slice(0, 60) : base.title;
    set({
      streaming: true,
      controller,
      session: { ...base, title, messages: [...base.messages, user], modelMessages },
    });
    const sessionId = base.id;
    const placeholder: UiMessage = { id: uid("a"), role: "assistant", parts: [], meta: {} };
    set((s) => ({ session: { ...s.session, messages: [...s.session.messages, placeholder] } }));

    const result = await runTurn({
      modelMessages,
      workspaceId: base.workspaceId,
      signal: controller.signal,
      onUpdate: (message) => {
        if (get().session.id !== sessionId) return;
        set((s) => ({
          session: { ...s.session, messages: [...s.session.messages.slice(0, -1), { ...message, id: placeholder.id }] },
        }));
      },
    });

    if (get().session.id === sessionId) {
      set((s) => ({
        streaming: false,
        controller: undefined,
        session: {
          ...s.session,
          messages: [...s.session.messages.slice(0, -1), { ...result.message, id: placeholder.id }],
          modelMessages: [...s.session.modelMessages, ...result.responseMessages],
        },
      }));
      void persist(get().session);
    } else {
      set({ streaming: false, controller: undefined });
    }
  },

  stop: () => {
    get().controller?.abort();
  },

  retry: async () => {
    const { session } = get();
    const lastUserIndex = session.messages.map((m) => m.role).lastIndexOf("user");
    if (lastUserIndex < 0) return;
    const lastUser = session.messages[lastUserIndex]!;
    const text = lastUser.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    // Rewind model history to before that user message.
    let cut = session.modelMessages.length;
    for (let i = session.modelMessages.length - 1; i >= 0; i--) {
      if ((session.modelMessages[i] as any)?.role === "user") {
        cut = i;
        break;
      }
    }
    set({
      session: {
        ...session,
        messages: session.messages.slice(0, lastUserIndex),
        modelMessages: session.modelMessages.slice(0, cut),
      },
    });
    await get().send(text);
  },

  newChat: () => {
    get().controller?.abort();
    set({ session: freshSession(get().config.activeWorkspaceId), view: "chat", streaming: false });
  },

  openSession: async (id) => {
    get().controller?.abort();
    try {
      const { session } = await api<{ session: any }>(`/api/sessions/${id}`);
      set({
        view: "chat",
        streaming: false,
        session: {
          id: session.id,
          title: session.title,
          workspaceId: session.workspaceId,
          createdAt: session.createdAt,
          messages: session.data?.messages ?? [],
          modelMessages: session.data?.modelMessages ?? [],
        },
      });
    } catch (error: any) {
      get().toast(error?.message ?? "Could not open chat", "error");
    }
  },

  deleteSession: async (id) => {
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    if (get().session.id === id) get().newChat();
    await get().loadSessions();
  },

  loadSessions: async () => {
    try {
      const { sessions } = await api<{ sessions: SessionSummary[] }>("/api/sessions");
      set({ sessions });
    } catch {
      // non-fatal
    }
  },

  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? get().settingsTab }),

  toggleTheme: () => {
    const theme = get().theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("moka.theme", theme);
    } catch {
      // ignore
    }
    set({ theme });
  },

  clearEvents: async () => {
    await api("/api/events", { method: "DELETE" }).catch(() => {});
    set({ events: [], selectedEventId: undefined });
  },

  toast: (message, kind = "info") => {
    const id = uid("t");
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 6000 : 3000);
  },
}));

function emptyState(id: string, config: MokaConfig): McpServerState {
  const name = config.mcpServers.find((s) => s.id === id)?.name ?? id;
  return { id, name, status: "idle", tools: [], prompts: [], resources: [], stderr: [] };
}

async function persist(session: Session) {
  if (session.messages.length === 0) return;
  try {
    await api(`/api/sessions/${session.id}`, {
      method: "PUT",
      body: {
        id: session.id,
        title: session.title,
        workspaceId: session.workspaceId,
        createdAt: session.createdAt,
        messageCount: session.messages.length,
        data: { messages: session.messages, modelMessages: session.modelMessages },
      },
    });
    await useStore.getState().loadSessions();
  } catch {
    // non-fatal
  }
}
