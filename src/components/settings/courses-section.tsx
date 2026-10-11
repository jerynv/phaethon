import { useCallback, useEffect, useId, useRef, useState } from "react";

import { openCourseImport, useRun, useSitesVersion } from "@/components/lms/import-store";
import { connectionName, hostOf, kindLabel, plural, whenText } from "@/components/lms/sites";
import { SpaceMark } from "@/components/shell/space-mark";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { disconnectLms, listConnections, type Connection } from "@/lib/lms";
import { useSpaces, type Space } from "@/lib/spaces";

import { SectionHeader, SettingGroup } from "./controls";
import { useStatus } from "./status";

/**
 * Settings › Course sites: the course sites each space reads its courses
 * from, whether it is still signed in, when it last imported and how many
 * courses. From here: import more courses, import them again (only what
 * changed is downloaded), sign in again, or sign out (the imported files
 * stay in the space). Sign out asks first, in place.
 */
export function CoursesSection({ headingId }: { headingId: string }) {
  const { spaces } = useSpaces();
  return (
    <>
      <SectionHeader
        id={headingId}
        title="Course sites"
        description="The school course sites (Canvas, Brightspace, Moodle, Blackboard) your spaces bring courses in from. Each space keeps its own sign-in, in your keychain on this computer. Phaethon only reads from a course site: it never changes anything there."
      />
      {spaces.map((s) => (
        <SpaceSites key={s.id} space={s} />
      ))}
    </>
  );
}

function SpaceSites({ space }: { space: Space }) {
  const [list, setList] = useState<Connection[] | null>(null);
  const [error, setError] = useState("");
  const importRef = useRef<HTMLButtonElement>(null);
  const run = useRun();
  const runEnded = run?.space === space.id && run.status !== "running" ? run.key : 0;
  const changed = useSitesVersion();

  const load = useCallback(() => {
    listConnections(space.id).then(
      (cs) => {
        setList(cs);
        setError("");
      },
      (e: unknown) => setError(String(e)),
    );
  }, [space.id]);
  // Again once an import into this space ends (its last import and courses changed), or a sign-in finished.
  useEffect(load, [load, runEnded, changed]);

  return (
    <SettingGroup title={space.name}>
      <div data-course-sites={space.id} className="flex flex-col divide-y divide-line">
        {error ? (
          <p role="alert" className="flex items-start gap-2 px-4 py-3.5 text-sm text-danger-ink">
            <Icon name="error" className="mt-0.5 shrink-0" />
            <span className="min-w-0 wrap-break-word">The course sites of {space.name} couldn’t be read. {error}</span>
          </p>
        ) : list === null ? (
          <p className="px-4 py-3.5 text-sm text-ink-secondary">Loading…</p>
        ) : (
          <>
            {list.length === 0 && <p className="px-4 pt-3.5 text-sm text-ink-secondary">No course site connected.</p>}
            {list.map((c) => (
              <SiteRow
                key={c.id}
                space={space}
                connection={c}
                onGone={() => {
                  setList((l) => l?.filter((x) => x.id !== c.id) ?? null);
                  requestAnimationFrame(() => importRef.current?.focus());
                }}
              />
            ))}
            <div className="px-4 py-3">
              <Button ref={importRef} type="button" variant="outline" size="sm" data-sites-import={space.id} onClick={() => openCourseImport({ space: space.id })}>
                <Icon name="plus" />
                {list.length ? "Connect another course site…" : "Import courses…"}
                <span className="sr-only">{` into ${space.name}`}</span>
              </Button>
            </div>
          </>
        )}
      </div>
    </SettingGroup>
  );
}

function SiteRow({ space, connection: c, onGone }: { space: Space; connection: Connection; onGone: () => void }) {
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
      await disconnectLms(space.id, c.id);
      say(`Signed out of ${name}. ${n ? `The ${plural(n, "course", "courses")} already imported stay in ${space.name}.` : ""}`.trim());
      onGone();
    } catch (e) {
      fail(`Phaethon couldn’t sign out of ${name}. ${String(e)}`);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5 px-4 py-3.5" data-site-row={c.id} data-signed-in={c.signedIn ? "" : undefined}>
      <div className="flex flex-col gap-0.5">
        <h5 id={nameId} className="flex items-center gap-2 text-base font-medium wrap-anywhere text-ink">
          <SpaceMark hue={space.hue} />
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
            {n ? `The ${plural(n, "course", "courses")} already imported stay in ${space.name} as files.` : "Nothing in the space is removed."}
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
              <Button type="button" variant="outline" size="sm" data-site-action="more" onClick={() => openCourseImport({ space: space.id, connection: c.id, at: "choose" })}>
                Import more…
              </Button>
              {n > 0 && (
                <Button type="button" variant="outline" size="sm" data-site-action="sync" onClick={() => openCourseImport({ space: space.id, connection: c.id, at: "sync" })}>
                  <Icon name="retry" />
                  Import again
                </Button>
              )}
            </>
          ) : (
            <Button type="button" variant="outline" size="sm" data-site-action="signin" onClick={() => openCourseImport({ space: space.id, connection: c.id, at: "signin" })}>
              <Icon name="lock" />
              Sign in again…
            </Button>
          )}
          <Button ref={signOutRef} type="button" variant="ghost" size="sm" data-site-action="signout" onClick={() => setConfirming(true)}>
            Sign out…
          </Button>
        </div>
      )}
    </div>
  );
}
