import { useEffect, useSyncExternalStore } from "react";

import { courseAccessGet, type CourseInfo } from "@/lib/lms";
import { inTauri } from "@/lib/tauri";

export type CourseSelection = Pick<CourseInfo, "key" | "folder" | "name">;
type CourseChoice = { key?: string; connection?: string; courseId?: string; folder: string; name: string };
type SelectionState = { selected: CourseSelection | null; courses: readonly CourseInfo[] };
const EMPTY: SelectionState = { selected: null, courses: [] };
const states = new Map<string, SelectionState>();
const listeners = new Set<() => void>();
const requests = new Map<string, { revision: number; generation: number }>();
const folderKey = (folder: string) => folder.replace(/^courses\//, "");
const emit = () => listeners.forEach(listener => listener());

/** One canonical course context per space; each view keeps its own content and scroll position. */
export function selectCourse(space: string, choice: CourseChoice | null): void {
  const state = states.get(space) ?? EMPTY;
  const imported = choice && state.courses.find(course => course.key === choice.key || folderKey(course.folder) === folderKey(choice.folder));
  const selected = !choice ? null : imported ? { key: imported.key, folder: imported.folder, name: imported.name } : {
    key: choice.key ?? (choice.connection && choice.courseId ? `${choice.connection}/${choice.courseId}` : `folder:${folderKey(choice.folder)}`),
    folder: choice.folder,
    name: choice.name,
  };
  if (state.selected?.key === selected?.key && state.selected?.folder === selected?.folder && state.selected?.name === selected?.name) return;
  states.set(space, { ...state, selected });
  emit();
}

/** Import/access refreshes reconcile removed courses; a hidden view must not clear another view's choice. */
export function useCourseSelection(space: string, revision = 0) {
  const state = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => states.get(space) ?? EMPTY,
  );
  useEffect(() => {
    if (!inTauri() || requests.get(space)?.revision === revision) return;
    const generation = (requests.get(space)?.generation ?? 0) + 1;
    requests.set(space, { revision, generation });
    void courseAccessGet(space).then(result => {
      if (requests.get(space)?.generation !== generation) return;
      const courses = result.courses.filter(course => (result.access[space]?.[course.key]?.length ?? 0) > 0);
      const before = states.get(space) ?? EMPTY;
      const picked = before.selected;
      const imported = picked && courses.find(course => course.key === picked.key || folderKey(course.folder) === folderKey(picked.folder));
      const selected = !picked ? null : imported ? { key: imported.key, folder: imported.folder, name: imported.name } : picked.key.startsWith("folder:") ? picked : null;
      states.set(space, { selected, courses });
      emit();
    }, () => { /* Preserve the last context when the metadata read fails. */ });
  }, [space, revision]);
  return { ...state, select: (choice: CourseChoice | null) => selectCourse(space, choice) };
}
