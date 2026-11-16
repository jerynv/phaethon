import { animate, motion, useMotionValue, useReducedMotion, type AnimationPlaybackControls } from "motion/react";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A list's selected-row fill as one element that glides from row to row,
 * the way Settings' section nav always has. Rows in a glide list drop their
 * own selected fill (`data-glide` with `data-active`) and the list draws one
 * `bg-row-selected` under them. Hover fills stay plain CSS on the rows.
 *
 * - `RowHighlightGroup` wraps a short list, finds its `[data-glide][data-active]`
 *   row in the DOM and keeps the fill under it.
 * - `RowHighlight` takes the row's place directly, for a windowed list that
 *   knows where its rows sit without measuring them.
 *
 * The fill glides (a spring) only when the selection moves from one row on
 * screen to another; it appears in place when a row becomes selected from
 * nothing, when `instant` is set (a list swapped wholesale), when either row is
 * scrolled out of view, and under reduced motion. Scrolling never re-renders
 * it: it sits in the scrolling content and moves with the rows.
 */

/** The glide's spring (docs/UI-REBUILD.md Motion: stiffness 420–520, damping 32–42). */
export const ROW_GLIDE = { type: "spring", stiffness: 480, damping: 38 } as const;

/** True inside a `RowHighlightGroup`: `SidebarMenuButton` rows there leave the selected fill to the group. */
export const RowGlideContext = React.createContext(false);

export type RowBox = { top: number; height: number; left?: number; width?: number };

const ROW_SELECTOR = "[data-glide][data-active]";

const sameBox = (a: RowBox, b: RowBox) => a.top === b.top && a.height === b.height && a.left === b.left && a.width === b.width;

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

/** Both the old place (`delta` above or below the new one) and the new one are at least partly in the scrolled view. */
function bothOnScreen(el: HTMLElement, delta: number, height: number): boolean {
  const view = scrollParent(el)?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
  const r = el.getBoundingClientRect();
  const seen = (top: number) => top + height > view.top && top < view.bottom;
  return seen(r.top) && seen(r.top + delta);
}

type RowHighlightProps = {
  /** The selected row's identity; a new one glides, the same one follows its row. */
  id: unknown;
  /** Where the row sits in the list's box (the list is `relative isolate`), or null for none. */
  box: RowBox | null;
  /** Place without gliding (the list is being swapped wholesale). */
  instant?: boolean;
  /** Carry `data-slide` so the windowed list's CSS slides it with its row (and holds it when the list holds). */
  slide?: boolean;
} & Omit<React.ComponentProps<"div">, "id" | "children">;

/** Equal boxes and styles count as unchanged, so a list re-rendering on every scroll step never re-renders its highlight. */
function sameProps(a: RowHighlightProps, b: RowHighlightProps): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof RowHighlightProps>;
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (k === "box" && x && y && sameBox(x as RowBox, y as RowBox)) continue;
    if (k === "style" && x && y && shallowEqual(x as object, y as object)) continue;
    return false;
  }
  return true;
}

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

export const RowHighlight = React.memo(function RowHighlight({ id, box, instant = false, slide = false, className, style, ...props }: RowHighlightProps) {
  const reduce = useReducedMotion();
  const ref = React.useRef<HTMLDivElement>(null);
  const offset = useMotionValue(0);
  const height = useMotionValue(box?.height ?? 0);
  const prev = React.useRef<{ id: unknown; top: number } | null>(null);
  const running = React.useRef<AnimationPlaybackControls[]>([]);
  // A new row jumps the box to it in this commit (no CSS slide); the fill inside then springs over from where it was.
  const snap = !box || prev.current?.id !== id;
  const top = box?.top;
  const h = box?.height;

  React.useLayoutEffect(() => {
    const stop = () => {
      for (const a of running.current) a.stop();
      running.current = [];
    };
    const p = prev.current;
    if (top === undefined || h === undefined) {
      stop();
      offset.jump(0);
      prev.current = null;
      return;
    }
    prev.current = { id, top };
    if (p && p.id === id) {
      if (!running.current.length) height.jump(h);
      return;
    }
    const delta = p ? p.top + offset.get() - top : 0;
    const el = ref.current;
    stop();
    if (!p || instant || reduce || !el || !bothOnScreen(el, delta, h)) {
      offset.jump(0);
      height.jump(h);
      return;
    }
    offset.jump(delta);
    running.current = [animate(offset, 0, ROW_GLIDE), animate(height, h, ROW_GLIDE)];
  }, [id, top, h, instant, reduce, offset, height]);

  React.useEffect(
    () => () => {
      for (const a of running.current) a.stop();
    },
    [],
  );

  return (
    <div
      ref={ref}
      aria-hidden
      data-slot="row-highlight"
      data-slide={slide && !snap ? "" : undefined}
      className={cn("pointer-events-none absolute -z-10", box?.left === undefined && "inset-x-0", !box && "hidden", className)}
      style={{ top: box?.top ?? 0, height: box?.height ?? 0, left: box?.left, width: box?.width, ...style }}
      {...props}
    >
      <motion.div className="w-full rounded-md bg-row-selected" style={{ y: offset, height }} />
    </div>
  );
}, sameProps);

/** A short list of rows with one gliding selected fill. Mark rows with `data-glide` and `data-active` (`SidebarMenuButton` does it here). */
export function RowHighlightGroup({ className, children, ...props }: React.ComponentProps<"div">) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [sel, setSel] = React.useState<{ row: HTMLElement; box: RowBox } | null>(null);
  const measure = React.useCallback(() => {
    const g = ref.current;
    if (!g) return;
    const row = g.querySelector<HTMLElement>(ROW_SELECTOR);
    if (!row) {
      setSel(null);
      return;
    }
    const gr = g.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const box = { top: r.top - gr.top - g.clientTop + g.scrollTop, left: r.left - gr.left - g.clientLeft + g.scrollLeft, height: r.height, width: r.width };
    setSel((s) => (s && s.row === row && sameBox(s.box, box) ? s : { row, box }));
  }, []);
  // After every render (a selection usually comes with one), and when anything inside changes size or selection on its own.
  React.useLayoutEffect(measure);
  React.useLayoutEffect(() => {
    const g = ref.current;
    if (!g) return;
    const ro = new ResizeObserver(measure);
    ro.observe(g);
    const mo = new MutationObserver(measure);
    mo.observe(g, { subtree: true, childList: true, attributeFilter: ["data-active"] });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [measure]);
  return (
    <RowGlideContext value={true}>
      <div ref={ref} data-slot="row-highlight-group" className={cn("relative isolate", className)} {...props}>
        <RowHighlight id={sel?.row} box={sel?.box ?? null} />
        {children}
      </div>
    </RowGlideContext>
  );
}
