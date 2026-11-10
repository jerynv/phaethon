/**
 * The course context per space, shared by Study, Grades and Plan: which
 * course is selected (or none: all courses) and which courses the space can
 * see. Read again when the course sites change; a failed read keeps the last
 * context. The rules live in ../lib/selection.ts.
 */
import { useEffect } from "react";
import { create } from "zustand";

import { courseAccessGet } from "../api";
import { reachOf, type CourseReach } from "../lib/reach";
import { reconcile, resolveChoice, visibleCourses, type CourseChoice, type CourseSelection } from "../lib/selection";
import type { CourseInfo } from "../lib/types";
import { useSitesVersion } from "./signals";

type SpaceContext = { selected: CourseSelection | null; courses: CourseInfo[]; reach: CourseReach | null; loaded: boolean };
const EMPTY: SpaceContext = { selected: null, courses: [], reach: null, loaded: false };

type Store = {
  bySpace: Record<string, SpaceContext>;
  select(space: string, choice: CourseChoice | null): void;
  refresh(space: string): Promise<void>;
};

const generation = new Map<string, number>();

export const useCourseContextStore = create<Store>((set, get) => ({
  bySpace: {},
  select: (space, choice) => {
    const ctx = get().bySpace[space] ?? EMPTY;
    const selected = resolveChoice(ctx.courses, choice);
    if (ctx.selected?.key === selected?.key && ctx.selected?.folder === selected?.folder && ctx.selected?.name === selected?.name) return;
    set((s) => ({ bySpace: { ...s.bySpace, [space]: { ...ctx, selected } } }));
  },
  refresh: async (space) => {
    const gen = (generation.get(space) ?? 0) + 1;
    generation.set(space, gen);
    try {
      const view = await courseAccessGet(space);
      if (generation.get(space) !== gen) return;
      const courses = visibleCourses(view, space);
      const ctx = get().bySpace[space] ?? EMPTY;
      set((s) => ({ bySpace: { ...s.bySpace, [space]: { selected: reconcile(courses, ctx.selected), courses, reach: reachOf(view, space), loaded: true } } }));
    } catch {
      if (generation.get(space) !== gen) return;
      const ctx = get().bySpace[space] ?? EMPTY;
      set((s) => ({ bySpace: { ...s.bySpace, [space]: { ...ctx, loaded: true } } }));
    }
  },
}));

export function useCourseContext(space: string) {
  const ctx = useCourseContextStore((s) => s.bySpace[space] ?? EMPTY);
  const version = useSitesVersion();
  useEffect(() => {
    void useCourseContextStore.getState().refresh(space);
  }, [space, version]);
  return { ...ctx, select: (choice: CourseChoice | null) => useCourseContextStore.getState().select(space, choice) };
}
