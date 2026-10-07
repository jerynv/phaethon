import { createContext, useContext, type RefObject } from "react";

import type { ThreadIndex } from "@/runtime/thread-index";

/**
 * One space's conversation pane. The shell keeps panes for visited spaces
 * mounted (hidden and inert while another space shows), so a reply keeps
 * running there; everything that moves focus or reads "the composer" goes
 * through the pane it belongs to, never a document-wide lookup.
 */
export type Pane = {
  spaceId: string;
  /** The pane's composer input. */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** The pane's outermost element (to tell whether it is the one shown). */
  rootRef: RefObject<HTMLElement | null>;
  /** When the user last typed in the composer (ms since the epoch), for C1. */
  typedAt: RefObject<number>;
  /** Saved positions of the shown messages (Edit / Regenerate), when the backend keeps them. */
  threadIndex: ThreadIndex | null;
};

export const PaneContext = createContext<Pane | null>(null);
export const usePane = () => useContext(PaneContext);

/** True while the pane is the one on screen (not hidden behind another space). */
export function paneShown(pane: Pane | null): boolean {
  const el = pane?.rootRef.current;
  if (!el) return true;
  return el.getClientRects().length > 0 && !el.closest("[inert]");
}

/** Focus this pane's composer, if the pane is shown. */
export function focusPaneComposer(pane: Pane | null): void {
  if (pane && !paneShown(pane)) return;
  const input = pane?.inputRef.current ?? visibleComposer();
  input?.focus();
}

/** The composer on screen (several panes may be mounted; only one shows). */
export function visibleComposer(): HTMLTextAreaElement | null {
  const all = [...document.querySelectorAll<HTMLTextAreaElement>("[data-composer-input]")];
  return all.find((el) => el.getClientRects().length > 0 && !el.closest("[inert]")) ?? null;
}

/** How long after a keystroke the composer counts as "being typed in" (C1). */
export const TYPING_GRACE_MS = 2000;

/**
 * Whether a card that just appeared may take focus: not while the user is
 * writing a message in this pane's composer (typed within the last 2 s, or
 * text is waiting there), and never in a pane that isn't shown.
 */
export function mayTakeFocus(pane: Pane | null): boolean {
  if (!pane) return true;
  if (!paneShown(pane)) return false;
  const input = pane.inputRef.current;
  if (!input || document.activeElement !== input) return true;
  const typing = Date.now() - (pane.typedAt.current ?? 0) < TYPING_GRACE_MS;
  return !typing && input.value.trim() === "";
}
