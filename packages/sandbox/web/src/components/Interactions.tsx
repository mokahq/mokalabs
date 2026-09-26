import { Bot, ExternalLink, MessageSquareText, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import type { Interaction, JsonSchema } from "../types";
import { Badge, Button, Field, Input, JsonView, Modal, Select, Switch, Textarea } from "./ui";

type Approval = Extract<Interaction, { kind: "tool-approval" }>;
type Elicitation = Extract<Interaction, { kind: "elicitation" }>;
type Sampling = Extract<Interaction, { kind: "sampling" }>;

export function usePendingApproval(toolCallId: string): Approval | undefined {
  return useStore((s) => Object.values(s.interactions).find((i): i is Approval => i.kind === "tool-approval" && i.toolCallId === toolCallId));
}

/** Inline approve / deny bar shown inside a tool card. */
export function ApprovalBar({ approval }: { approval: Approval }) {
  const respond = useStore((s) => s.respond);
  const destructive = approval.annotations?.destructiveHint === true;
  return (
    <div data-approval={approval.id} className="flex flex-wrap items-center gap-2 border-t border-warn/30 bg-warn/5 px-3 py-2">
      {destructive ? <ShieldAlert className="h-4 w-4 text-err" /> : <ShieldCheck className="h-4 w-4 text-warn" />}
      <span className="text-[12.5px] text-fg">
        Run <span className="font-mono font-medium">{approval.tool}</span> on {approval.serverName}?
        {destructive && <span className="ml-1 text-err">The server marks this tool as destructive.</span>}
      </span>
      <span className="flex-1" />
      <Button size="xs" variant="ghost" onClick={() => respond(approval.id, { approved: false })}>
        Deny
      </Button>
      <Button size="xs" variant="outline" title="Allow this tool until Moka restarts" onClick={() => respond(approval.id, { approved: true, remember: "session" })}>
        Allow for session
      </Button>
      <Button size="xs" variant="outline" title="Never ask again for this tool (saved to moka.json)" onClick={() => respond(approval.id, { approved: true, remember: "always" })}>
        Always
      </Button>
      <Button size="xs" variant="primary" onClick={() => respond(approval.id, { approved: true })}>
        Approve
      </Button>
    </div>
  );
}

/**
 * Modals for server-initiated requests (elicitation, sampling) and a floating
 * stack for approvals that no visible tool card is showing.
 */
export function InteractionCenter() {
  const interactions = useStore((s) => s.interactions);
  const list = useMemo(() => Object.values(interactions).sort((a, b) => a.createdAt - b.createdAt), [interactions]);
  const modal = list.find((i): i is Elicitation | Sampling => i.kind === "elicitation" || i.kind === "sampling");
  const [orphans, setOrphans] = useState<Approval[]>([]);

  useEffect(() => {
    const check = () => setOrphans(list.filter((i): i is Approval => i.kind === "tool-approval" && !document.querySelector(`[data-approval="${i.id}"]`)));
    const timer = setTimeout(check, 400);
    return () => clearTimeout(timer);
  }, [list]);

  return (
    <>
      {modal?.kind === "elicitation" && <ElicitationModal key={modal.id} request={modal} />}
      {modal?.kind === "sampling" && <SamplingModal key={modal.id} request={modal} />}
      {orphans.length > 0 && (
        <div className="fixed right-4 bottom-4 z-40 w-[26rem] max-w-[calc(100vw-2rem)] space-y-2">
          {orphans.map((a) => (
            <div key={a.id} className="animate-in overflow-hidden rounded-xl border border-warn/40 bg-panel shadow-soft">
              <div className="px-3 pt-2.5 text-[12px] text-muted">Tool approval needed</div>
              <div className="px-3 pt-1 pb-2">
                <JsonView value={a.input ?? {}} maxHeight="8rem" />
              </div>
              <ApprovalBar approval={a} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- elicitation */

function fieldType(prop: JsonSchema): string {
  const t = Array.isArray(prop.type) ? prop.type.find((x) => x !== "null") : prop.type;
  return t ?? (prop.enum || prop.oneOf ? "string" : "string");
}

function initialValues(schema?: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema?.properties ?? {})) if (prop.default !== undefined) out[key] = prop.default;
  return out;
}

function ElicitationModal({ request }: { request: Elicitation }) {
  const respond = useStore((s) => s.respond);
  const schema = request.requestedSchema ?? {};
  const required = new Set(schema.required ?? []);
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(schema));
  const missing = [...required].filter((k) => values[k] === undefined || values[k] === "");

  const decline = () => respond(request.id, { action: "decline" });
  return (
    <Modal open onClose={() => respond(request.id, { action: "cancel" })} title={`${request.serverName} needs your input`} className="max-w-lg">
      <div className="space-y-4 overflow-y-auto p-5">
        <div className="flex items-start gap-2.5 rounded-lg bg-panel-2/60 px-3 py-2.5 text-[13.5px]">
          <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <p className="whitespace-pre-wrap">{request.message}</p>
        </div>
        {request.mode === "url" ? (
          <div className="space-y-3">
            <p className="text-[13px] text-muted">The server wants you to finish this step in your browser.</p>
            <div className="truncate rounded-lg border border-line px-3 py-2 font-mono text-[12px]">{request.url}</div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={decline}>
                Decline
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<ExternalLink className="h-3.5 w-3.5" />}
                onClick={() => {
                  if (request.url) window.open(request.url, "_blank", "noopener,noreferrer");
                  respond(request.id, { action: "accept" });
                }}
              >
                Open and continue
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (missing.length === 0) respond(request.id, { action: "accept", content: values });
            }}
          >
            {Object.entries(schema.properties ?? {}).map(([key, prop]) => {
              const label = `${(prop.title as string) ?? key}${required.has(key) ? " *" : ""}`;
              const value = values[key];
              const setValue = (v: unknown) => setValues((s) => ({ ...s, [key]: v }));
              const type = fieldType(prop);
              const options: Array<{ value: string; label: string }> = Array.isArray(prop.oneOf)
                ? (prop.oneOf as any[]).map((o) => ({ value: String(o.const), label: String(o.title ?? o.const) }))
                : Array.isArray(prop.enum)
                  ? prop.enum.map((v, i) => ({ value: String(v), label: String((prop.enumNames as string[] | undefined)?.[i] ?? v) }))
                  : [];
              if (type === "array") {
                const items = (prop.items ?? {}) as JsonSchema;
                const choices: Array<{ value: string; label: string }> = Array.isArray(items.anyOf)
                  ? (items.anyOf as any[]).map((o) => ({ value: String(o.const), label: String(o.title ?? o.const) }))
                  : (items.enum ?? []).map((v) => ({ value: String(v), label: String(v) }));
                const selected = new Set(Array.isArray(value) ? (value as string[]) : []);
                return (
                  <Field key={key} label={label} hint={prop.description}>
                    <div className="flex flex-wrap gap-1.5">
                      {choices.map((c) => (
                        <button
                          type="button"
                          key={c.value}
                          onClick={() => setValue(selected.has(c.value) ? [...selected].filter((x) => x !== c.value) : [...selected, c.value])}
                          className={`rounded-full border px-2.5 py-0.5 text-[12.5px] ${selected.has(c.value) ? "border-accent bg-accent-soft text-accent" : "border-line text-muted"}`}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </Field>
                );
              }
              if (options.length) {
                return (
                  <Field key={key} label={label} hint={prop.description}>
                    <Select value={String(value ?? "")} onChange={(e) => setValue(e.target.value || undefined)}>
                      <option value="">—</option>
                      {options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                );
              }
              if (type === "boolean") {
                return (
                  <Field key={key} label={label} hint={prop.description}>
                    <Switch checked={Boolean(value)} onChange={setValue} />
                  </Field>
                );
              }
              if (type === "number" || type === "integer") {
                return (
                  <Field key={key} label={label} hint={prop.description}>
                    <Input type="number" min={prop.minimum} max={prop.maximum} value={value === undefined ? "" : String(value)} onChange={(e) => setValue(e.target.value === "" ? undefined : Number(e.target.value))} />
                  </Field>
                );
              }
              const format = prop.format as string | undefined;
              const inputType = format === "email" ? "email" : format === "uri" ? "url" : format === "date" ? "date" : format === "date-time" ? "datetime-local" : "text";
              return (
                <Field key={key} label={label} hint={prop.description}>
                  {(prop.maxLength as number | undefined) && (prop.maxLength as number) > 200 ? (
                    <Textarea rows={3} value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} />
                  ) : (
                    <Input type={inputType} value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} />
                  )}
                </Field>
              );
            })}
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={decline}>
                Decline
              </Button>
              <Button type="submit" size="sm" variant="primary" disabled={missing.length > 0}>
                Send
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- sampling */

function SamplingModal({ request }: { request: Sampling }) {
  const respond = useStore((s) => s.respond);
  const model = useStore((s) => {
    const ws = s.workspace();
    return s.config.llms.find((l) => l.id === ws.llmId) ?? s.config.llms[0];
  });
  return (
    <Modal open onClose={() => respond(request.id, { approved: false })} title={`${request.serverName} wants to use your model`} className="max-w-xl">
      <div className="space-y-3 overflow-y-auto p-5">
        <p className="text-[13px] text-muted">
          MCP sampling: the server asks Moka to run a completion on its behalf. It will use{" "}
          {model ? (
            <Badge tone="accent">
              <Bot className="h-3 w-3" /> {model.name} · {model.model}
            </Badge>
          ) : (
            "no model (add one first)"
          )}
          {request.maxTokens ? ` with up to ${request.maxTokens} tokens.` : "."}
        </p>
        {request.systemPrompt && (
          <div>
            <div className="mb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">System prompt</div>
            <JsonView value={request.systemPrompt} maxHeight="8rem" />
          </div>
        )}
        <div>
          <div className="mb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">Messages</div>
          <JsonView value={request.messages} maxHeight="16rem" />
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => respond(request.id, { approved: false })}>
            Deny
          </Button>
          <Button size="sm" variant="primary" disabled={!model} onClick={() => respond(request.id, { approved: true })}>
            Run completion
          </Button>
        </div>
      </div>
    </Modal>
  );
}
