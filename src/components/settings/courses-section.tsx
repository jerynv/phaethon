import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { openCourseImport, sitesChanged, useRun, useSitesVersion } from "@/components/lms/import-store";
import { connectionName, hostOf, kindLabel, plural, whenText } from "@/components/lms/sites";
import { MaterialLines } from "@/components/study/material-note";
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

import { SectionHeader, SettingGroup } from "./controls";
import { useStatus } from "./status";

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

  return (
    <>
      <SectionHeader
        id={headingId}
        title="Course sites"
        description="The school course sites (Canvas, Brightspace, Moodle, Blackboard) your courses come from. One sign-in serves all your spaces, kept in your keychain on this computer, and you choose which spaces see which courses. Phaethon only reads from a course site: it never changes anything there."
      />
      {error ? (
        <p role="alert" className="flex items-start gap-2 px-1 text-sm text-danger-ink">
          <Icon name="error" className="mt-0.5 shrink-0" />
          <span className="min-w-0 wrap-break-word">Your course sites couldn’t be read. {error}</span>
        </p>
      ) : list === null || access === null ? (
        <p className="px-1 text-sm text-ink-secondary">Loading…</p>
      ) : (
        <>
          <SettingGroup title="Connected sites">
            <div data-course-sites="" className="flex flex-col divide-y divide-line">
              {list.length === 0 && <p className="px-4 pt-3.5 text-sm text-ink-secondary">No course site connected.</p>}
              {list.map((c) => (
                <SiteRow key={c.id} space={active} connection={c} onSignedOut={load} />
              ))}
              <div className="px-4 py-3">
                <Button ref={importRef} type="button" variant="outline" size="sm" data-sites-import="" onClick={() => openCourseImport({ space: active })}>
                  <Icon name="plus" />
                  {list.length ? "Connect another course site…" : "Import courses…"}
                </Button>
              </div>
            </div>
          </SettingGroup>
          {access.courses.length > 0 && (
            <SettingGroup
              title="Who can see each course"
              description="Check what each space can see. The assistant in a space reads only what’s checked for it, and so do its study, grades and plan views."
              bare
            >
              {access.problems.length > 0 && (
                <div className="flex flex-col gap-1 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning-ink forced-colors:border forced-colors:border-[CanvasText]" data-access-problems="">
                  <p className="font-medium">Some lines of course-access.json were skipped:</p>
                  <ul className="flex list-disc flex-col ps-4">
                    {access.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex flex-col gap-4">
                {access.courses.map((c) => (
                  <AccessGrid
                    key={c.key}
                    course={c}
                    spaces={spaces}
                    access={access.access}
                    onSaved={(space, parts) =>
                      setAccess((a) => (a ? { ...a, access: { ...a.access, [space]: { ...(a.access[space] ?? {}), [c.key]: parts } } } : a))
                    }
                  />
                ))}
              </div>
            </SettingGroup>
          )}
        </>
      )}
    </>
  );
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
      say(`Signed out of ${name}. ${n ? `The ${plural(n, "course", "courses")} already imported stay, and so does who can see them.` : ""}`.trim());
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
    <div className="flex flex-col gap-2.5 px-4 py-3.5" data-site-row={c.id} data-signed-in={c.signedIn ? "" : undefined}>
      <div className="flex flex-col gap-0.5">
        <h5 id={nameId} className="text-base font-medium wrap-anywhere text-ink">
          {name}
        </h5>
        <p className="text-sm wrap-anywhere text-ink-secondary">
          {kindLabel(c.kind)} · {hostOf(c.address)}
        </p>
        <p className="flex items-center gap-1.5 text-sm text-ink" data-site-status="">
          <Icon name={c.signedIn ? "success" : "warning"} className={c.signedIn ? "size-(--ph-icon-size-sm) text-success-ink" : "size-(--ph-icon-size-sm) text-warning-ink"} />
          {c.signedIn ? "Signed in" : "Signed out: sign in again to import"}
        </p>
        <p className="text-sm text-ink-secondary" data-site-imported="">
          {n ? `${plural(n, "course", "courses")} imported` : "No courses imported yet"}
          {c.lastSync ? `, last on ${whenText(c.lastSync)}` : ""}.
        </p>
      </div>
      {confirming ? (
        <div className="flex flex-col gap-2 rounded-md bg-surface px-3 py-2.5" data-site-confirm="">
          <p id={askId} className="text-sm text-ink">
            Sign out of {name}? Phaethon forgets this sign-in.{" "}
            {n ? `The ${plural(n, "course", "courses")} already imported stay as files, and so does who can see them.` : "Nothing is removed."}
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
                Import more…
              </Button>
              {n > 0 && (
                <Button type="button" variant="outline" size="sm" data-site-action="sync" onClick={() => openCourseImport({ space, connection: c.id, at: "sync" })}>
                  <Icon name="retry" />
                  Import again
                </Button>
              )}
              <Button ref={signOutRef} type="button" variant="ghost" size="sm" data-site-action="signout" onClick={() => setConfirming(true)}>
                Sign out…
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" size="sm" data-site-action="signin" onClick={() => openCourseImport({ space, connection: c.id, at: "signin" })}>
              <Icon name="lock" />
              Sign in again…
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
}: {
  course: CourseInfo;
  spaces: readonly Space[];
  access: CourseAccessView["access"];
  onSaved: (space: string, parts: CoursePart[]) => void;
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
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-raised px-4 py-3 shadow-sm" data-access-course={course.key}>
      <div className="flex flex-col">
        <h5 id={captionId} className="text-base font-medium wrap-anywhere text-ink">
          {course.name}
        </h5>
        {label && <p className="text-sm text-ink-secondary">{label}</p>}
      </div>
      <MaterialLines summary={course.material} details className="flex flex-col" />
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
                      <input
                        type="checkbox"
                        aria-label={`${s.name}: ${p.label}`}
                        checked={parts.includes(p.part)}
                        tabIndex={stop(r, i + 2)}
                        onFocus={onFocusCell(r, i + 2)}
                        onChange={(e) => toggle(s, p.part, e.target.checked)}
                        data-cell={`${r}:${i + 2}`}
                        data-access-part={p.part}
                        className="size-(--ph-target-min) align-middle accent-accent-fill"
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
