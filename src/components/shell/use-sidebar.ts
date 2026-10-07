import { useCallback, useEffect, useState } from "react";

const KEY = "phaethon.sidebar.collapsed";

/**
 * At or below this window width (at the default text size) the sidebar starts
 * hidden, so the conversation keeps its room. The sidebar grows with the text
 * size, so the threshold does too.
 */
const NARROW_WIDTH = 720;

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function write(collapsed: boolean) {
  try {
    window.localStorage.setItem(KEY, collapsed ? "1" : "0");
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the
    // sidebar still works, it just will not remember.
  }
}

/** Below this window width (at the default text size) the title bar's buttons are icons only. */
const LABEL_ROOM = 520;

function textScale(): number {
  const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ph-text-scale"));
  return Math.max(1, Number.isFinite(scale) ? scale : 1);
}

function narrowNow(): boolean {
  return window.innerWidth <= NARROW_WIDTH * textScale();
}

/**
 * Whether the title bar's Spaces and Settings buttons carry their words: at a
 * large text size always (an icon alone is hardest to find there), otherwise
 * whenever the window has room.
 */
function labelsNow(): boolean {
  return textScale() >= 1.5 || window.innerWidth >= LABEL_ROOM;
}

/**
 * Whether the sidebar is open. The person's choice is remembered per device.
 * In a narrow window the sidebar starts hidden without touching that choice:
 * showing or hiding it there lasts only while the window stays narrow, and
 * widening the window brings the remembered choice back.
 */
export function useSidebar() {
  const [preferred, setPreferred] = useState(() => !read());
  const [narrow, setNarrow] = useState(narrowNow);
  const [labels, setLabels] = useState(labelsNow);
  // While narrow: the open state for this stretch of narrowness (starts hidden).
  const [narrowOpen, setNarrowOpen] = useState(false);

  useEffect(() => write(!preferred), [preferred]);

  // Re-check when the window resizes or the text size changes (appearance
  // settings set it on <html>). Crossing the line starts the sidebar hidden again.
  useEffect(() => {
    let last: boolean | null = null;
    const sync = () => {
      setLabels(labelsNow());
      const now = narrowNow();
      if (now === last) return;
      const first = last === null;
      last = now;
      setNarrow(now);
      if (!first) setNarrowOpen(false);
    };
    sync();
    window.addEventListener("resize", sync);
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    return () => {
      window.removeEventListener("resize", sync);
      mo.disconnect();
    };
  }, []);

  const open = narrow ? narrowOpen : preferred;
  const toggle = useCallback(() => {
    if (narrow) setNarrowOpen((o) => !o);
    else setPreferred((o) => !o);
  }, [narrow]);
  const setOpen = useCallback(
    (next: boolean) => {
      if (narrow) setNarrowOpen(next);
      else setPreferred(next);
    },
    [narrow],
  );
  // Docked: beside the conversation. In a narrow window the open sidebar lies over it instead.
  return { open, setOpen, toggle, narrow, docked: open && !narrow, labels };
}
