/**
 * A review session's queue: which cards are due now, and where a card the
 * core says to see `again` comes back (3 cards later after "Not at all", 8
 * after "Barely", or at the end). Pure.
 */
import type { Confidence } from "./types";

export const AGAIN_SOON = 3;
export const AGAIN_LATER = 8;

/** Where a card rated `again` goes back into `queue`, the card at `at` being the one just rated. */
export function requeue<T>(queue: readonly T[], at: number, card: T, confidence: Confidence): T[] {
  const gap = confidence === 1 ? AGAIN_SOON : AGAIN_LATER;
  const to = Math.min(queue.length, at + 1 + gap);
  return [...queue.slice(0, to), card, ...queue.slice(to)];
}

/**
 * Only what is due now: never studied, or its next review has come. A session
 * over chosen decks also gets cards due later from the core, which a "due"
 * session leaves out.
 */
export function dueNow<T extends { due?: number; confidence?: number }>(cards: readonly T[], now = Date.now()): T[] {
  return cards.filter((c) => c.confidence == null || c.due == null || c.due <= now);
}

/** Decks whose mastery changed, rounded to whole percents, for the session summary. */
export function masteryChanges(
  before: readonly { path: string; title: string; mastery: number }[],
  after: readonly { path: string; title: string; mastery: number }[],
): { path: string; title: string; was: number; now: number }[] {
  const out: { path: string; title: string; was: number; now: number }[] = [];
  for (const d of after) {
    const b = before.find((x) => x.path === d.path);
    const was = Math.round((b?.mastery ?? 0) * 100);
    const now = Math.round(d.mastery * 100);
    if (b && was !== now) out.push({ path: d.path, title: d.title, was, now });
  }
  return out;
}
