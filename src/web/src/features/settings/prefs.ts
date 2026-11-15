import { create } from "zustand";

/**
 * Display preferences kept on this computer (Settings › General). They change
 * how things look, never what Phaethon does, so they don't go in the vault.
 */
type Prefs = {
  /** Tool names, paths and output in a reply's work steps. Off: plain-words progress only. */
  technicalDetails: boolean;
  setTechnicalDetails(on: boolean): void;
};

const KEY = "phaethon.prefs";

function read(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
  } catch {
    return {};
  }
}

export const usePrefs = create<Prefs>((set, get) => ({
  technicalDetails: read().technicalDetails === true,
  setTechnicalDetails(on) {
    set({ technicalDetails: on });
    try {
      localStorage.setItem(KEY, JSON.stringify({ technicalDetails: get().technicalDetails }));
    } catch {
      // Private window: the choice lasts for the session.
    }
  },
}));
