import { create } from "zustand";
import type { ModelPick } from "@/features/chat/api";
import type { StudyScreen } from "./StudyView";

/**
 * Study state that outlives one screen: the screen to open next (a quiz made
 * from a chat card opens in Study), and the model last picked for study
 * work, kept on this computer so the make dialog starts with it.
 */

const PICK = "phaethon.study-model";

function readPick(): ModelPick | null {
  try {
    const v = JSON.parse(localStorage.getItem(PICK) ?? "null") as ModelPick | null;
    return v && typeof v === "object" && typeof v.backend === "string" ? { backend: v.backend, model: v.model ?? null, effort: v.effort ?? null } : null;
  } catch {
    return null;
  }
}

type Flow = {
  /** A screen Study should open when it next shows `space`. */
  next: { space: string; screen: StudyScreen } | null;
  pick: ModelPick | null;
  goTo(space: string, screen: StudyScreen): void;
  /** The waiting screen for `space`, taken (so it opens once). */
  take(space: string): StudyScreen | null;
  setPick(pick: ModelPick): void;
};

export const useStudyFlow = create<Flow>((set, get) => ({
  next: null,
  pick: typeof localStorage === "undefined" ? null : readPick(),
  goTo: (space, screen) => set({ next: { space, screen } }),
  take(space) {
    const n = get().next;
    if (!n || n.space !== space) return null;
    set({ next: null });
    return n.screen;
  },
  setPick(pick) {
    set({ pick });
    try {
      localStorage.setItem(PICK, JSON.stringify(pick));
    } catch {
      // Private window: the pick lasts for the session.
    }
  },
}));
