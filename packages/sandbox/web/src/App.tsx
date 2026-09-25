import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { setToken } from "./api";
import { ChatView } from "./components/Chat";
import { CompareView } from "./components/Compare";
import { Inspector } from "./components/Inspector";
import { InteractionCenter } from "./components/Interactions";
import { CommandPalette, ExportDialog, Sidebar, Toasts, TopBar } from "./components/Shell";
import { ToolRunner } from "./components/ToolRunner";
import { Button, Input, Spinner, cn } from "./components/ui";
import { Settings } from "./settings/Settings";
import { useStore } from "./store";

export function App() {
  const ready = useStore((s) => s.ready);
  const authError = useStore((s) => s.authError);
  const fatal = useStore((s) => s.fatal);
  const init = useStore((s) => s.init);
  const view = useStore((s) => s.view);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const presenter = useStore((s) => s.presenter);
  const set = useStore((s) => s.set);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const s = useStore.getState();
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        set({ paletteOpen: !s.paletteOpen });
      } else if (key === "j") {
        e.preventDefault();
        s.newChat();
      } else if (key === "b") {
        e.preventDefault();
        set({ sidebarOpen: !s.sidebarOpen });
      } else if (key === "i") {
        e.preventDefault();
        set({ inspectorOpen: !s.inspectorOpen });
      } else if (key === ".") {
        e.preventDefault();
        set({ presenter: !s.presenter });
      } else if (key === ",") {
        e.preventDefault();
        s.openSettings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [set]);

  if (authError) return <TokenGate />;
  if (fatal) {
    return (
      <Center>
        <p className="text-sm font-medium text-err">Could not reach the Moka server</p>
        <p className="mt-1 text-[13px] text-muted">{fatal}</p>
        <Button className="mt-4" variant="outline" onClick={() => location.reload()}>
          Retry
        </Button>
      </Center>
    );
  }
  if (!ready) {
    return (
      <Center>
        <Spinner className="h-5 w-5 text-accent" />
      </Center>
    );
  }

  return (
    <div className={cn("flex h-full flex-col", presenter && "presenter")}>
      <TopBar />
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && !presenter && view === "chat" && <Sidebar />}
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          {view === "chat" && <ChatView />}
          {view === "compare" && <CompareView />}
          {view === "tools" && <ToolRunner />}
        </main>
        {inspectorOpen && !presenter && (
          <aside className="hidden w-[380px] shrink-0 border-l border-line bg-panel/60 md:block">
            <Inspector />
          </aside>
        )}
      </div>
      <Settings />
      <ExportDialog />
      <CommandPalette />
      <InteractionCenter />
      <Toasts />
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center p-6 text-center">{children}</div>;
}

function TokenGate() {
  const [value, setValue] = useState("");
  return (
    <Center>
      <div className="w-full max-w-sm rounded-2xl border border-line bg-panel p-6 text-left shadow-soft">
        <img src="/favicon.svg" alt="" className="mb-4 h-10 w-10 rounded-xl" />
        <h1 className="text-[15px] font-semibold">Access token required</h1>
        <p className="mt-1 text-[13px] text-muted">Open the link printed in your terminal, or paste the token below.</p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setToken(value.trim());
            location.reload();
          }}
        >
          <Input mono value={value} onChange={(e) => setValue(e.target.value)} placeholder="token" autoFocus />
          <Button variant="primary" icon={<KeyRound className="h-4 w-4" />} disabled={!value.trim()}>
            Unlock
          </Button>
        </form>
      </div>
    </Center>
  );
}
