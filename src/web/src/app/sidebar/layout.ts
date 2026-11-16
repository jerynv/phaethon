import type { ThreadRow } from "../store";

/**
 * The sidebar's conversation list as plain data, so it can be grouped,
 * laid out and windowed without touching the DOM (and tested in Node).
 *
 * Each space's conversations are grouped by recency, as the references'
 * Recents are: Pinned, Today, Yesterday, Previous 7 days, Previous 30 days,
 * then one group per month ("October", or "October 2025" in an earlier year).
 * `layoutSpaces` flattens every space into one list of fixed-height items
 * (space rows, group labels, conversations, skeletons, notes) with their
 * offsets, plus the sections and groups that hold them, so the sidebar can
 * render only what is on screen and keep the labels sticky.
 */

/** Height of a row's slot: a 28 px row and the 1 px gap under it. */
export const ROW = 29;
/** A group label (28 px); every label after a space's first has 8 px of air above it. */
export const LABEL = 28;
export const LABEL_GAP = 8;
/** Space between two spaces. */
export const SPACE_GAP = 12;
/** What the sticky space row and group label cover at the top of the list. */
export const STICKY = LABEL * 2;
/** What sticks at the top of a list without space rows: the group label alone. */
export const STICKY_SINGLE = LABEL;

export type ThreadGroup = { key: string; label: string; rows: ThreadRow[] };

/** Local midnight of `t`'s day, `days` days later (negative for earlier); DST-safe. */
function dayStart(t: number, days = 0): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  if (days) d.setDate(d.getDate() + days);
  return d.getTime();
}

/** Newest first; ties by id, newest id first, as the core pages them. */
export function byRecency(a: ThreadRow, b: ThreadRow): number {
  return b.updated - a.updated || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * The groups `rows` fall into at time `now`, in order, empty ones left out.
 * Pinned ones lead in the order they were pinned; the rest are newest first.
 * A time in the future (another computer's clock) counts as today.
 */
export function groupThreads(rows: readonly ThreadRow[], now: number, locale?: string): ThreadGroup[] {
  const today = dayStart(now);
  const bounds: Array<{ key: string; label: string; from: number }> = [
    { key: "today", label: "Today", from: today },
    { key: "yesterday", label: "Yesterday", from: dayStart(now, -1) },
    { key: "week", label: "Previous 7 days", from: dayStart(now, -7) },
    { key: "month", label: "Previous 30 days", from: dayStart(now, -30) },
  ];
  const pinned = rows.filter((t) => t.pinned).sort((a, b) => a.pinned! - b.pinned! || byRecency(a, b));
  const rest = rows.filter((t) => !t.pinned).sort(byRecency);
  const groups: ThreadGroup[] = pinned.length ? [{ key: "pinned", label: "Pinned", rows: pinned }] : [];
  const year = new Date(now).getFullYear();
  const months = new Map<string, Intl.DateTimeFormat>();
  const fmt = (withYear: boolean) => {
    const k = withYear ? "y" : "m";
    let f = months.get(k);
    if (!f) months.set(k, (f = new Intl.DateTimeFormat(locale, withYear ? { month: "long", year: "numeric" } : { month: "long" })));
    return f;
  };
  let cur: ThreadGroup | undefined;
  let b = 0;
  for (const t of rest) {
    let key: string;
    let label: string;
    while (b < bounds.length && t.updated < bounds[b]!.from) b++;
    if (b < bounds.length) {
      ({ key, label } = bounds[b]!);
    } else {
      const d = new Date(t.updated);
      key = `${d.getFullYear()}-${d.getMonth()}`;
      label = fmt(d.getFullYear() !== year).format(d);
    }
    if (cur?.key !== key) groups.push((cur = { key, label, rows: [] }));
    cur.rows.push(t);
  }
  return groups;
}

/** A cursor's position (`<updated>:<id>`, as the core gives it); null when it isn't one. */
export function cursorPosition(cursor: string | null | undefined): { updated: number; id: string } | null {
  if (!cursor) return null;
  const at = cursor.indexOf(":");
  if (at < 1) return null;
  const updated = Number(cursor.slice(0, at));
  return Number.isFinite(updated) ? { updated, id: cursor.slice(at + 1) } : null;
}

/** Lower-case, one space between words, as the core folds titles for a search (src/server/threads/page.ts). */
export function foldTitle(s: string): string {
  return s.normalize("NFKC").toLocaleLowerCase().split(/\s+/u).filter(Boolean).join(" ");
}

// ---- Layout ----------------------------------------------------------------------

export type SpaceInput = {
  id: string;
  /** Header only: the space is folded away. */
  collapsed: boolean;
  /** Nothing listed yet: skeletons while it loads, an error row when it failed. */
  status: "loading" | "error" | "ready";
  rows: readonly ThreadRow[];
  /** More conversations past the loaded ones, from `cursor` on. */
  hasMore: boolean;
  cursor: string | null;
  /** What to say when there are no rows. */
  empty: string;
};

export type ItemKind = "space" | "label" | "row" | "loader" | "skeleton" | "note" | "error";

export type Item = {
  key: string;
  kind: ItemKind;
  space: string;
  start: number;
  size: number;
  section: number;
  /** The group it sits in (-1 for the space row). */
  group: number;
  thread?: ThreadRow;
  text?: string;
};

export type Block = {
  key: string;
  /** No label for a block of skeletons, a note or an error. */
  label?: string;
  start: number;
  end: number;
  /** Item indexes [from, to). The label, when there is one, is `from`. */
  from: number;
  to: number;
};

export type Section = { space: string; start: number; end: number; from: number; to: number; blocks: Block[] };

export type Layout = { items: Item[]; sections: Section[]; size: number; index: Map<string, number> };

export const threadKey = (space: string, id: string) => `row:${space}/${id}`;

/**
 * Every space, one after another: its row (unless `headers` is false), then (unless folded) its groups,
 * each a label and its conversations. While there are more to load, a
 * skeleton row (`loader`) follows the last conversation that is part of the
 * loaded run; conversations read on their own from further back (one opened
 * from search) come after it, in their own month.
 */
export function layoutSpaces(spaces: readonly SpaceInput[], now: number, locale?: string, opts: { headers?: boolean } = {}): Layout {
  const headers = opts.headers ?? true;
  const items: Item[] = [];
  const sections: Section[] = [];
  const index = new Map<string, number>();
  let y = 0;
  spaces.forEach((sp, si) => {
    if (si > 0) y += SPACE_GAP;
    const section: Section = { space: sp.id, start: y, end: y, from: items.length, to: items.length, blocks: [] };
    const push = (it: Omit<Item, "start" | "section" | "space">) => {
      index.set(it.key, items.length);
      items.push({ ...it, start: y, section: si, space: sp.id });
      y += it.size;
    };
    // One space on its own (the switcher names it) lists its conversations without a row of its own.
    if (headers) push({ key: `space:${sp.id}`, kind: "space", size: ROW, group: -1 });
    const block = (label: string | undefined, key: string, fill: () => void) => {
      const b: Block = { key, label, start: y, end: y, from: items.length, to: items.length };
      const g = section.blocks.length;
      section.blocks.push(b);
      if (label !== undefined) {
        const gap = section.blocks.some((x, i) => i < g && x.label !== undefined) ? LABEL_GAP : 0;
        push({ key: `label:${sp.id}:${key}`, kind: "label", size: LABEL + gap, group: g, text: label });
      }
      fill();
      b.end = y;
      b.to = items.length;
    };
    if (!sp.collapsed) {
      if (sp.status === "loading" && !sp.rows.length) {
        block(undefined, "loading", () => {
          for (let i = 0; i < 3; i++) push({ key: `skeleton:${sp.id}:${i}`, kind: "skeleton", size: ROW, group: section.blocks.length - 1 });
        });
      } else if (sp.status === "error" && !sp.rows.length) {
        block(undefined, "error", () => push({ key: `error:${sp.id}`, kind: "error", size: ROW, group: section.blocks.length - 1 }));
      } else if (!sp.rows.length) {
        if (sp.hasMore) block(undefined, "more", () => push({ key: `loader:${sp.id}`, kind: "loader", size: ROW, group: section.blocks.length - 1 }));
        else block(undefined, "empty", () => push({ key: `note:${sp.id}`, kind: "note", size: ROW, group: section.blocks.length - 1, text: sp.empty }));
      } else {
        const groups = groupThreads(sp.rows, now, locale);
        // The loader goes after the last conversation inside the loaded run.
        const c = sp.hasMore ? cursorPosition(sp.cursor) : null;
        let loaderAfter: string | null = null;
        if (sp.hasMore) {
          for (const g of groups) {
            if (g.key === "pinned") continue;
            for (const t of g.rows) {
              if (!c || t.optimistic || t.updated > c.updated || (t.updated === c.updated && t.id >= c.id)) loaderAfter = t.id;
            }
          }
        }
        let placed = !sp.hasMore;
        for (const g of groups) {
          block(g.label, g.key, () => {
            const gi = section.blocks.length - 1;
            for (const t of g.rows) {
              push({ key: threadKey(sp.id, t.id), kind: "row", size: ROW, group: gi, thread: t });
              if (!placed && g.key !== "pinned" && t.id === loaderAfter) {
                push({ key: `loader:${sp.id}`, kind: "loader", size: ROW, group: gi });
                placed = true;
              }
            }
          });
        }
        if (!placed) block(undefined, "more", () => push({ key: `loader:${sp.id}`, kind: "loader", size: ROW, group: section.blocks.length - 1 }));
      }
    }
    section.end = y;
    section.to = items.length;
    sections.push(section);
  });
  return { items, sections, size: y, index };
}

/** The scroll offset that shows `item` below the sticky rows, or null when it already is. Far away, it is centred. */
export function revealOffset(item: Item, scrollTop: number, height: number, mode: "nearest" | "center" = "nearest", sticky: number = STICKY): number | null {
  const cover = item.kind === "space" ? 0 : sticky;
  const top = item.start;
  const bottom = item.start + item.size;
  if (top >= scrollTop + cover && bottom <= scrollTop + height) return null;
  const far = top > scrollTop + height + height || bottom < scrollTop - height;
  if (mode === "center" || far) return Math.max(0, Math.round(top - height / 2 + item.size / 2));
  return top < scrollTop + cover ? Math.max(0, top - cover) : bottom - height;
}
