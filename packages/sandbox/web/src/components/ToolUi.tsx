import { useCallback } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { Part } from "../types";
import { A2uiSurfaces, type A2uiAction } from "./A2uiSurface";
import { McpAppFrame } from "./McpAppFrame";

type ToolPart = Extract<Part, { type: "tool" }>;

/** Renders whatever UI a tool call produced: MCP App, MCP-UI or A2UI. */
export function ToolUi({ part, interactive = true }: { part: ToolPart; interactive?: boolean }) {
  const send = useStore((s) => s.send);
  const streaming = useStore((s) => s.streaming);
  const toast = useStore((s) => s.toast);

  const onAction = useCallback(
    (action: A2uiAction) => {
      void api("/api/events/ui", { body: { kind: "ui.action", title: `A2UI action · ${action.name}`, data: action } }).catch(() => {});
      if (!interactive) return;
      if (streaming) {
        toast("Wait for the current reply to finish", "error");
        return;
      }
      const pretty = action.name.replace(/[_-]+/g, " ");
      void send(`[ui action] ${JSON.stringify(action)}`, { display: `▸ ${pretty}`, via: "a2ui" });
    },
    [interactive, send, streaming, toast],
  );

  const ui = part.ui;
  if (!ui) return null;
  if (ui.kind === "a2ui") return <A2uiSurfaces messages={ui.messages} onAction={onAction} header={part.source !== "generative UI"} />;
  return <McpAppFrame ui={ui} toolName={part.tool} input={part.input} raw={part.raw} running={part.status === "running"} />;
}
