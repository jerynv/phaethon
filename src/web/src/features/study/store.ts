/**
 * Where Study is in each space (the hub, a review, a deck, a quiz), kept while
 * the app runs so switching views comes back to the same place, and the make
 * wizard's request.
 */
import { create } from "zustand";

export type StudyScreen =
  | { kind: "hub" }
  | { kind: "session"; paths: string[] | null; title: string; dueOnly: boolean }
  | { kind: "deck"; path: string }
  | { kind: "quiz"; path: string; arrived?: boolean };

export type MakeKind = "deck" | "quiz";
export type MakeRequest = {
  key: number;
  kind: MakeKind | null;
  /** The course folder to start with ("courses/X"). */
  course?: string;
  /** Make cards from a quiz attempt's mistakes: no form, it starts at once. */
  fromAttempt?: { path: string; sources: string[]; quizTitle: string };
};

type Store = {
  screens: Record<string, StudyScreen>;
  /** What the hub last left from, so focus goes back there. */
  leftFrom: Record<string, string | undefined>;
  make: Record<string, MakeRequest | null>;
  show(space: string, screen: StudyScreen, leftFrom?: string): void;
  openMake(space: string, r: Omit<MakeRequest, "key">): void;
  closeMake(space: string): void;
};

let makeKey = 1;

export const useStudyStore = create<Store>((set) => ({
  screens: {},
  leftFrom: {},
  make: {},
  show: (space, screen, leftFrom) =>
    set((s) => ({ screens: { ...s.screens, [space]: screen }, leftFrom: leftFrom === undefined ? s.leftFrom : { ...s.leftFrom, [space]: leftFrom } })),
  openMake: (space, r) => set((s) => ({ make: { ...s.make, [space]: { ...r, key: makeKey++ } } })),
  closeMake: (space) => set((s) => ({ make: { ...s.make, [space]: null } })),
}));
