/**
 * A message the education screens hand to the chat composer ("Help me work
 * through this question…", "What’s coming up in this course?"). The chat
 * worker's composer reads and clears it when the space's chat opens; until
 * then it waits here. Never sent on its own: the person sends it.
 */
import { create } from "zustand";

type ComposeRequest = { space: string; text: string; key: number };

type Store = { request: ComposeRequest | null; compose(space: string, text: string): void; take(space: string): string | null };

let key = 1;

export const useComposeRequest = create<Store>((set, get) => ({
  request: null,
  compose: (space, text) => set({ request: { space, text, key: key++ } }),
  take: (space) => {
    const r = get().request;
    if (!r || r.space !== space) return null;
    set({ request: null });
    return r.text;
  },
}));
