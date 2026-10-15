import { useEffect, useState } from "react";
import { renderMermaid } from "../mermaid";
import { useStore } from "../store";
import { Spinner, cn } from "./ui";

/** A Mermaid diagram, drawn when shown (the library loads on first use). */
export function MermaidDiagram({ code, className }: { code: string; className?: string }) {
  const dark = useStore((s) => s.theme === "dark");
  const [state, setState] = useState<{ svg?: string; error?: string }>({});
  useEffect(() => {
    let cancelled = false;
    renderMermaid(code, dark)
      .then((svg) => !cancelled && setState({ svg }))
      .catch((e) => !cancelled && setState({ error: String(e?.message ?? e).split("\n")[0] }));
    return () => {
      cancelled = true;
    };
  }, [code, dark]);
  if (state.error) return <p className="text-[12px] text-err">Couldn't draw this diagram: {state.error}</p>;
  if (!state.svg) return <Spinner className="h-4 w-4 text-accent" />;
  return <div className={cn("mermaid-diagram max-w-full overflow-auto", className)} dangerouslySetInnerHTML={{ __html: state.svg }} />;
}
