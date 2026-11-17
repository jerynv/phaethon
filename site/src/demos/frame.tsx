import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import "../stage/look.css";

/** A demo's design sizes, which its Stage gets too, so the box it draws into is reserved exactly. */
export type Size = { width: number; height: number; compact: { below: number; width: number; height: number } };

/**
 * Where a demo plays. The prerendered page holds its box at the stage's own
 * proportions (the compact ones below its breakpoint, by container query) and
 * a plain description for anyone not seeing it, so nothing on the page moves
 * when the stage mounts. The stage itself mounts in the browser, once the box
 * is close to the screen.
 */
export function DemoFrame({ size, label, className, children }: { size: Size; label: string; className?: string; children: () => ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true);
        io.disconnect();
      }
    }, { rootMargin: "50% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const { width, height, compact } = size;
  return (
    <figure
      className={cn("ph-frame ph-look relative mx-auto w-full [container-type:inline-size]", className)}
      style={{ maxWidth: width, ["--w" as string]: width, ["--h" as string]: height, ["--cw" as string]: compact.width, ["--ch" as string]: compact.height }}
    >
      <div ref={box} role="img" aria-label={label} className="ph-frame__box">
        {/* What's drawn inside is a picture of the app, not part of this page: the label above says what it shows. */}
        <div aria-hidden className="contents">
          {near ? children() : <div className="ph-frame__ground" />}
        </div>
      </div>
    </figure>
  );
}
