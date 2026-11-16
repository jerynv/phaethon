import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { AT_END_PX, distanceFromEnd, heldIndex, holdTop, maxScrollTop, pinAfterScroll, type Place, travel } from "./lib/scroll";

/**
 * The timeline's scroll box (docs/UI-REBUILD.md › Chat — timeline), after how
 * the open-source chat UIs do it: a conversation opens at its end, or where it
 * was left, before the first paint; content that lays out late (code, math,
 * diagrams, images, older turns mounting) never visibly moves it; only the
 * reader's own gestures let go of the end.
 *
 * At the end, the browser's own scroll anchoring holds it: a 1 px marker
 * after the messages is the box's only anchor candidate (messages opt out
 * with `overflow-anchor: none`), so while it is on screen the browser keeps
 * it there during layout, with no frame of lag. A ResizeObserver backs that
 * up, and holds a reader's place (a message and its offset) when they are
 * not at the end. Messages carry `data-msg` with their key.
 */

/** Where each conversation was left, by `chatKey`. */
const places = new Map<string, Place>();

/** The place conversation `key` was left at, if it was left reading (not at its end). */
export function heldPlace(key: string): Extract<Place, { pinned: false }> | null {
  const p = places.get(key);
  return p && !p.pinned ? p : null;
}

const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
const GLIDE_TIMEOUT_MS = 900;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Whether an upward wheel over `target` moves an inner scroller (a long PDF preview) rather than the timeline. */
function innerTakesUp(target: EventTarget | null, box: HTMLElement): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== box; el = el.parentElement) {
    if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight && /^(auto|scroll)$/.test(getComputedStyle(el).overflowY)) return true;
  }
  return false;
}

type Glide = { kind: "end" } | { kind: "message"; key: string; offset: number };

/**
 * `key` names the conversation shown; `ready` is true once its messages are
 * in the box. `sentKey` is the key of a message just sent from this window:
 * sending goes to the end.
 */
export function useTimelineScroll(key: string, ready: boolean, sentKey: string | null) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [away, setAway] = useState(false);
  const st = useRef({
    key,
    pinned: true,
    held: null as { key: string; offset: number } | null,
    /** The position we last wrote; its scroll event is ours, not the reader's. */
    wrote: null as number | null,
    lastTop: 0,
    lastHeight: 0,
    glide: null as Glide | null,
    glideTimer: 0 as ReturnType<typeof setTimeout> | 0,
  }).current;

  const shown = (el: HTMLElement) => el.clientHeight > 0;
  const note = (el: HTMLElement) => {
    st.lastTop = el.scrollTop;
    st.lastHeight = el.scrollHeight;
  };
  const write = (el: HTMLElement, top: number) => {
    if (Math.abs(el.scrollTop - top) < 0.5) return;
    el.scrollTop = top;
    st.wrote = el.scrollTop;
  };
  const save = () => places.set(st.key, st.pinned || !st.held ? { pinned: true } : { pinned: false, ...st.held });
  const setPinned = (pinned: boolean) => {
    st.pinned = pinned;
    setAway(!pinned);
  };

  const messages = () => (content.current?.querySelectorAll<HTMLElement>("[data-msg]") ?? []) as ArrayLike<HTMLElement>;
  /** The message at the top of the view and where its top sits. */
  const measureHeld = (el: HTMLElement) => {
    const list = messages();
    const top = el.getBoundingClientRect().top;
    const i = heldIndex(list.length, (j) => list[j]!.getBoundingClientRect().bottom - top);
    const m = i >= 0 ? list[i] : undefined;
    st.held = m?.dataset.msg ? { key: m.dataset.msg, offset: m.getBoundingClientRect().top - top } : null;
  };
  const find = (k: string) => content.current?.querySelector<HTMLElement>(`[data-msg="${CSS.escape(k)}"]`) ?? null;
  /** Puts the view back: at the end, or with the held message where it was held. */
  const settle = (el: HTMLElement) => {
    if (st.pinned) {
      write(el, maxScrollTop(el));
    } else if (st.held) {
      const m = find(st.held.key);
      if (m) write(el, holdTop(el.scrollTop, m.getBoundingClientRect().top - el.getBoundingClientRect().top, st.held.offset, el));
    }
    note(el);
  };
  const stopGlide = () => {
    st.glide = null;
    if (st.glideTimer) clearTimeout(st.glideTimer);
    st.glideTimer = 0;
  };
  /** The reader took over: wheel, keys, touch, a drag. */
  const release = () => {
    const el = box.current;
    stopGlide();
    if (!el || !st.pinned || el.scrollHeight <= el.clientHeight) return;
    setPinned(false);
    measureHeld(el);
    save();
  };

  // One set of listeners for the box's life; they read the current state from `st`.
  const attach = useCallback((el: HTMLDivElement | null) => {
    box.current = el;
    if (!el) return;
    const onScroll = () => {
      if (!shown(el)) return;
      const ours = st.wrote !== null && Math.abs(el.scrollTop - st.wrote) < 1;
      st.wrote = null;
      if (ours) return note(el);
      if (st.glide) {
        // Our own glide, on its way; it settles when it ends.
        note(el);
        return;
      }
      const pinned = pinAfterScroll(st.pinned, { scrollTop: st.lastTop, scrollHeight: st.lastHeight }, el);
      if (pinned !== st.pinned) setPinned(pinned);
      if (!pinned) measureHeld(el);
      note(el);
      save();
    };
    const onScrollEnd = () => {
      const g = st.glide;
      if (!g) return;
      stopGlide();
      if (g.kind === "end") setPinned(true);
      else st.held = { key: g.key, offset: g.offset };
      settle(el);
      save();
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && !e.ctrlKey && !innerTakesUp(e.target, el)) release();
    };
    const onKey = (e: KeyboardEvent) => {
      const up = UP_KEYS.has(e.key) || (e.key === " " && e.shiftKey);
      if (!up || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !shown(el)) return;
      const t = e.target as Element | null;
      if (t?.closest?.(EDITABLE)) return;
      if (t === document.body || t === document.documentElement || (t && el.contains(t))) release();
    };
    const onTouch = () => stopGlide();
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("scrollend", onScrollEnd);
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouch, { passive: true });
    document.addEventListener("keydown", onKey);
    // Content laid out late (code, math, diagrams, images, older turns mounting) or the box resized:
    // put the view back in the same frame, before it is painted.
    const ro = new ResizeObserver(() => {
      if (!shown(el) || st.glide) return;
      settle(el);
    });
    ro.observe(el);
    if (content.current) ro.observe(content.current);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("scrollend", onScrollEnd);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouch);
      document.removeEventListener("keydown", onKey);
      ro.disconnect();
      stopGlide();
      box.current = null;
    };
    // `st` and the helpers only read refs.
  }, []);

  // A conversation opens where it was left (its end the first time), before the first paint.
  useLayoutEffect(() => {
    st.key = key;
    stopGlide();
    const p = places.get(key);
    st.pinned = !p || p.pinned;
    st.held = p && !p.pinned ? { key: p.key, offset: p.offset } : null;
    setAway(!st.pinned);
    const el = box.current;
    if (el && ready) settle(el);
  }, [key, ready]);

  // Sending a message goes to the end (a new one in this conversation; coming back to a conversation
  // whose reply is still running keeps the place it was left at).
  const sent = useRef({ key, sentKey });
  useLayoutEffect(() => {
    const prev = sent.current;
    sent.current = { key, sentKey };
    const el = box.current;
    if (!sentKey || !el || prev.key !== key || prev.sentKey === sentKey) return;
    stopGlide();
    setPinned(true);
    settle(el);
    save();
  }, [key, sentKey]);

  const glide = (el: HTMLElement, top: number, g: Glide) => {
    stopGlide();
    st.glide = g;
    el.scrollTo({ top, behavior: "smooth" });
    // `scrollend` settles it; this is for a glide that never moves (already there) or gets lost.
    st.glideTimer = setTimeout(() => el.dispatchEvent(new Event("scrollend")), GLIDE_TIMEOUT_MS);
  };

  /** "Latest": to the end, gliding only when it is near. */
  const toEnd = () => {
    const el = box.current;
    if (!el) return;
    const d = distanceFromEnd(el);
    if (d > AT_END_PX && travel(d, el.clientHeight, reducedMotion()) === "smooth") {
      glide(el, maxScrollTop(el), { kind: "end" });
      setAway(false);
      return;
    }
    stopGlide();
    setPinned(true);
    settle(el);
    save();
  };

  /** Shows `target` (inside a message) `offset` px below the top of the view, and holds it there. */
  const jumpTo = (target: HTMLElement, offset: number) => {
    const el = box.current;
    const m = target.closest<HTMLElement>("[data-msg]");
    if (!el || !m?.dataset.msg) return;
    const boxTop = el.getBoundingClientRect().top;
    const held = { key: m.dataset.msg, offset: offset + (m.getBoundingClientRect().top - target.getBoundingClientRect().top) };
    const top = holdTop(el.scrollTop, target.getBoundingClientRect().top - boxTop, offset, el);
    setPinned(false);
    if (travel(top - el.scrollTop, el.clientHeight, reducedMotion()) === "smooth") {
      glide(el, top, { kind: "message", ...held });
      return;
    }
    stopGlide();
    st.held = held;
    settle(el);
    save();
  };

  /** A wheel over something outside the box that scrolls it (the history rail). */
  const wheel = (deltaY: number) => {
    if (deltaY < 0) release();
    box.current?.scrollBy({ top: deltaY });
  };

  return { box: attach, boxRef: box, content, away, toEnd, jumpTo, wheel };
}
