import { ArrowUpRight } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import puppy from "../moka-puppy.svg?raw";
import { DOCS_URL, REPO_URL } from "../links";
import { useStore } from "../store";
import { cn } from "./ui";

/**
 * `idle` breathes, blinks and wags; `still` only blinks (the header logo).
 * `prefers-reduced-motion` and the "Animate Moka" preference stop it all.
 */
export type MokaMood = "idle" | "still";

/** Crops of the drawing: the whole pup, just the face for the header, and the portrait. */
const FULL = puppy;
const FACE = puppy.replace('viewBox="0 0 164 128"', 'viewBox="44 12 76 64"');
const PORTRAIT = puppy.replace('viewBox="0 0 164 128"', 'viewBox="36 4 92 92"');

/** Whether to show Moka's branding (the puppy, the name, the star link): the "Moka branding" preference. */
export function useMokaBranding(): boolean {
  return useStore((s) => s.config.ui?.branding !== false);
}

/** Whether Moka may move: the "Animate Moka" preference, and the OS reduced-motion setting. */
export function useMokaMotion(): boolean {
  const enabled = useStore((s) => s.config.ui?.animations !== false);
  const [reduced, setReduced] = useState(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return enabled && !reduced;
}

/** A small Moka. */
export function Moka({
  className,
  mood = "idle",
  face = false,
  style,
}: {
  className?: string;
  mood?: MokaMood;
  /** Show only the face (the header). */
  face?: boolean;
  style?: CSSProperties;
}) {
  const motion = useMokaMotion();
  return (
    <span
      aria-hidden
      className={cn("block [&>svg]:h-full [&>svg]:w-full", !motion ? "mood-off" : mood !== "idle" && `mood-${mood}`, className)}
      style={style}
      dangerouslySetInnerHTML={{ __html: face ? FACE : FULL }}
    />
  );
}

/**
 * Moka in a round window, like a profile picture that notices you: its eyes
 * follow the pointer and hovering pets it (happy eyes, perked ears). A click
 * boops it and opens a small card: what Moka is, its version, and links.
 * Still when motion is off; the card opens either way.
 */
export function MokaPortrait({ className }: { className?: string }) {
  const motion = useMokaMotion();
  const ref = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [petted, setPetted] = useState(false);
  const [booped, setBooped] = useState(false);
  const [open, setOpen] = useState(false);
  const version = useStore((s) => s.version);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    const el = ref.current;
    if (!motion || !el) return;
    let frame = 0;
    const look = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height * 0.4);
        const distance = Math.hypot(dx, dy) || 1;
        const reach = Math.min(1, distance / 240);
        el.style.setProperty("--look-x", ((dx / distance) * reach).toFixed(3));
        el.style.setProperty("--look-y", ((dy / distance) * reach).toFixed(3));
      });
    };
    window.addEventListener("pointermove", look);
    return () => {
      window.removeEventListener("pointermove", look);
      cancelAnimationFrame(frame);
      el.style.removeProperty("--look-x");
      el.style.removeProperty("--look-y");
    };
  }, [motion]);

  // The card closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const click = () => {
    setOpen((o) => !o);
    if (!motion) return;
    setBooped(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setBooped(false), 450);
  };

  return (
    <div ref={wrap} className={cn("relative w-fit", className)}>
      <button
        ref={ref}
        type="button"
        title="About Moka"
        aria-label="About Moka"
        aria-expanded={open}
        onPointerEnter={() => motion && setPetted(true)}
        onPointerLeave={() => setPetted(false)}
        onClick={click}
        className={cn(
          "relative block h-24 w-24 cursor-pointer overflow-hidden rounded-full bg-gradient-to-b from-panel-2 to-panel ring-1 ring-line transition-[box-shadow] duration-200",
          (petted || open) && "ring-2 ring-accent",
          booped && "moka-boop",
        )}
      >
        <span
          aria-hidden
          className={cn("absolute inset-0 translate-y-[8%] [&>svg]:h-full [&>svg]:w-full", !motion && "mood-off", (petted || booped) && "petted")}
          dangerouslySetInnerHTML={{ __html: PORTRAIT }}
        />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="About Moka"
          className="moka-card absolute top-full left-1/2 z-30 mt-3 w-72 -translate-x-1/2 rounded-xl border border-line bg-elev p-4 text-left shadow-soft"
        >
          <div className="flex items-center gap-2.5">
            <img src="/favicon.svg" alt="" className="h-7 w-7 rounded-lg" />
            <span className="text-[14px] font-semibold tracking-tight">Moka</span>
            {version && <span className="ml-auto rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-subtle">v{version}</span>}
          </div>
          <p className="mt-2 text-[12.5px] leading-relaxed text-muted">See what your agent and your MCP servers do: every model step, tool call and message, on your machine.</p>
          <div className="mt-3 flex items-center gap-3 border-t border-line pt-3 text-[12.5px]">
            <CardLink href={`${REPO_URL}/releases`}>What's new</CardLink>
            <CardLink href={DOCS_URL}>Docs</CardLink>
            <CardLink href={REPO_URL}>GitHub</CardLink>
          </div>
        </div>
      )}
    </div>
  );
}

function CardLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-muted transition-colors hover:text-accent">
      {children}
      <ArrowUpRight className="h-3 w-3" />
    </a>
  );
}
