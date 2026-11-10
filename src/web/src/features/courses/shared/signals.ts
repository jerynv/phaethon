/**
 * Signals between the education screens: the course sites changed (a sign-in,
 * an import, an access change), so Study, Grades, Plan and the access list
 * read again.
 */
import { create } from "zustand";

type Signals = { sitesVersion: number; sitesChanged(): void };

export const useEduSignals = create<Signals>((set) => ({
  sitesVersion: 0,
  sitesChanged: () => set((s) => ({ sitesVersion: s.sitesVersion + 1 })),
}));

export const sitesChanged = () => useEduSignals.getState().sitesChanged();
export const useSitesVersion = () => useEduSignals((s) => s.sitesVersion);
