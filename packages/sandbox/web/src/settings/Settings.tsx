import { Boxes, Braces, Cpu, LayoutTemplate, Layers, Plug, Sparkles, Workflow, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { IconButton, cn } from "../components/ui";
import { useStore, type SettingsTab } from "../store";
import { AgentSettings } from "./AgentSettings";
import { ConfigSettings } from "./ConfigSettings";
import { GenUiSettings } from "./GenUiSettings";
import { McpSettings } from "./McpSettings";
import { ModelSettings } from "./ModelSettings";
import { SkillSettings } from "./SkillSettings";
import { WorkspaceSettings } from "./WorkspaceSettings";

const TABS: Array<{ id: SettingsTab; label: string; icon: ReactNode; blurb: string }> = [
  { id: "models", label: "Models", icon: <Cpu className="h-4 w-4" />, blurb: "LLM providers and credentials" },
  { id: "agents", label: "Agents", icon: <Workflow className="h-4 w-4" />, blurb: "Remote agents over A2A and AG-UI" },
  { id: "mcp", label: "MCP servers", icon: <Plug className="h-4 w-4" />, blurb: "Tools, resources and prompts" },
  { id: "skills", label: "Skills", icon: <Sparkles className="h-4 w-4" />, blurb: "SKILL.md instructions" },
  { id: "genui", label: "Generative UI", icon: <LayoutTemplate className="h-4 w-4" />, blurb: "A2UI catalogs, playground and the render tool" },
  { id: "workspaces", label: "Workspaces", icon: <Layers className="h-4 w-4" />, blurb: "Model + tools + prompt presets" },
  { id: "config", label: "Config file", icon: <Braces className="h-4 w-4" />, blurb: "Raw JSON, import & export" },
];

export function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const tab = useStore((s) => s.settingsTab);
  const set = useStore((s) => s.set);
  const counts = useStore(
    useShallow((s) => ({
      models: s.config.llms.length,
      agents: s.config.agents.length,
      mcp: s.config.mcpServers.length,
      skills: s.config.skills.length,
      genui: s.catalogs.length,
      workspaces: s.config.workspaces.length,
    })),
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) set({ settingsOpen: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, set]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-6">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => set({ settingsOpen: false })} />
      <div className="animate-in relative flex h-full max-h-[860px] w-full max-w-6xl overflow-hidden rounded-2xl border border-line bg-panel shadow-soft">
        <nav className="hidden w-56 shrink-0 flex-col border-r border-line bg-panel-2/50 p-3 md:flex">
          <div className="mb-3 flex items-center gap-2 px-2 pt-1">
            <Boxes className="h-4 w-4 text-accent" />
            <span className="text-sm font-semibold">Settings</span>
          </div>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => set({ settingsTab: t.id })}
              className={cn(
                "mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
                tab === t.id ? "bg-panel text-fg shadow-sm" : "text-muted hover:bg-panel hover:text-fg",
              )}
            >
              <span className={tab === t.id ? "text-accent" : ""}>{t.icon}</span>
              <span className="flex-1 font-medium">{t.label}</span>
              {t.id !== "config" && <span className="font-mono text-[11px] text-subtle">{counts[t.id as keyof typeof counts]}</span>}
            </button>
          ))}
          <div className="mt-auto px-2 text-[11px] leading-relaxed text-subtle">Changes are saved to your config file immediately.</div>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-line px-5 py-3">
            <div className="flex gap-1 md:hidden">
              {TABS.map((t) => (
                <IconButton key={t.id} label={t.label} active={tab === t.id} onClick={() => set({ settingsTab: t.id })}>
                  {t.icon}
                </IconButton>
              ))}
            </div>
            <div className="hidden md:block">
              <h2 className="text-[15px] font-semibold">{TABS.find((t) => t.id === tab)?.label}</h2>
              <p className="text-[12px] text-muted">{TABS.find((t) => t.id === tab)?.blurb}</p>
            </div>
            <span className="flex-1" />
            <IconButton label="Close settings" onClick={() => set({ settingsOpen: false })}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1">
            {tab === "models" && <ModelSettings />}
            {tab === "agents" && <AgentSettings />}
            {tab === "mcp" && <McpSettings />}
            {tab === "skills" && <SkillSettings />}
            {tab === "genui" && <GenUiSettings />}
            {tab === "workspaces" && <WorkspaceSettings />}
            {tab === "config" && <ConfigSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Two-pane layout: item list on the left, editor on the right. */
export function MasterDetail({ list, detail }: { list: ReactNode; detail: ReactNode }) {
  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-64 shrink-0 flex-col border-r border-line">{list}</div>
      <div className="min-w-0 flex-1 overflow-y-auto">{detail}</div>
    </div>
  );
}

export function ListItem({
  active,
  onClick,
  title,
  subtitle,
  left,
  right,
}: {
  active: boolean;
  onClick: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        active ? "bg-accent-soft" : "hover:bg-panel-2",
      )}
    >
      {left}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{title}</div>
        {subtitle && <div className="truncate text-[11.5px] text-muted">{subtitle}</div>}
      </div>
      {right}
    </button>
  );
}

export function Section({ title, description, children, right }: { title: string; description?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="border-b border-line px-6 py-5 last:border-b-0">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[13.5px] font-semibold">{title}</h3>
          {description && <p className="mt-0.5 text-[12.5px] text-muted">{description}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function FormFooter({ children }: { children: ReactNode }) {
  return <div className="sticky bottom-0 flex items-center gap-2 border-t border-line bg-panel/95 px-6 py-3 backdrop-blur">{children}</div>;
}
