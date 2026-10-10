import { useEffect, type KeyboardEvent, type RefObject } from "react";

import { isModChord } from "@/components/shell/shortcuts";
import { platform } from "@/lib/platform";

import { useAnnounce } from "./announce";
import { focusPaneComposer, mayTakeFocus, paneShown, usePane } from "./pane";

/** The chord that moves focus from the composer to a waiting card (C1). */
export const jumpKeyLabel = () => (platform() === "mac" ? "Option+Return" : "Alt+Enter");
/** True for the jump chord: Alt (Option) + Enter, nothing else held. */
export const isJumpKey = (e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  e.key === "Enter" && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;

/**
 * Scroll the log so the card's top is in view: the whole card when it fits,
 * else its top (heading and file name first) at the top of the log.
 */
export function revealCard(card: HTMLElement) {
  const log = card.closest<HTMLElement>("[role=log]");
  if (!log) return;
  const l = log.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const margin = 16;
  if (c.height + margin * 2 > l.height || c.top < l.top + margin) {
    log.scrollTop += c.top - l.top - margin;
  } else if (c.bottom > l.bottom - margin) {
    log.scrollTop += c.bottom - l.bottom + margin;
  }
}

/**
 * The keys on a waiting card (approval or access), while focus is in it:
 * Cmd+Enter (Ctrl+Enter) answers yes, Cmd+Backspace (Ctrl+Backspace) answers
 * no, and Escape goes back to the composer, saying the card still waits and
 * how to come back. Escape never answers.
 */
export function useCardKeys({ allow, refuse, busy }: { allow: () => void; refuse: () => void; busy: boolean }) {
  const pane = usePane();
  const announce = useAnnounce();
  return (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      focusPaneComposer(pane);
      announce(`Phaethon’s question is still waiting for your answer. Press ${jumpKeyLabel()} to go back to it.`);
      return;
    }
    if (!isModChord(e.nativeEvent) || (e.key !== "Enter" && e.key !== "Backspace")) return;
    e.preventDefault();
    if (busy) return;
    if (e.key === "Enter") allow();
    else refuse();
  };
}

/** Move focus to the card and show its top. */
export function goToCard(card: HTMLElement) {
  card.focus({ preventScroll: true });
  revealCard(card);
}

/**
 * When a card appears (a new `id`): show its top, and take focus, unless the
 * user is writing in the composer (typed in the last 2 s, or text waiting) or
 * this space isn't the one on screen. Then focus stays where it is and the
 * card is announced once, with the shortcut that goes to it.
 */
export function useCardArrival(ref: RefObject<HTMLElement | null>, id: string | undefined, describe: string) {
  const pane = usePane();
  const announce = useAnnounce();
  useEffect(() => {
    const card = ref.current;
    if (!id || !card) return;
    // Laid out first (the log grows to hold the card), then placed.
    requestAnimationFrame(() => {
      if (!card.isConnected) return;
      if (mayTakeFocus(pane)) goToCard(card);
      else {
        revealCard(card);
        if (paneShown(pane)) announce(`${describe} Press ${jumpKeyLabel()} to answer it.`);
      }
    });
    // Only when a different card arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}
