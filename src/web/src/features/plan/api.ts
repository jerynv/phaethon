/** Typed calls for Plan (the old Tauri commands, one to one). */
import { invoke } from "@/lib/core";

/** `folder` is the name under courses/, without the prefix; `link` is space-relative and may carry #anchor. */
export type Upcoming = { course: string; folder: string; title: string; due: number; link: string };
export type CourseRef = { name: string; folder: string };
export type Exam = { id: string; course?: string; title: string; date: string };
export type PlanState = { studyDays: number[]; sessionsPerDay: number; sessionMinutes: number; done: string[] };

export const DEFAULT_STATE: PlanState = { studyDays: [0, 1, 2, 3, 4, 5], sessionsPerDay: 3, sessionMinutes: 25, done: [] };

export const planUpcoming = (space: string) => invoke<{ courses: CourseRef[]; items: Upcoming[] }>("plan_upcoming", { space });
export const planExamsGet = (space: string) => invoke<Exam[]>("plan_exams_get", { space });
export const planExamsSet = (space: string, exams: Exam[]) => invoke<Exam[]>("plan_exams_set", { space, exams });
export const planSave = (space: string, markdown: string) => invoke<string>("plan_save", { space, markdown });
export const planStateGet = (space: string) => invoke<PlanState>("plan_state_get", { space });
export const planStateSet = (space: string, planState: PlanState) => invoke<PlanState>("plan_state_set", { space, planState });
