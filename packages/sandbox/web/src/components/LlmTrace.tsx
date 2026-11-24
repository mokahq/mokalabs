import { Brain, ChevronRight, Wrench } from "lucide-react";
import { useState } from "react";
import type { MokaEvent } from "../types";
import { Badge, JsonView, Tabs, cn, formatNumber } from "./ui";

type Part = { type: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown; output?: { type?: string; value?: unknown } | unknown; mediaType?: string; filename?: string };
type Message = { role: string; content: string | Part[] };

const ROLE: Record<string, { label: string; tone: "neutral" | "accent" | "info" | "violet" | "ok" }> = {
  system: { label: "system", tone: "neutral" },
  user: { label: "user", tone: "accent" },
  assistant: { label: "assistant", tone: "violet" },
  tool: { label: "tool", tone: "ok" },
};

const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "");

/** Long text folded to a few lines, with a toggle. */
function Folded({ text, mono, lines = 6 }: { text: string; mono?: boolean; lines?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > lines || text.length > lines * 120;
  return (
    <div>
      <div className={cn("text-[12.5px] leading-relaxed break-words whitespace-pre-wrap", mono && "font-mono text-[11.5px]", !open && long && "line-clamp-6")}>{text}</div>
      {long && (
        <button className="mt-0.5 text-[11.5px] text-accent hover:underline" onClick={() => setOpen(!open)}>
          {open ? "Show less" : `Show all (${formatNumber(text.length)} characters)`}
        </button>
      )}
    </div>
  );
}

function PartView({ part }: { part: Part }) {
  switch (part.type) {
    case "text":
      return <Folded text={part.text ?? ""} />;
    case "reasoning":
      return (
        <div className="flex gap-1.5 text-muted">
          <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <Folded text={part.text ?? ""} lines={3} />
        </div>
      );
    case "tool-call":
      return (
        <div className="rounded-md bg-panel-2/60 px-2 py-1.5">
          <div className="flex items-center gap-1.5 font-mono text-[12px]">
            <Wrench className="h-3 w-3 text-accent" /> {part.toolName}
          </div>
          <Folded text={asText(part.input)} mono lines={4} />
        </div>
      );
    case "tool-result": {
      const out = part.output as { type?: string; value?: unknown } | undefined;
      const error = out?.type === "error-text" || out?.type === "error-json";
      return (
        <div className={cn("rounded-md px-2 py-1.5", error ? "bg-err/5" : "bg-panel-2/60")}>
          <div className="mb-0.5 font-mono text-[11.5px] text-subtle">
            ← {part.toolName}
            {error && <span className="ml-1 text-err">error</span>}
          </div>
          <Folded text={asText(out && typeof out === "object" && "value" in out ? out.value : out)} mono lines={5} />
        </div>
      );
    }
    case "file":
    case "image":
      return <div className="text-[12px] text-muted">[{part.mediaType ?? part.type}{part.filename ? ` · ${part.filename}` : ""}]</div>;
    default:
      return <JsonView value={part} maxHeight="10rem" />;
  }
}

function MessageView({ message }: { message: Message }) {
  const role = ROLE[message.role] ?? { label: message.role, tone: "neutral" as const };
  const parts: Part[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  return (
    <div className="space-y-1.5 border-b border-line py-2.5 last:border-0">
      <Badge tone={role.tone}>{role.label}</Badge>
      {parts.map((p, i) => (
        <PartView key={i} part={p} />
      ))}
    </div>
  );
}

/**
 * A model step in the inspector: what Moka sent (the system prompt and
 * messages, the exact request body, the tools), or what came back.
 */
export function LlmStep({ event, wide }: { event: MokaEvent; wide?: boolean }) {
  const data = (event.data ?? {}) as {
    system?: string;
    messages?: Message[];
    body?: { tools?: unknown[]; [key: string]: unknown };
    output?: { reasoning?: string; text?: string; toolCalls?: Array<{ name: string; input: unknown }> };
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    finishReason?: string;
    warnings?: unknown[];
  };
  const [tab, setTab] = useState<"messages" | "raw" | "tools">("messages");
  const height = wide ? "none" : "60vh";

  if (event.kind === "llm.response") {
    const out = data.output;
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5 text-[12px]">
          {data.finishReason && <Badge>{data.finishReason}</Badge>}
          {data.usage?.inputTokens !== undefined && <Badge tone="info">{formatNumber(data.usage.inputTokens)} in</Badge>}
          {data.usage?.outputTokens !== undefined && <Badge tone="info">{formatNumber(data.usage.outputTokens)} out</Badge>}
        </div>
        {out && (out.reasoning || out.text || out.toolCalls?.length) ? (
          <div className="rounded-lg border border-line px-3">
            <MessageView
              message={{
                role: "assistant",
                content: [
                  ...(out.reasoning ? [{ type: "reasoning", text: out.reasoning }] : []),
                  ...(out.text ? [{ type: "text", text: out.text }] : []),
                  ...(out.toolCalls ?? []).map((c) => ({ type: "tool-call", toolName: c.name, input: c.input })),
                ],
              }}
            />
          </div>
        ) : (
          <p className="text-[13px] text-muted">No output recorded for this step.</p>
        )}
        <details>
          <summary className="cursor-pointer text-[11.5px] text-subtle">Raw</summary>
          <JsonView value={event.data} maxHeight={height} />
        </details>
      </div>
    );
  }

  const tools = Array.isArray(data.body?.tools) ? data.body!.tools : [];
  const messages = [...(data.system ? [{ role: "system", content: data.system }] : []), ...(data.messages ?? [])];
  return (
    <div className="space-y-2">
      <Tabs
        size="sm"
        value={tab}
        onChange={setTab}
        items={[
          { value: "messages", label: `Messages (${messages.length})` },
          { value: "raw", label: "Raw request" },
          { value: "tools", label: `Tools (${tools.length})` },
        ]}
      />
      {tab === "messages" &&
        (messages.length ? (
          <div className="rounded-lg border border-line px-3">
            {messages.map((m, i) => (
              <MessageView key={i} message={m} />
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-muted">This event was recorded before Moka kept the messages; run it again to see them.</p>
        ))}
      {tab === "raw" && (data.body ? <JsonView value={data.body} maxHeight={height} /> : <p className="text-[13px] text-muted">No request body recorded.</p>)}
      {tab === "tools" &&
        (tools.length ? (
          <div className="space-y-1">
            {tools.map((t: any, i) => {
              const fn = t?.function ?? t;
              return (
                <details key={i} className="rounded-md border border-line px-2 py-1.5">
                  <summary className="flex cursor-pointer items-center gap-1.5 font-mono text-[12px]">
                    <ChevronRight className="h-3 w-3 text-subtle" /> {fn?.name ?? `tool ${i + 1}`}
                  </summary>
                  <JsonView value={t} maxHeight="20rem" />
                </details>
              );
            })}
          </div>
        ) : (
          <p className="text-[13px] text-muted">No tools in this request.</p>
        ))}
      {data.warnings && data.warnings.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium tracking-wide text-warn uppercase">Warnings</div>
          <JsonView value={data.warnings} maxHeight="10rem" />
        </div>
      )}
    </div>
  );
}
