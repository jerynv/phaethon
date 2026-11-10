// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.

/**
 * F6 / Shift+F6 move between the app's areas (sidebar, title bar, main
 * content, and inside Settings its navigation and content), restoring the
 * control that last had focus in each area. Focus that drops to <body>
 * because its element went away returns to its area. Features mark extra
 * stops with `workspaceAreaProps` and a preferred control with
 * `data-workspace-focus-default`.
 */

const AREA_SELECTOR = "[data-workspace-area]";
const FOCUS_BOUNDARY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [data-slot$="-popup"]:not([data-slot="tooltip-popup"]):not([role="tooltip"])';
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"], [tabindex]';

/** Props that make an element one stop in the F6 cycle; `order` sets its place. */
export function workspaceAreaProps(name: string, order: number, label: string) {
  return {
    "data-workspace-area": name,
    "data-workspace-order": order,
    "aria-label": label,
    role: "region",
    tabIndex: -1,
  } as const;
}

function workspaceArea(element: Element): HTMLElement | null {
  return element.closest<HTMLElement>(AREA_SELECTOR);
}

function isVisible(element: HTMLElement): boolean {
  if (
    !element.isConnected ||
    element.closest('[hidden], [inert], [data-closed], [aria-hidden="true"], [data-slot="sidebar"][data-state="collapsed"]')
  )
    return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  return Array.from(element.getClientRects()).some((r) => r.width > 0 && r.height > 0);
}

export function createWorkspaceFocusController(doc: Document) {
  const lastFocused = new Map<string, HTMLElement>();
  let lastArea: string | undefined;

  const remember = (event: FocusEvent) => {
    if (!(event.target instanceof HTMLElement)) return;
    const area = workspaceArea(event.target);
    const name = area?.dataset.workspaceArea;
    if (!name) return;
    lastArea = name;
    lastFocused.set(name, event.target);
  };
  doc.addEventListener("focusin", remember);

  const focusArea = (area: HTMLElement) => {
    const name = area.dataset.workspaceArea!;
    const previous = lastFocused.get(name);
    const belongs = (el: HTMLElement) => workspaceArea(el) === area && isVisible(el) && !el.matches(":disabled");
    const preferred = Array.from(
      area.querySelectorAll<HTMLElement>('[data-workspace-focus-default], [aria-current="page"], [data-composer-input]'),
    ).find(belongs);
    const fallback = Array.from(area.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(
      (el) => el.tabIndex >= 0 && belongs(el),
    );
    for (const target of [previous && belongs(previous) ? previous : undefined, preferred, fallback, area]) {
      if (!target) continue;
      target.focus({ preventScroll: target === area });
      if (doc.activeElement === target) return true;
    }
    return false;
  };

  const move = (direction: 1 | -1) => {
    // Settings and other app modals hold their own areas; other popups keep focus.
    const appModal = Array.from(doc.querySelectorAll<HTMLElement>("[data-app-modal]")).find(isVisible);
    const boundaries = Array.from(doc.querySelectorAll<HTMLElement>(FOCUS_BOUNDARY_SELECTOR)).filter(
      (b) => b !== appModal && !appModal?.contains(b) && isVisible(b),
    );
    if (boundaries.some((b) => b.matches('[aria-modal="true"]') || b.contains(doc.activeElement))) return false;
    const areas = Array.from((appModal ?? doc).querySelectorAll<HTMLElement>(AREA_SELECTOR))
      .filter(isVisible)
      .sort((a, b) => Number(a.dataset.workspaceOrder) - Number(b.dataset.workspaceOrder));
    if (areas.length === 0) return false;
    const active = doc.activeElement?.closest<HTMLElement>(AREA_SELECTOR);
    const currentId = active?.dataset.workspaceArea ?? lastArea;
    const at = areas.findIndex((a) => a.dataset.workspaceArea === currentId);
    const index = at === -1 ? (direction === 1 ? 0 : areas.length - 1) : (at + direction + areas.length) % areas.length;
    return focusArea(areas[index]);
  };

  const focus = (name: string) => {
    const area = Array.from(doc.querySelectorAll<HTMLElement>(AREA_SELECTOR)).find(
      (a) => a.dataset.workspaceArea === name && isVisible(a),
    );
    return area ? focusArea(area) : false;
  };

  // Focus lost to <body> (its element was removed, hidden or disabled) goes back to its area.
  const recover = (event: FocusEvent) => {
    const lost = event.target;
    if (!(lost instanceof HTMLElement) || event.relatedTarget) return;
    const name = workspaceArea(lost)?.dataset.workspaceArea;
    requestAnimationFrame(() => {
      if (doc.activeElement !== doc.body || !doc.hasFocus() || (isVisible(lost) && !lost.matches(":disabled"))) return;
      if (!name || !focus(name)) focus("main");
    });
  };
  doc.addEventListener("focusout", recover);

  return {
    move,
    focus,
    dispose() {
      doc.removeEventListener("focusin", remember);
      doc.removeEventListener("focusout", recover);
    },
  };
}

let controller: ReturnType<typeof createWorkspaceFocusController> | undefined;

export function startWorkspaceFocus(): () => void {
  const active = createWorkspaceFocusController(document);
  controller = active;
  return () => {
    active.dispose();
    if (controller === active) controller = undefined;
  };
}

export function moveWorkspaceFocus(direction: 1 | -1): boolean {
  return controller?.move(direction) ?? false;
}

/** Moves focus into a named area after React has committed it. */
export function requestWorkspaceFocus(name: string): void {
  let tries = 0;
  const attempt = () => {
    if (controller?.focus(name) || ++tries > 30) return;
    requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
