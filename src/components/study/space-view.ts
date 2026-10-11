import { useSyncExternalStore } from "react";

/**
 * Which view each space shows: its conversation, Study, Grades or Plan. Kept
 * here (not in the pane) so the palette and the shortcuts can change it, and
 * so a space keeps its view while another space is on screen.
 */
export type SpaceView = "chat" | "study" | "grades" | "plan";

export const VIEWS: { id: SpaceView; label: string; digit: number }[] = [
  { id: "chat", label: "Chat", digit: 1 },
  { id: "study", label: "Study", digit: 2 },
  { id: "grades", label: "Grades", digit: 3 },
  { id: "plan", label: "Plan", digit: 4 },
];

export const viewLabel = (v: SpaceView) => VIEWS.find((x) => x.id === v)?.label ?? v;
export const tabId = (space: string, v: SpaceView) => `view-tab-${space}-${v}`;
export const panelId = (space: string, v: SpaceView) => `view-panel-${space}-${v}`;

const views = new Map<string, SpaceView>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/**
 * Show `view` in `space`. With `focus`, the view's main control takes focus
 * once it shows (a shortcut or the palette asked; a click on a tab keeps
 * focus on the tab).
 */
export function setSpaceView(space: string, view: SpaceView, focus = false): void {
  if (views.get(space) !== view) {
    views.set(space, view);
    emit();
  }
  if (focus) requestAnimationFrame(() => requestAnimationFrame(() => focusView(space, view)));
}

export const getSpaceView = (space: string): SpaceView => views.get(space) ?? "chat";

export function useSpaceView(space: string): SpaceView {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => getSpaceView(space),
  );
}

/** Focus what a view starts with: the composer in Chat, the view's heading elsewhere. */
export function focusView(space: string, view: SpaceView): void {
  const panel = document.getElementById(panelId(space, view));
  if (!panel) return;
  const first =
    view === "chat"
      ? panel.querySelector<HTMLElement>("[data-composer-input]")
      : panel.querySelector<HTMLElement>("[data-view-focus]") ?? panel.querySelector<HTMLElement>("h2");
  (first ?? panel).focus();
}

// ---- Requests into the Study view (from the palette) ----

export type StudyRequest = { space: string; what: "deck" | "quiz" | "due"; key: number };
let request: StudyRequest | null = null;
let nextKey = 1;
const requestListeners = new Set<() => void>();

/** Open Study in `space` and start making a deck or a quiz, or a review of everything due. */
export function requestStudy(space: string, what: StudyRequest["what"]): void {
  request = { space, what, key: nextKey++ };
  setSpaceView(space, "study");
  requestListeners.forEach((l) => l());
}

export function useStudyRequest(): StudyRequest | null {
  return useSyncExternalStore(
    (cb) => {
      requestListeners.add(cb);
      return () => requestListeners.delete(cb);
    },
    () => request,
  );
}
