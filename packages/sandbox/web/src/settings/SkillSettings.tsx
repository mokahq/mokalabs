import { AlertTriangle, FileText, FolderOpen, FolderSearch, PenLine, Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Markdown } from "../components/Markdown";
import { Badge, Button, Empty, Field, Input, Switch, Tabs, Textarea, cn } from "../components/ui";
import { useStore } from "../store";
import type { LoadedSkill, SkillConfig } from "../types";
import { FormFooter, ListItem, MasterDetail, Section } from "./Settings";

const TEMPLATE = `---
name: release-notes
description: Writes crisp release notes from a list of changes. Use when the user asks for release notes or a changelog.
---

# Release notes

1. Group changes into **Features**, **Fixes** and **Chores**.
2. One line per change, imperative mood, no trailing period.
3. Lead with the most user-visible change.
`;

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "skill";
}

export function SkillSettings() {
  const config = useStore((s) => s.config);
  const skills = useStore((s) => s.skills);
  const [selected, setSelected] = useState<string | "new" | undefined>(config.skills[0]?.id ?? "new");
  useEffect(() => {
    if (selected && selected !== "new" && !config.skills.some((s) => s.id === selected)) setSelected(config.skills[0]?.id ?? "new");
  }, [config.skills, selected]);
  const current = config.skills.find((s) => s.id === selected);
  const loaded = (id: string) => skills.find((s) => s.id === id);

  return (
    <MasterDetail
      list={
        <>
          <div className="p-3">
            <Button className="w-full" variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setSelected("new")}>
              Add skill
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
            {config.skills.map((s) => {
              const l = loaded(s.id);
              return (
                <ListItem
                  key={s.id}
                  active={selected === s.id}
                  onClick={() => setSelected(s.id)}
                  left={
                    <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-panel-2", l?.error ? "text-err" : "text-violet")}>
                      {l?.error ? <AlertTriangle className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                    </span>
                  }
                  title={l?.name ?? s.name ?? s.id}
                  subtitle={l?.error ?? l?.description ?? s.path}
                />
              );
            })}
          </div>
        </>
      }
      detail={
        selected === "new" ? (
          <NewSkill onCreated={setSelected} />
        ) : current ? (
          <SkillForm key={current.id} initial={current} loaded={loaded(current.id)} />
        ) : (
          <Empty icon={<Sparkles className="h-5 w-5" />} title="No skill selected" />
        )
      }
    />
  );
}

function useAddSkills() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  return async (skills: Array<Omit<SkillConfig, "id"> & { base: string }>) => {
    const taken = new Set(config.skills.map((s) => s.id));
    const created: SkillConfig[] = skills.map(({ base, ...rest }) => {
      let id = slug(base);
      const root = id;
      for (let i = 2; taken.has(id); i++) id = `${root}-${i}`;
      taken.add(id);
      return { ...rest, id };
    });
    const ok = await saveConfig(
      {
        ...config,
        skills: [...config.skills, ...created],
        workspaces: config.workspaces.map((w) =>
          w.id === config.activeWorkspaceId ? { ...w, skillIds: [...w.skillIds, ...created.map((c) => c.id)] } : w,
        ),
      },
      created.length === 1 ? "Skill added" : `${created.length} skills added`,
    );
    return ok ? created : [];
  };
}

function NewSkill({ onCreated }: { onCreated: (id: string) => void }) {
  const [mode, setMode] = useState<"path" | "scan" | "inline">("path");
  const add = useAddSkills();
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<LoadedSkill>();
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<string[]>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [content, setContent] = useState(TEMPLATE);
  const [error, setError] = useState<string>();

  const doPreview = async (skill: Partial<SkillConfig>) => {
    setBusy(true);
    setError(undefined);
    try {
      const { skill: loaded } = await api<{ skill: LoadedSkill }>("/api/skills/preview", { body: { skill: { id: "preview", ...skill } } });
      setPreview(loaded);
      return loaded;
    } catch (e: any) {
      setError(e?.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold">Add a skill</h3>
          <p className="mt-1 max-w-lg text-[13px] text-muted">
            Skills are folders with a <code className="font-mono">SKILL.md</code>. The model sees each skill's name and description, and loads the full instructions when it needs them.
          </p>
        </div>
        <Tabs
          value={mode}
          onChange={(m) => {
            setMode(m);
            setPreview(undefined);
            setError(undefined);
          }}
          items={[
            { value: "path", label: "Folder", icon: <FolderOpen className="h-3.5 w-3.5" /> },
            { value: "scan", label: "Scan", icon: <FolderSearch className="h-3.5 w-3.5" /> },
            { value: "inline", label: "Write", icon: <PenLine className="h-3.5 w-3.5" /> },
          ]}
        />
      </div>

      <div className="mt-5 space-y-4">
        {mode === "path" && (
          <>
            <Field label="Skill folder or SKILL.md path" hint="Absolute, ~/…, or relative to your config file. Works with Claude's skills folders (~/.claude/skills/…).">
              <div className="flex gap-2">
                <Input mono value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/.claude/skills/pdf" />
                <Button variant="outline" loading={busy} disabled={!path.trim()} onClick={() => doPreview({ path })}>
                  Preview
                </Button>
              </div>
            </Field>
            {preview && <SkillPreview skill={preview} />}
            <Button
              variant="primary"
              size="sm"
              disabled={!preview || !!preview.error}
              onClick={async () => {
                const [c] = await add([{ path, base: preview?.name ?? path }]);
                if (c) onCreated(c.id);
              }}
            >
              Add skill
            </Button>
          </>
        )}

        {mode === "scan" && (
          <>
            <Field label="Folder containing skills" hint="Every sub-folder with a SKILL.md is listed.">
              <div className="flex gap-2">
                <Input mono value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/.claude/skills" />
                <Button
                  variant="outline"
                  loading={busy}
                  disabled={!path.trim()}
                  onClick={async () => {
                    setBusy(true);
                    setError(undefined);
                    try {
                      const { paths } = await api<{ paths: string[] }>("/api/skills/discover", { body: { path } });
                      setFound(paths);
                      setPicked(new Set(paths));
                    } catch (e: any) {
                      setError(e?.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Scan
                </Button>
              </div>
            </Field>
            {found && (
              <div className="rounded-xl border border-line">
                {found.length === 0 && <p className="px-4 py-3 text-[13px] text-muted">No SKILL.md files found.</p>}
                {found.map((p) => (
                  <label key={p} className="flex cursor-pointer items-center gap-3 border-b border-line px-4 py-2 last:border-0">
                    <input
                      type="checkbox"
                      className="accent-[var(--accent)]"
                      checked={picked.has(p)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(p);
                        else next.delete(p);
                        setPicked(next);
                      }}
                    />
                    <span className="font-mono text-[12.5px]">{p}</span>
                  </label>
                ))}
              </div>
            )}
            <Button
              variant="primary"
              size="sm"
              disabled={!found || picked.size === 0}
              onClick={async () => {
                const created = await add([...picked].map((p) => ({ path: p, base: p.split(/[\\/]/).pop() ?? p })));
                if (created[0]) onCreated(created[0].id);
              }}
            >
              Add {picked.size || ""} skills
            </Button>
          </>
        )}

        {mode === "inline" && (
          <>
            <Field label="SKILL.md" hint="YAML frontmatter with name + description, then markdown instructions.">
              <Textarea mono rows={16} value={content} onChange={(e) => setContent(e.target.value)} />
            </Field>
            <Button
              variant="primary"
              size="sm"
              disabled={!content.trim()}
              onClick={async () => {
                const name = /^name:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? "skill";
                const [c] = await add([{ content, base: name }]);
                if (c) onCreated(c.id);
              }}
            >
              Add skill
            </Button>
          </>
        )}
        {error && <p className="text-[12.5px] text-err">{error}</p>}
      </div>
    </div>
  );
}

function SkillPreview({ skill }: { skill: LoadedSkill }) {
  if (skill.error) {
    return (
      <div className="rounded-xl border border-err/30 bg-err/5 px-4 py-3 text-[13px]">
        <p className="font-medium text-err">Could not load skill</p>
        <p className="mt-0.5 text-muted">{skill.error}</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-line">
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet" />
          <span className="text-[13.5px] font-semibold">{skill.name}</span>
          {skill.files.length > 0 && <Badge>{skill.files.length} files</Badge>}
        </div>
        <p className="mt-1 text-[12.5px] text-muted">{skill.description}</p>
      </div>
      {skill.body && (
        <div className="max-h-72 overflow-y-auto px-4 py-3 text-[13px]">
          <Markdown text={skill.body} />
        </div>
      )}
      {skill.files.length > 0 && (
        <div className="flex flex-wrap gap-1 border-t border-line px-4 py-2.5">
          {skill.files.slice(0, 40).map((f) => (
            <Badge key={f} className="font-mono">
              <FileText className="h-2.5 w-2.5" />
              {f}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function SkillForm({ initial, loaded }: { initial: SkillConfig; loaded?: LoadedSkill }) {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const workspace = useStore((s) => s.workspace());
  const [draft, setDraft] = useState<SkillConfig>(initial);
  const [preview, setPreview] = useState<LoadedSkill | undefined>();
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);
  const enabled = workspace.skillIds.includes(initial.id);

  useEffect(() => {
    let cancelled = false;
    api<{ skill: LoadedSkill }>("/api/skills/preview", { body: { skill: initial } })
      .then(({ skill }) => !cancelled && setPreview(skill))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initial]);

  const clean = (s: SkillConfig): SkillConfig => {
    const out: any = { ...s };
    for (const k of Object.keys(out)) if (out[k] === "" || out[k] === undefined) delete out[k];
    return out;
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1">
        <Section
          title={loaded?.name ?? initial.id}
          description={initial.path ? `From ${initial.path}` : "Inline skill"}
          right={
            <label className="flex items-center gap-2 text-[12.5px] text-muted">
              Enabled in {workspace.name}
              <Switch
                checked={enabled}
                onChange={(v) =>
                  saveConfig({
                    ...config,
                    workspaces: config.workspaces.map((w) =>
                      w.id === workspace.id ? { ...w, skillIds: v ? [...w.skillIds, initial.id] : w.skillIds.filter((id) => id !== initial.id) } : w,
                    ),
                  })
                }
              />
            </label>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {initial.path !== undefined ? (
              <Field label="Path" className="sm:col-span-2">
                <Input mono value={draft.path ?? ""} onChange={(e) => setDraft({ ...draft, path: e.target.value })} />
              </Field>
            ) : (
              <Field label="SKILL.md" className="sm:col-span-2">
                <Textarea mono rows={14} value={draft.content ?? ""} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
              </Field>
            )}
            <Field label="Name override" hint="Optional — defaults to the frontmatter name.">
              <Input value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={preview?.name} />
            </Field>
            <Field label="Description override" hint="What the model reads to decide when to use it.">
              <Input value={draft.description ?? ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder={preview?.description} />
            </Field>
          </div>
        </Section>
        {preview && (
          <Section title="Preview" description="Exactly what the model gets when it calls load_skill.">
            <SkillPreview skill={preview} />
          </Section>
        )}
      </div>
      <FormFooter>
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={async () => {
            if (!confirm("Remove this skill?")) return;
            await saveConfig(
              {
                ...config,
                skills: config.skills.filter((s) => s.id !== initial.id),
                workspaces: config.workspaces.map((w) => ({ ...w, skillIds: w.skillIds.filter((id) => id !== initial.id) })),
              },
              "Skill removed",
            );
          }}
        >
          Remove
        </Button>
        <span className="flex-1" />
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty}
          onClick={() => saveConfig({ ...config, skills: config.skills.map((s) => (s.id === initial.id ? clean(draft) : s)) }, "Skill saved")}
        >
          Save changes
        </Button>
      </FormFooter>
    </div>
  );
}
