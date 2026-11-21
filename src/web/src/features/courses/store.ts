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
import type { CourseAccessView, CourseInfo, CoursePart, LmsConnection, LmsCourse, SpaceSummary } from "./lib/types";

type ImportSite = { connection: LmsConnection; courses: Pick<LmsCourse, "id" | "name">[] };

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
  startUpdate(space: string, courses: CourseInfo[]): void;
  cancelImport(): Promise<void>;
  dismissRun(): void;
  disconnect(id: string): Promise<void>;
};

let runKey = 0;

/** The core imports one site at a time. Keep one run and progress bar across all sites. */
async function importSites(sites: ImportSite[], run: Run, get: () => Courses, set: (s: Partial<Courses>) => void) {
  let offset = 0;
  let notes: string[] = [];
  let error: string | undefined;
  let signInConnection: string | undefined;
  for (const { connection, courses } of sites) {
    let site: Run = { ...newRun(run.key, run.space, run.spaces, connection.id, connectionName(connection), courses), update: run.update };
    const publish = () => {
      const current = get().run!;
      const rows = current.courses.slice();
      rows.splice(offset, courses.length, ...site.courses.map((c) => ({ ...c, id: run.update ? `${connection.id}/${c.id}` : c.id })));
      set({ run: { ...current, connection: connection.id, courses: rows, notes: [...notes, ...(site.notes ?? [])] } });
    };
    publish();
    const end = await api.lmsImport(
      connection.id,
      courses.map((c) => c.id),
      run.spaces,
      (event) => {
        site = applyImportEvent(site, event).run;
        publish();
      },
      run.update,
    );
    if (end.kind === "rejected") site = finishRun(site, "failed", cleanMessage(end.error));
    if (end.kind === "timedOut") site = finishRun(site, "failed", "The course site didn’t finish responding.");
    publish();
    offset += courses.length;
    notes = get().run?.notes ?? [];
    error ??= site.error;
    signInConnection ??= site.signInConnection;
    const current = get().run!;
    if (site.status === "cancelled" || current.cancelling) {
      set({ run: finishRun(current, "cancelled", undefined, "Stopped") });
      return;
    }
  }
  const current = get().run!;
  const incomplete = run.update && current.courses.some((c) => !c.result);
  set({ run: finishRun({ ...current, signInConnection }, error || incomplete ? "failed" : "done", error) });
}

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
    const run = newRun(key, space, spaces, connection.id, connectionName(connection), courses);
    set({ run });
    void importSites([{ connection, courses }], run, get, set).finally(get().load);
  },

  startUpdate(space, courses) {
    if (get().run?.status === "running") return;
    const targets = new Map<string, ImportSite>();
    const connections = new Map(get().connections.data?.map((c) => [c.id, c]));
    for (const c of courses) {
      const connection = connections.get(c.connection);
      if (!connection) continue;
      const site = targets.get(connection.id) ?? { connection, courses: [] };
      site.courses.push({ id: c.courseId, name: c.name });
      targets.set(connection.id, site);
    }
    const sites = [...targets.values()];
    if (!sites.length) return;
    const rows = sites.flatMap(({ connection, courses }) => courses.map((c) => ({ id: `${connection.id}/${c.id}`, name: c.name })));
    const school = sites.length === 1 ? connectionName(sites[0].connection) : "";
    const run = { ...newRun(++runKey, space, [], sites[0].connection.id, school, rows), update: true };
    set({ run });
    void importSites(sites, run, get, set).finally(get().load);
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
