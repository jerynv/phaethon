/**
 * The timeline's scrolling, as plain decisions (docs/UI-REBUILD.md › Chat — timeline).
 * `../timeline-scroll.ts` applies them to the DOM.
 *
 * A conversation is either pinned to its end, or held at a place: a message
 * and how far its top sits below the top of the view. Holding a message rather
 * than a pixel offset keeps the place exact while content above it changes
 * height (a diagram drawn, code highlighted, older turns mounting).
 */

/** Where a conversation was left. */
export type Place = { pinned: true } | { pinned: false; key: string; offset: number };

export type Metrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** Within this of the end counts as at it (sub-pixel rounding, zoom). */
export const AT_END_PX = 2;
/** Scrolling down to within this of the end pins it again. */
export const REPIN_PX = 48;

export function distanceFromEnd(m: Metrics): number {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight);
}

export function maxScrollTop(m: Pick<Metrics, "scrollHeight" | "clientHeight">): number {
  return Math.max(0, m.scrollHeight - m.clientHeight);
}

/**
 * What a scroll event means for the pin. Only the reader moves the view up:
 * a move up while the content kept its height is theirs (content shrinking
 * makes the browser clamp the position, which is not). Reaching the end, or
 * scrolling down to near it, pins again.
 */
export function pinAfterScroll(pinned: boolean, prev: { scrollTop: number; scrollHeight: number }, now: Metrics): boolean {
  const dist = distanceFromEnd(now);
  if (dist <= AT_END_PX) return true;
  const up = now.scrollTop < prev.scrollTop - 0.5 && now.scrollHeight === prev.scrollHeight;
  if (up) return false;
  if (now.scrollTop > prev.scrollTop && dist <= REPIN_PX) return true;
  return pinned;
}

/**
 * How a requested move travels: a glide for a short way, an instant jump for
 * a long one (a long glide through a conversation still laying out lands
 * somewhere else, and is slow), always instant under reduced motion.
 */
export function travel(distance: number, viewport: number, reducedMotion: boolean): "smooth" | "instant" {
  if (reducedMotion || viewport <= 0) return "instant";
  return Math.abs(distance) <= viewport * 1.5 ? "smooth" : "instant";
}

/**
 * Where the scroll position must go so the held message sits where it was
 * held. Positions are compared as painted, on whole pixels: content heights
 * are fractional and the scroll position is not, so correcting by the exact
 * difference would leave the text a pixel up or down after some corrections.
 */
export function holdTop(scrollTop: number, messageTop: number, offset: number, m: Pick<Metrics, "scrollHeight" | "clientHeight">): number {
  const delta = Math.round(messageTop) - Math.round(offset);
  if (delta === 0) return scrollTop;
  return Math.min(maxScrollTop(m), Math.max(0, scrollTop + delta));
}

/**
 * The message a reader is looking at: the first whose bottom is below the top
 * of the view, by binary search over the messages in document order
 * (`bottomOf(i)` relative to the view's top). -1 when there are none.
 */
export function heldIndex(count: number, bottomOf: (i: number) => number): number {
  if (count === 0) return -1;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bottomOf(mid) > 0) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ---- Mounting a long conversation a piece at a time ----

/** Shorter conversations mount whole, at once. */
export const MOUNT_ALL_BELOW = 60;
/** Messages in the first commit: comfortably more than a screen. */
export const FIRST_MESSAGES = 24;
/** Messages added on each side per step after that. */
export const STEP_MESSAGES = 40;

/** Which messages are mounted: `from` up to (not including) `to`; `to` null is through the newest. */
export type Mounted = { from: number; to: number | null };

/**
 * What to mount when a conversation opens: its newest `FIRST_MESSAGES`, or,
 * when it was left reading at message `heldAt`, the messages around that one
 * (the newest mount after, as the window widens).
 */
export function firstMounted(count: number, heldAt = -1): Mounted {
  if (count < MOUNT_ALL_BELOW) return { from: 0, to: null };
  const newest = Math.max(0, count - FIRST_MESSAGES);
  if (heldAt < 0 || heldAt >= newest) return { from: heldAt >= 0 ? Math.min(newest, Math.max(0, heldAt - 8)) : newest, to: null };
  const from = Math.max(0, heldAt - 8);
  return { from, to: from + FIRST_MESSAGES };
}

/** The window one step wider: older messages above, newer ones below, until it holds them all. */
export function widen(m: Mounted, count: number): Mounted {
  const to = m.to === null || m.to + STEP_MESSAGES >= count ? null : m.to + STEP_MESSAGES;
  return { from: Math.max(0, m.from - STEP_MESSAGES), to };
}

export function mountedAll(m: Mounted): boolean {
  return m.from === 0 && m.to === null;
}
