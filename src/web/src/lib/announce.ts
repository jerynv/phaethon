// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.

/**
 * App-wide screen-reader announcements through two alternating polite live
 * regions (as VS Code's aria.ts does), so repeating the same action is
 * spoken again. Regions are created on first use; a write in the same task
 * that inserts a region is ignored by screen readers, so the first write waits
 * a moment.
 */

const CLEAR_AFTER_MS = 7_000;
let container: HTMLElement | null = null;
let pending: string | null = null;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

function regions(): [HTMLElement, HTMLElement] | null {
  return container ? (Array.from(container.children) as [HTMLElement, HTMLElement]) : null;
}

function write(text: string) {
  const r = regions();
  if (!r) return;
  const [first, second] = r;
  const next = first.textContent ? second : first;
  first.textContent = "";
  second.textContent = "";
  next.textContent = text;
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    first.textContent = "";
    second.textContent = "";
  }, CLEAR_AFTER_MS);
}

/** Says `text` politely, once. */
export function announce(text: string): void {
  if (!container) {
    container = document.createElement("div");
    container.id = "app-announcements";
    container.className = "sr-only";
    for (let i = 0; i < 2; i++) {
      const region = document.createElement("div");
      region.setAttribute("aria-live", "polite");
      region.setAttribute("aria-atomic", "true");
      container.append(region);
    }
    document.body.append(container);
    pending = text;
    setTimeout(() => {
      if (pending !== null) write(pending);
      pending = null;
    }, 100);
    return;
  }
  if (pending !== null) {
    pending = text;
    return;
  }
  write(text);
}

export function announceSidebarVisibility(open: boolean): void {
  announce(`Sidebar ${open ? "shown" : "hidden"}`);
}
