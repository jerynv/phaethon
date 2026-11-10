/**
 * One import at a time, kept outside the dialog: closing it never stops the
 * import, and opening it again shows where it is. The run's rules are in
 * lib/import-run.ts; this wires them to `lms_import`.
 */
import { create } from "zustand";

import { lmsImport, lmsImportCancel } from "./api";
import { applyImportEvent, finishRun, newRun, type CourseRun, type Run } from "./lib/import-run";
import { isCancelled } from "./lib/sites";
import type { LmsCourse } from "./lib/types";
import { announce } from "./shared/announce";
import { sitesChanged } from "./shared/signals";

type Store = {
  run: Run | null;
  /** The run finished while nobody was looking at it. */
  unseen: boolean;
  start(space: string, spaces: string[], connection: string, school: string, courses: Pick<LmsCourse, "id" | "name">[]): boolean;
  cancel(): Promise<void>;
  clear(): void;
  markSeen(): void;
};

let runKey = 1;

export const useImportRun = create<Store>((set, get) => ({
  run: null,
  unseen: false,
  start: (space, spaces, connection, school, courses) => {
    if (get().run?.status === "running") return false;
    const key = runKey++;
    set({ run: newRun(key, space, spaces, connection, school, courses), unseen: false });
    const mine = () => {
      const r = get().run;
      return r && r.key === key ? r : null;
    };
    const onCourse = (c: CourseRun) => announce(c.result ? `${c.name} imported.` : `${c.name} wasn’t imported: ${c.failed}`);
    void lmsImport(connection, courses.map((c) => c.id), spaces, (e) => {
      const r = mine();
      if (!r) return;
      const { run, course } = applyImportEvent(r, e);
      if (run !== r) set({ run });
      if (course) onCourse(course);
    }).then((end) => {
      const r = mine();
      if (r && r.status === "running") {
        const next =
          end.kind === "rejected"
            ? isCancelled(end.error)
              ? finishRun(r, "cancelled", undefined, "Stopped")
              : finishRun(r, "failed", String(end.error))
            : finishRun(r, "done");
        set({ run: next });
      }
      sitesChanged();
    });
    return true;
  },
  cancel: async () => {
    const active = get().run;
    if (!active || active.status !== "running" || active.cancelling) return;
    set({ run: { ...active, cancelling: true, cancelError: undefined } });
    try {
      const accepted = await lmsImportCancel(active.connection);
      const r = get().run;
      if (r?.key === active.key && r.status === "running" && !accepted) set({ run: { ...r, cancelling: false, cancelError: "The import is finishing. Try again in a moment." } });
    } catch (e) {
      const r = get().run;
      if (r?.key === active.key && r.status === "running") set({ run: { ...r, cancelling: false, cancelError: String(e) } });
    }
  },
  clear: () => {
    if (get().run?.status !== "running") set({ run: null, unseen: false });
  },
  markSeen: () => set({ unseen: false }),
}));
