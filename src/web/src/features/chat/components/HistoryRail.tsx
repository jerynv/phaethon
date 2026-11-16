// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT. See THIRD_PARTY_NOTICES.md. After its timeline minimap.
import { type MouseEvent, type RefObject, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The conversation's history as a rail in the chat's left gutter, in place of
 * a scrollbar: one strip per message you sent. The strips of the turns on
 * screen are dark; hovering the rail previews a turn (your message and the
 * reply's last words) and clicking jumps to it. Arrows above and below step
 * through turns; the keyboard walks it too. Turns are found by their
 * `data-turn` attribute in the scroll box.
 */
export type RailItem = { id: string; userText: string; assistantText: string | null };

const SPACING = 8;
const MIN_ITEMS = 2;
const TARGET_OFFSET = 24;
const PERSISTENT_GUTTER = 48;
const HIT_LEFT = 12;
const HIT_MAX = 40;

type Geometry = { inView: boolean[]; current: number | null; atEnd: boolean; gutter: number };

function measure(box: HTMLElement, items: RailItem[]): Geometry {
  const boxTop = box.getBoundingClientRect().top;
  // One query for every turn (a long conversation has hundreds), then a lookup per item.
  const found = new Map<string, number>();
  for (const el of box.querySelectorAll<HTMLElement>("[data-turn]")) found.set(el.dataset.turn!, el.getBoundingClientRect().top - boxTop + box.scrollTop);
  const tops = items.map((it) => found.get(it.id) ?? Number.POSITIVE_INFINITY);
  const top = box.scrollTop;
  const bottom = top + box.clientHeight;
  const inView = tops.map((t, i) => {
    const next = tops[i + 1] ?? box.scrollHeight;
    return t < bottom && next > top;
  });
  // The turn being read: the first still on screen below the line a jump leaves its turn at (as T3 Code
  // does), so right after a jump the turn jumped to is current and Next goes to the one after it.
  let current: number | null = null;
  for (let i = 0; i < tops.length; i++) {
    const end = tops[i + 1] ?? box.scrollHeight;
    if (tops[i]! < bottom && end > top + TARGET_OFFSET + 1) {
      current = i;
      break;
    }
  }
  const column = Math.min(box.clientWidth, Number.parseFloat(getComputedStyle(box).getPropertyValue("--chat-max-width")) || box.clientWidth);
  return { inView, current, atEnd: box.scrollHeight - top - box.clientHeight <= 1, gutter: Math.max(0, (box.clientWidth - column) / 2) };
}

export function HistoryRail({
  box,
  items,
  onJump,
  onWheel,
  reveal,
}: {
  box: RefObject<HTMLDivElement | null>;
  items: RailItem[];
  /** Shows `turn` `offset` px below the top of the view (the timeline decides how it travels). */
  onJump: (turn: HTMLElement, offset: number) => void;
  /** A wheel over the rail, for the timeline to scroll by. */
  onWheel: (deltaY: number) => void;
  /** Mounts every turn, for a jump to one a long conversation hasn't mounted yet. */
  reveal: () => void;
}) {
  const [geo, setGeo] = useState<Geometry>({ inView: [], current: null, atEnd: true, gutter: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || items.length < MIN_ITEMS) return;
    const refresh = () => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (box.current) setGeo(measure(box.current, items));
      });
    };
    refresh();
    el.addEventListener("scroll", refresh, { passive: true });
    const ro = new ResizeObserver(refresh);
    ro.observe(el);
    const mo = new MutationObserver(refresh);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      el.removeEventListener("scroll", refresh);
      ro.disconnect();
      mo.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [box, items]);

  if (items.length < MIN_ITEMS) return null;

  const jump = (index: number) => {
    const it = items[index];
    if (!box.current || !it) return;
    const sel = `[data-turn="${CSS.escape(it.id)}"]`;
    if (!box.current.querySelector(sel)) reveal();
    const turn = box.current.querySelector<HTMLElement>(sel);
    if (turn) onJump(turn, TARGET_OFFSET);
  };
  const indexAt = (e: MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.height <= 0) return 0;
    const p = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    return Math.round(p * (items.length - 1));
  };
  const topOf = (i: number) => (items.length <= 1 ? 0 : (i / (items.length - 1)) * 100);
  const persistent = geo.gutter >= PERSISTENT_GUTTER;
  const hit = Math.max(0, Math.min(HIT_MAX, Math.floor(geo.gutter) - HIT_LEFT));
  const active = hover !== null && hover < items.length ? items[hover]! : null;
  const prev = geo.current !== null && geo.current > 0 ? geo.current - 1 : null;
  const next = geo.current !== null && !geo.atEnd && geo.current + 1 < items.length ? geo.current + 1 : null;

  return (
    <div
      data-slot="history-rail"
      className={cn(
        "group/rail pointer-events-none absolute inset-y-0 left-0 z-10 w-18",
        persistent ? "opacity-100" : "hidden opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100 [@media(pointer:fine)]:block",
      )}
      onWheel={(e) => onWheel(e.deltaY)}
    >
      <div className={cn("absolute top-1/2 left-3 -translate-y-1/2 select-none", hit > 0 ? "pointer-events-auto" : "pointer-events-none")} style={{ height: `min(${Math.max(1, (items.length - 1) * SPACING)}px, max(4rem, calc(100% - 14.75rem)))`, width: hit }}>
        <RailArrow direction="previous" disabled={prev === null} onClick={() => prev !== null && jump(prev)} />
        <button
          type="button"
          aria-label={active ? `Jump to: ${active.userText || "your message"}` : "Conversation history"}
          className="absolute inset-y-0 left-0 w-full cursor-pointer before:absolute before:inset-x-0 before:-inset-y-1 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset"
          onMouseMove={(e) => setHover(indexAt(e))}
          onMouseLeave={() => setHover(null)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => jump(indexAt(e))}
          onFocus={() => setHover((h) => h ?? geo.current ?? 0)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            const move = (d: number) => setHover((h) => Math.max(0, Math.min(items.length - 1, (h ?? 0) + d)));
            if (e.key === "ArrowDown") move(1);
            else if (e.key === "ArrowUp") move(-1);
            else if (e.key === "Home") setHover(0);
            else if (e.key === "End") setHover(items.length - 1);
            else if ((e.key === "Enter" || e.key === " ") && hover !== null) jump(hover);
            else return;
            e.preventDefault();
          }}
        >
          <span aria-hidden className="absolute top-0 left-3 h-full w-px bg-border/40" />
          {items.map((it, i) => {
            const d = hover === null ? null : Math.abs(i - hover);
            return (
              <span
                key={it.id}
                aria-hidden
                data-in-view={geo.inView[i] ? "true" : "false"}
                className={cn(
                  "pointer-events-none absolute left-0 h-0.5 w-6 origin-left -translate-y-1/2 rounded-full transition-transform duration-150",
                  geo.inView[i] ? "bg-foreground/60" : d === 0 ? "bg-muted-foreground/60" : "bg-muted-foreground/25",
                  d === 0 ? "scale-x-100" : d === 1 ? "scale-x-[0.667]" : d === 2 ? "scale-x-[0.417]" : "scale-x-[0.333]",
                )}
                style={{ top: `${topOf(i)}%` }}
              />
            );
          })}
          {active ? (
            <span className="pointer-events-none absolute left-8 w-80 -translate-y-1/2" style={{ top: `${topOf(hover!)}%` }}>
              <span className="block rounded-xl border bg-popover p-3 text-left text-popover-foreground shadow-popup">
                <span className="block truncate font-medium text-sm">{active.userText || "Your message"}</span>
                {active.assistantText ? <span className="mt-1 line-clamp-3 text-muted-foreground text-sm">{active.assistantText}</span> : null}
              </span>
            </span>
          ) : null}
        </button>
        <RailArrow direction="next" disabled={next === null} onClick={() => next !== null && jump(next)} />
      </div>
    </div>
  );
}

function RailArrow({ direction, disabled, onClick }: { direction: "previous" | "next"; disabled: boolean; onClick: () => void }) {
  const previous = direction === "previous";
  const label = previous ? "Previous turn" : "Next turn";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn("pointer-events-auto absolute left-1 z-10 inline-flex -translate-x-1/2 opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100 focus-within:opacity-100", previous ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]")} />
        }
      >
        <Button aria-label={label} disabled={disabled} onClick={onClick} size="icon-micro" type="button" variant="ghost-muted">
          <Icon icon={previous ? icons.chevronUp : icons.chevronDown} className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipPopup side={previous ? "top" : "bottom"}>{label}</TooltipPopup>
    </Tooltip>
  );
}
