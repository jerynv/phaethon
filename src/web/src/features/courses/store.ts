/**
 * Course sites for the whole vault, shared by the Courses view and Settings ›
 * Courses: connections, the access map across spaces, and the one import that
 * may be running. The run is moved along by lib/import-run.ts and ends on the
 * stream's terminal event (lib/stream.ts).
 */
import { create } from "zustand";
import { cleanMessage } from "@/components/errors";
import { toast } from "@/components/toast";
import * as api from "./api";
import { applyImportEvent, finishRun, newRun, type Run } from "./lib/import-run";
import { connectionName } from "./lib/sites";
import type { CourseAccessView, CoursePart, LmsConnection, LmsCourse, SpaceSummary } from "./lib/types";

type Load<T> = { data?: T; error?: string; loading: boolean };

type Courses = {
  connections: Load<LmsConnection[]>;
  access: Load<CourseAccessView>;
  spaces: SpaceSummary[];
  run: Run | null;
  load(): Promise<void>;
  loadConnections(): Promise<void>;
  loadAccess(): Promise<void>;
  setParts(space: string, course: string, parts: CoursePart[]): Promise<void>;
  startImport(connection: LmsConnection, courses: Pick<LmsCourse, "id" | "name">[], spaces: string[], space: string): void;
  cancelImport(): Promise<void>;
  dismissRun(): void;
  disconnect(id: string): Promise<void>;
};

let runKey = 0;

export const useCourses = create<Courses>((set, get) => ({
  connections: { loading: true },
  access: { loading: true },
  spaces: [],
  run: null,

  async load() {
    await Promise.all([get().loadConnections(), get().loadAccess(), api.spacesList().then((spaces) => set({ spaces }), () => {})]);
  },

  async loadConnections() {
    set((s) => ({ connections: { ...s.connections, loading: true, error: undefined } }));
    try {
      set({ connections: { data: await api.lmsConnections(), loading: false } });
    } catch (e) {
      set((s) => ({ connections: { ...s.connections, loading: false, error: cleanMessage(e) } }));
    }
  },

  async loadAccess() {
    set((s) => ({ access: { ...s.access, loading: true, error: undefined } }));
    try {
      set({ access: { data: await api.courseAccessGet(), loading: false } });
    } catch (e) {
      set((s) => ({ access: { ...s.access, loading: false, error: cleanMessage(e) } }));
    }
  },

  async setParts(space, course, parts) {
    const before = get().access.data;
    if (!before) return;
    const forSpace = { ...(before.access[space] ?? {}) };
    if (parts.length) forSpace[course] = parts;
    else delete forSpace[course];
    set({ access: { data: { ...before, access: { ...before.access, [space]: forSpace } }, loading: false } });
    try {
      await api.courseAccessSet(space, course, parts);
    } catch (e) {
      set((s) => ({ access: { ...s.access, data: before } }));
      toast.error("Access wasn’t changed", cleanMessage(e));
    }
  },

  startImport(connection, courses, spaces, space) {
    if (get().run?.status === "running") return;
    const key = ++runKey;
    set({ run: newRun(key, space, spaces, connection.id, connectionName(connection), courses) });
    const mine = () => get().run?.key === key;
    void api
      .lmsImport(connection.id, courses.map((c) => c.id), spaces, (e) => {
        const r = get().run;
        if (!r || r.key !== key) return;
        set({ run: applyImportEvent(r, e).run });
      })
      .then((end) => {
        const r = get().run;
        if (!r || !mine()) return;
        if (end.kind === "rejected") set({ run: finishRun(r, "failed", cleanMessage(end.error)) });
        else if (end.kind === "timedOut") set({ run: finishRun(r, "done") });
      })
      .finally(() => {
        void get().loadConnections();
        void get().loadAccess();
      });
  },

  async cancelImport() {
    const r = get().run;
    if (!r || r.status !== "running") return;
    set({ run: { ...r, cancelling: true, cancelError: undefined } });
    try {
      await api.lmsImportCancel(r.connection);
    } catch (e) {
      const now = get().run;
      if (now?.key === r.key) set({ run: { ...now, cancelling: false, cancelError: cleanMessage(e) } });
    }
  },

  dismissRun() {
    if (get().run?.status !== "running") set({ run: null });
  },

  async disconnect(id) {
    await api.lmsDisconnect(id);
    await get().loadConnections();
  },
}));

/** Parts a space sees of a course. */
export function partsOf(view: CourseAccessView | undefined, space: string, course: string): CoursePart[] {
  return view?.access[space]?.[course] ?? NO_PARTS;
}

const NO_PARTS: CoursePart[] = [];
