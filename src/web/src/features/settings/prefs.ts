import { create } from "zustand";
import { type GradeScale, readScale, STANDARD } from "@/features/grades/lib/gpa";

/**
 * Display preferences kept on this computer (Settings › General). They change
 * how things look, never what Phaethon does, so they don't go in the vault.
 */
type Prefs = {
  /** Tool names, paths and output in a reply's work steps. Off: plain-words progress only. */
  technicalDetails: boolean;
  setTechnicalDetails(on: boolean): void;
  /** How letter grades count towards the term's GPA. */
  gradeScale: GradeScale;
  setGradeScale(scale: GradeScale): void;
};

const KEY = "phaethon.prefs";

function read(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
  } catch {
    return {};
  }
}

function save(get: () => Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ technicalDetails: get().technicalDetails, gradeScale: get().gradeScale }));
  } catch {
    // Private window: the choice lasts for the session.
  }
}

export const usePrefs = create<Prefs>((set, get) => ({
  technicalDetails: read().technicalDetails === true,
  setTechnicalDetails(on) {
    set({ technicalDetails: on });
    save(get);
  },
  gradeScale: readScale(read().gradeScale) ?? STANDARD,
  setGradeScale(scale) {
    set({ gradeScale: scale });
    save(get);
  },
}));
