import { invoke } from "@tauri-apps/api/core";

import { inTauri } from "@/lib/tauri";
import { requestStudy, setSpaceView, type SpaceView } from "@/components/study/space-view";

/**
 * The study planner's commands (src-tauri/src/plan.rs). Each knows its one
 * file in the space; nothing here names a path.
 */
export type Upcoming = { course: string; folder: string; title: string; /** ms since the epoch */ due: number; /** relative to the space */ link: string };
export type CourseRef = { name: string; folder: string };
export type Exam = { id: string; course?: string; title: string; /** YYYY-MM-DD */ date: string };
export type PlanState = { studyDays: number[]; sessionsPerDay: number; sessionMinutes: number; done: string[] };

export const DEFAULT_STATE: PlanState = { studyDays: [0, 1, 2, 3, 4, 5], sessionsPerDay: 3, sessionMinutes: 25, done: [] };

export const planUpcoming = (space: string) =>
  inTauri() ? invoke<{ courses: CourseRef[]; items: Upcoming[] }>("plan_upcoming", { space }) : Promise.resolve({ courses: [], items: [] });
export const planExamsGet = (space: string) => (inTauri() ? invoke<Exam[]>("plan_exams_get", { space }) : Promise.resolve([]));
export const planExamsSet = (space: string, exams: Exam[]) => (inTauri() ? invoke<Exam[]>("plan_exams_set", { space, exams }) : Promise.resolve(exams));
export const planSave = (space: string, markdown: string) => (inTauri() ? invoke<string>("plan_save", { space, markdown }) : Promise.resolve("study/plan.md"));
export const planStateGet = (space: string) => (inTauri() ? invoke<PlanState>("plan_state_get", { space }) : Promise.resolve(DEFAULT_STATE));
export const planStateSet = (space: string, planState: PlanState) =>
  inTauri() ? invoke<PlanState>("plan_state_set", { space, planState }) : Promise.resolve(planState);

/**
 * Each course's decks (course → deck titles), from the study engine's
 * overview when it is there; empty otherwise, and the plan just has no deck links.
 */
export async function decksByCourse(space: string): Promise<Record<string, string[]>> {
  if (!inTauri()) return {};
  try {
    const o = await invoke<{ decks?: { title: string; course?: string }[] }>("study_overview", { space });
    const out: Record<string, string[]> = {};
    for (const d of o.decks ?? []) if (d.course) (out[d.course] ??= []).push(d.title);
    return out;
  } catch {
    return {};
  }
}

/** Show a space's view (or study one of its decks, by title) through the view switcher. */
export type SpaceViewRequest = { space: string; view: SpaceView; deck?: string };
export const requestSpaceView = (r: SpaceViewRequest) =>
  r.view === "study" && r.deck ? requestStudy(r.space, "review", r.deck) : setSpaceView(r.space, r.view, true);
