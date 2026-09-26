import { useRef } from "react";
import svg from "../dino-animated.svg?raw";
import { cn } from "./ui";

/** Moka, animated: blinks, sips coffee, breathes fire now and then. Click to make it roar. */
export function Dino({ className }: { className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const roar = () => {
    const el = ref.current;
    if (!el) return;
    clearTimeout(timer.current);
    el.classList.remove("roar");
    void el.offsetWidth; // restart the CSS animations
    el.classList.add("roar");
    timer.current = setTimeout(() => el.classList.remove("roar"), 5000);
  };
  return (
    <button
      ref={ref}
      type="button"
      onClick={roar}
      title="Moka (click me)"
      aria-label="Moka the dino. Click to breathe fire."
      className={cn("block cursor-pointer [&>svg]:h-full [&>svg]:w-full", className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
