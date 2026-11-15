import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Small motion pieces Study's screens share: a box whose height follows its
 * content, and a keyed swap that slides one way or the other. Short (≤ 200
 * ms), ease-out, interruptible; nothing moves when reduced motion is asked.
 */

export const EASE = [0.22, 1, 0.36, 1] as const;

/** Grows and shrinks with its content instead of jumping. */
export function AutoHeight({ children, className }: { children: ReactNode; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | "auto">("auto");
  const reduce = useReducedMotion();
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <motion.div className={cn("overflow-hidden", className)} initial={false} animate={{ height: h }} transition={reduce ? { duration: 0 } : { duration: 0.2, ease: EASE }}>
      <div ref={inner}>{children}</div>
    </motion.div>
  );
}

/** Swaps keyed content with a short slide: `dir` 1 forward, -1 back. */
export function Slide({ id, dir = 1, children, className }: { id: string; dir?: 1 | -1; children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  const d = reduce ? 0 : 10 * dir;
  return (
    <AnimatePresence mode="popLayout" initial={false} custom={d}>
      <motion.div
        key={id}
        className={className}
        custom={d}
        variants={{ in: (x: number) => ({ opacity: 0, x }), on: { opacity: 1, x: 0 }, out: (x: number) => ({ opacity: 0, x: -x }) }}
        initial="in"
        animate="on"
        exit="out"
        transition={{ duration: reduce ? 0 : 0.16, ease: EASE }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
