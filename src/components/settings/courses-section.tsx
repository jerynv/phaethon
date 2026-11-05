import { Card, Checkbox } from "vic-ui";
import { useCallback, useEffect, useLayoutEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { cancelImport, openCourseImport, sitesChanged, useRun, useSitesVersion } from "@/components/lms/import-store";
import { connectionName, kindLabel, plural, whenText } from "@/components/lms/sites";
import { MaterialFiles } from "@/components/lms/material-files";
import { CourseContentBrowser } from "@/components/lms/course-content";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import "@/components/lms/lms.css";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import {
  COURSE_PARTS,
  courseAccessGet,
  courseAccessSet,
  lmsDisconnect,
  lmsConnections,
  type CourseAccessView,
  type CourseInfo,
  type CoursePart,
  type LmsConnection,
} from "@/lib/lms";
import { useActiveSpaceId, useSpaces, type Space } from "@/lib/spaces";

import { SectionHeader } from "./controls";
import { useStatus } from "./status";
import { CourseSiteMark } from "./course-site-mark";

/**
 * Settings › Course sites, for the whole vault: the course sites connected
 * (whether still signed in, when they last imported, how many courses), with
 * import more, import again, sign in again and sign out; then, for each
 * imported course, who can see it: a grid of spaces by parts of the course.
 */
export function CoursesSection({ headingId }: { headingId: string }) {
  const { spaces } = useSpaces();
  const active = useActiveSpaceId() ?? spaces[0]?.id ?? "";
  const [list, setList] = useState<LmsConnection[] | null>(null);
  const [access, setAccess] = useState<CourseAccessView | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<"access" | "content">("access");
  const [overview, setOverview] = useState<"courses" | "sites">("courses");
  const importRef = useRef<HTMLButtonElement>(null);
  const run = useRun();
  const runEnded = run && run.status !== "running" ? run.key : 0;
  const changed = useSitesVersion();

  const load = useCallback(() => {
    Promise.all([lmsConnections(), courseAccessGet()]).then(
      ([cs, a]) => {
        setList(cs);
        setAccess(a);
        setError("");
      },
      (e: unknown) => setError(String(e)),
    );
  }, []);
  // Again once an import ends (its last import and courses changed), or a sign-in finished.
  useEffect(load, [load, runEnded, changed]);

  const course = access?.courses.find(c => c.key === selected);
  const canRead = (id: string) => !!course && (access?.access[id]?.[course.key]?.length ?? 0) > 0;
  const viewerSpace = canRead(active) ? active : spaces.find(s => canRead(s.id))?.id;
  const previous = useRef("");
  useLayoutEffect(() => {
    if (selected) document.getElementById(headingId)?.focus();
    else if (previous.current) document.querySelector<HTMLElement>(`[data-course-select="${CSS.escape(previous.current)}"]`)?.focus();
    previous.current = selected;
  }, [selected, headingId]);

  return <>
    <SectionHeader id={headingId} title={course?.name ?? "Course sites"} action={course ? <Button type="button" variant="ghost" size="sm" data-course-back="" onClick={() => setSelected("")}><Icon name="chevron-left" />Courses</Button> : <Button ref={importRef} type="button" size="sm" data-sites-import="" onClick={() => openCourseImport({ space: active })}><Icon name="plus" />Connect site</Button>} />
    {run?.status === "running" && <div className="flex flex-wrap items-center gap-2 rounded-md bg-accent-soft px-3 py-2 text-sm" data-course-import-active="">
      <Icon name="spinner" className="size-3.5 shrink-0 text-accent-soft-ink motion-safe:animate-spin" />
      <span className="min-w-0 flex-1 text-accent-soft-ink">Importing · {run.courses.filter(c => c.result).length}/{run.courses.length} courses</span>
      <Button type="button" variant="ghost" size="xs" onClick={() => openCourseImport({ space: run.space, at: "run" })}>Details</Button>
      <Button type="button" variant="ghost" size="xs" className="text-danger-ink" disabled={run.cancelling} onClick={() => void cancelImport()} data-settings-import-cancel="">{run.cancelling ? "Stopping…" : "Stop"}</Button>
    </div>}
    {error ? <p role="alert" className="text-sm text-danger-ink">{error}</p> : list === null || access === null ? <p role="status" className="text-sm text-ink-secondary">Loading course sites…</p> : course ? <div className="lms-course-panel flex min-h-0 flex-col gap-3" data-course-detail={course.key}>
      <div className="flex w-fit items-center gap-1 rounded-lg bg-selected p-1" role="group" aria-label="Course settings">
        <button type="button" aria-pressed={mode === "access"} onClick={() => setMode("access")} className={cn("rounded-md px-2.5 py-1.5 text-sm", mode === "access" ? "bg-selected text-ink" : "text-ink-secondary hover:bg-hover")}>Space access</button>
        <button type="button" aria-pressed={mode === "content"} onClick={() => setMode("content")} data-browse-course="" className={cn("rounded-md px-2.5 py-1.5 text-sm", mode === "content" ? "bg-selected text-ink" : "text-ink-secondary hover:bg-hover")}>Browse content</button>
      </div>
      {mode === "access" ? <AccessGrid key={course.key} course={course} spaces={spaces} access={access.access} viewerSpace={viewerSpace} onSaved={(space, parts) => setAccess(a => a ? { ...a, access: { ...a.access, [space]: { ...(a.access[space] ?? {}), [course.key]: parts } } } : a)} /> : viewerSpace ? <CourseContentBrowser key={`${course.key}/${viewerSpace}`} course={course} space={viewerSpace} /> : <p className="text-sm text-ink-secondary">Give a space access to browse this course.</p>}
    </div> : <>
      <div className="flex w-fit gap-1 rounded-lg bg-selected p-1" role="group" aria-label="Course sites view">
        <button type="button" data-course-overview-tab="courses" aria-pressed={overview === "courses"} onClick={() => setOverview("courses")} className={cn("rounded-md px-2.5 py-1.5 text-sm", overview === "courses" ? "bg-selected text-ink" : "text-ink-secondary hover:bg-hover")}>Courses <span className="ms-1 text-xs text-ink-tertiary">{access.courses.length}</span></button>
        <button type="button" data-course-overview-tab="sites" aria-pressed={overview === "sites"} onClick={() => setOverview("sites")} className={cn("rounded-md px-2.5 py-1.5 text-sm", overview === "sites" ? "bg-selected text-ink" : "text-ink-secondary hover:bg-hover")}>Connected sites <span className="ms-1 text-xs text-ink-tertiary">{list.length}</span></button>
      </div>
      {overview === "sites" ? <Card look="lifted" flush className="rounded-xl border border-line shadow-none!"><div data-course-sites="" className="flex flex-col gap-1 p-1">
        {!list.length && <p className="py-4 text-sm text-ink-secondary">No site connected</p>}
        {list.map(c => <SiteRow key={c.id} space={active} connection={c} onSignedOut={load} />)}
      </div></Card> : <div className="flex min-h-0 flex-col gap-3" data-course-navigator="">
        {access.courses.length > 5 && <Input aria-label="Find imported course" placeholder="Find a course…" value={filter} onChange={e => setFilter(e.target.value)} />}
        <Card look="lifted" flush className="rounded-xl border border-line shadow-none!"><div className="max-h-80 overflow-y-auto overscroll-contain p-1" aria-label="Imported courses">
          {access.courses.filter(c => `${c.name} ${c.code ?? ""} ${c.term ?? ""}`.toLowerCase().includes(filter.toLowerCase())).map(c => <button key={c.key} type="button" data-course-select={c.key} onClick={() => { setSelected(c.key); setMode("access"); }} className="flex w-full min-w-0 items-center gap-3 rounded-md px-3 py-2.5 text-start hover:bg-hover">
            <Icon name="book" className="size-4 shrink-0 text-ink-tertiary" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{c.name}</span><span className="block truncate text-xs text-ink-tertiary">{[c.code, c.term].filter(Boolean).join(" · ")}</span></span><Icon name="chevron-right" className="size-3.5 shrink-0 text-ink-tertiary" />
          </button>)}
          {!access.courses.length && <div className="flex items-center justify-between gap-3 py-4"><p className="text-sm text-ink-secondary">No courses imported</p><Button type="button" variant="outline" size="sm" onClick={() => openCourseImport({ space: active })}>Choose courses</Button></div>}
        </div></Card>
        {access.problems.length > 0 && <details data-access-problems="" className="text-xs text-warning-ink"><summary>Course access needs attention</summary><ul>{access.problems.map(problem => <li key={problem}>{problem}</li>)}</ul></details>}
      </div>}
    </>}
  </>;
}

function SiteRow({ space, connection: c, onSignedOut }: { space: string; connection: LmsConnection; onSignedOut: () => void }) {
  const { say, fail } = useStatus();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const askId = useId();
  const nameId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const signOutRef = useRef<HTMLButtonElement>(null);
  const name = connectionName(c);
  const n = c.courses.length;

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  async function signOut() {
    setBusy(true);
    try {
      await lmsDisconnect(c.id);
      say(`Signed out of ${name}.`.trim());
      setConfirming(false);
      setBusy(false);
      onSignedOut();
      sitesChanged();
    } catch (e) {
      fail(`Phaethon couldn’t sign out of ${name}. ${String(e)}`);
      setBusy(false);
    }
  }

  return (
    <div className="lms-connected-row flex flex-wrap items-center gap-2 rounded-lg px-3 py-2.5" data-site-row={c.id} data-signed-in={c.signedIn ? "" : undefined}>
      <button type="button" onClick={() => openCourseImport({ space, connection: c.id, at: c.signedIn ? "choose" : "signin" })} className="flex min-w-0 flex-[1_1_12rem] items-center gap-3 rounded-md text-start hover:bg-hover"><CourseSiteMark connection={c} /><span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={nameId} className="text-sm font-medium wrap-anywhere text-ink">
          {name}
        </span>

        <span className="flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary" data-site-status="">
          <Icon name={c.signedIn ? "success" : "warning"} className={c.signedIn ? "size-(--ph-icon-size-sm) text-success-ink" : "size-(--ph-icon-size-sm) text-warning-ink"} />
          <span>{kindLabel(c.kind)}</span><span aria-hidden="true">·</span><span data-site-imported="">{plural(n, "course", "courses")}</span>{c.lastSync && <><span aria-hidden="true">·</span><time dateTime={new Date(c.lastSync).toISOString()} title={whenText(c.lastSync)} data-site-synced="">Updated {new Date(c.lastSync).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time></>}<span className="sr-only">{c.signedIn ? "Connected" : "Signed out"}</span>
        </span>
      </span></button>
      {confirming ? (
        <div className="flex flex-col gap-2 rounded-md bg-surface px-3 py-2.5" data-site-confirm="">
          <p id={askId} className="text-sm text-ink">
            Disconnect {name}? Imported files stay available.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button ref={confirmRef} type="button" variant="destructive" size="sm" disabled={busy} aria-describedby={askId} onClick={() => void signOut()} data-site-confirm-yes="">
              Sign out
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirming(false);
                requestAnimationFrame(() => signOutRef.current?.focus());
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby={nameId}>
          {c.signedIn ? (
            <>
              <Button type="button" variant="outline" size="sm" data-site-action="more" onClick={() => openCourseImport({ space, connection: c.id, at: "choose" })}>
                <Icon name="plus" />Courses
              </Button>
              {n > 0 ? (
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Refresh ${name}`} title="Refresh courses" data-site-action="sync" onClick={() => openCourseImport({ space, connection: c.id, at: "sync" })}>
                  <Icon name="retry" />
                </Button>
              ) : <span className="size-(--ph-control-height-sm) shrink-0" aria-hidden="true" />}
              <Button ref={signOutRef} type="button" variant="ghost" size="icon-sm" aria-label={`Disconnect ${name}`} title="Disconnect" className="text-ink-tertiary" data-site-action="signout" onClick={() => setConfirming(true)}><Icon name="close" /></Button>
            </>
          ) : (
            <Button type="button" variant="outline" size="sm" data-site-action="signin" onClick={() => openCourseImport({ space, connection: c.id, at: "signin" })}>
              <Icon name="lock" />
              Reconnect
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Cells in a row of the grid: All and None (in the row header), then the six parts. */
const COLS = COURSE_PARTS.length + 2;
const ALL_PARTS = COURSE_PARTS.map((p) => p.part);

/**
 * Who can see one course: a table of spaces (rows) by parts (columns), each
 * cell a checkbox, and All / None beside each space's name. One stop in the Tab order: the
 * arrow keys move between cells (Home and End to a row's ends, Ctrl+Home and
 * Ctrl+End to the corners), Space checks. Each change saves at once and is
 * said in the settings status.
 */
function AccessGrid({
  course,
  spaces,
  access,
  onSaved,
  viewerSpace,
}: {
  course: CourseInfo;
  spaces: readonly Space[];
  access: CourseAccessView["access"];
  onSaved: (space: string, parts: CoursePart[]) => void;
  viewerSpace?: string;
}) {
  const { say, fail } = useStatus();
  const captionId = useId();
  const tableRef = useRef<HTMLTableElement>(null);
  const [at, setAt] = useState<[number, number]>([0, 2]);
  const [saving, setSaving] = useState<string | null>(null);
  const partsOf = (space: string) => access[space]?.[course.key] ?? [];
  const label = [course.code && !course.name.includes(course.code) ? course.code : null, course.term].filter(Boolean).join(" · ");

  async function save(space: Space, parts: CoursePart[], words: string) {
    // One change at a time per space; controls stay enabled so focus never drops.
    if (saving === space.id) return;
    const before = partsOf(space.id);
    setSaving(space.id);
    onSaved(space.id, parts);
    try {
      await courseAccessSet(space.id, course.key, parts);
      say(words);
      sitesChanged();
    } catch (e) {
      onSaved(space.id, before);
      fail(`That couldn’t be saved. ${String(e)}`);
    } finally {
      setSaving(null);
    }
  }

  function toggle(space: Space, part: CoursePart, on: boolean) {
    const now = partsOf(space.id);
    const parts = ALL_PARTS.filter((p) => (p === part ? on : now.includes(p)));
    const what = COURSE_PARTS.find((p) => p.part === part)!.label.toLowerCase();
    void save(space, parts, on ? `${space.name} can now see the ${what} of ${course.name}.` : `${space.name} can no longer see the ${what} of ${course.name}.`);
  }

  const cell = (r: number, c: number) => tableRef.current?.querySelector<HTMLElement>(`[data-cell="${r}:${c}"]`);
  function onKeyDown(e: KeyboardEvent<HTMLTableElement>) {
    const [r, c] = at;
    const last = spaces.length - 1;
    let next: [number, number] | null = null;
    if (e.key === "ArrowRight") next = [r, Math.min(c + 1, COLS - 1)];
    else if (e.key === "ArrowLeft") next = [r, Math.max(c - 1, 0)];
    else if (e.key === "ArrowDown") next = [Math.min(r + 1, last), c];
    else if (e.key === "ArrowUp") next = [Math.max(r - 1, 0), c];
    else if (e.key === "Home") next = e.ctrlKey || e.metaKey ? [0, 0] : [r, 0];
    else if (e.key === "End") next = e.ctrlKey || e.metaKey ? [last, COLS - 1] : [r, COLS - 1];
    else if (e.key === "Enter" && (e.target as HTMLElement).matches('input[type="checkbox"]')) {
      e.preventDefault();
      (e.target as HTMLInputElement).click();
      return;
    }
    if (!next) return;
    e.preventDefault();
    setAt(next);
    cell(next[0], next[1])?.focus();
  }
  const stop = (r: number, c: number) => (at[0] === r && at[1] === c ? 0 : -1);
  const onFocusCell = (r: number, c: number) => () => setAt([r, c]);

  return (
    <div className="flex flex-col gap-2 py-1" data-access-course={course.key}>
      <div className="flex flex-col">
        <h5 id={captionId} className="sr-only">
          {course.name}
        </h5>
        {label && <p className="text-sm text-ink-secondary">{label}</p>}
      </div>
      <MaterialFiles summary={course.material} space={viewerSpace && partsOf(viewerSpace).includes("files") ? viewerSpace : spaces.find(s => partsOf(s.id).includes("files"))?.id} folder={course.folder} />
      {/* A data table: wider than a narrow window, it scrolls sideways on its own, never the page. */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <table ref={tableRef} role="grid" aria-labelledby={captionId} onKeyDown={onKeyDown} className="w-max min-w-full border-collapse text-sm" data-access-grid={course.key}>
          <thead>
            <tr>
              <th scope="col" className="px-2 py-1.5 text-start font-medium text-ink-secondary">
                Space
              </th>
              {COURSE_PARTS.map((p) => (
                <th key={p.part} scope="col" title={p.hint} className="px-1 py-1.5 text-center font-medium text-ink-secondary" data-part-head={p.part}>
                  {p.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spaces.map((s, r) => {
              const parts = partsOf(s.id);
              return (
                <tr key={s.id} className="border-t border-line" data-access-row={s.id}>
                  {/* The space, then All and None for its row (cells 0 and 1). */}
                  <th scope="row" aria-label={s.name} className="max-w-(--ph-measure) px-2 py-1 text-start font-medium break-words text-ink">
                    <span className="block">{s.name}</span>
                    <span className="-ms-2 flex gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        tabIndex={stop(r, 0)}
                        onFocus={onFocusCell(r, 0)}
                        aria-label={`${s.name}: all of ${course.name}`}
                        onClick={() => void save(s, [...ALL_PARTS], `${s.name} can now see all of ${course.name}.`)}
                        data-cell={`${r}:0`}
                        data-access-all=""
                      >
                        All
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        tabIndex={stop(r, 1)}
                        onFocus={onFocusCell(r, 1)}
                        aria-label={`${s.name}: none of ${course.name}`}
                        onClick={() => void save(s, [], `${s.name} can no longer see ${course.name}.`)}
                        data-cell={`${r}:1`}
                        data-access-none=""
                      >
                        None
                      </Button>
                    </span>
                  </th>
                  {COURSE_PARTS.map((p, i) => (
                    <td key={p.part} role="gridcell" className="px-1 py-1 text-center">
                      <Checkbox
                        aria-label={`${s.name}: ${p.label}`}
                        checked={parts.includes(p.part)}
                        tabIndex={stop(r, i + 2)}
                        onFocus={onFocusCell(r, i + 2)}
                        onChange={(e) => toggle(s, p.part, e.target.checked)}
                        data-cell={`${r}:${i + 2}`}
                        data-access-part={p.part}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>

        </table>
      </div>
    </div>
  );
}
