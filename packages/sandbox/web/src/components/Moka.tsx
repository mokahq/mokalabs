import { Coffee } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import puppy from "../moka-puppy.svg?raw";
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
 * follow the pointer, hovering pets it (happy eyes, perked ears, tongue out),
 * and a click is peekaboo: Moka ducks and a "moka" sign pops up. Still when
 * motion is off.
 */
export function MokaPortrait({ className }: { className?: string }) {
  const motion = useMokaMotion();
  const ref = useRef<HTMLButtonElement>(null);
  const [petted, setPetted] = useState(false);
  const [peek, setPeek] = useState(false);
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

  const peekaboo = () => {
    if (!motion || peek) return;
    setPeek(true);
    timer.current = setTimeout(() => setPeek(false), 1500);
  };

  return (
    <button
      ref={ref}
      type="button"
      title="Moka"
      aria-label="Moka the puppy"
      onPointerEnter={() => motion && setPetted(true)}
      onPointerLeave={() => setPetted(false)}
      onClick={peekaboo}
      className={cn(
        "relative block h-24 w-24 overflow-hidden rounded-full bg-gradient-to-b from-panel-2 to-panel ring-1 ring-line transition-[box-shadow] duration-200",
        petted && "ring-2 ring-accent",
        motion ? "cursor-pointer" : "cursor-default",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 transition-transform duration-300 ease-in-out [&>svg]:h-full [&>svg]:w-full",
          !motion && "mood-off",
          petted && !peek && "petted",
          peek ? "translate-y-full" : "translate-y-[8%]",
        )}
        dangerouslySetInnerHTML={{ __html: PORTRAIT }}
      />
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-[#1c1411] text-[#f8c47e] transition-transform duration-300 ease-in-out",
          peek ? "translate-y-0 delay-200" : "translate-y-full",
        )}
      >
        <Coffee className="h-6 w-6" strokeWidth={1.8} />
        <span className="text-[15px] font-bold tracking-tight">moka</span>
      </span>
    </button>
  );
}
