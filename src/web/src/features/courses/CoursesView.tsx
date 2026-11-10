/**
 * Courses: connect a course site and import courses (with live progress), the
 * sites you're connected to, the imported courses, and for each course its
 * content and which spaces see which parts. Courses belong to the vault;
 * each space sees only what it is given.
 */
import { ChevronRightIcon, GraduationCapIcon, LinkIcon, LogOutIcon, MessageSquareIcon, PlugIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/core";

import { AccessTable } from "./AccessTable";
import { courseAccessGet, lmsConnections, lmsCourses, lmsDisconnect, spacesList } from "./api";
import { ConnectDialog, type ConnectRequest } from "./ConnectDialog";
import { ContentBrowser } from "./ContentBrowser";
import { useImportRun } from "./import-store";
import { ImportProgress } from "./ImportProgress";
import { byCode } from "./lib/selection";
import { connectionName, isSignedOut, kindLabel, plural, whenText } from "./lib/sites";
import type { CourseAccessView, CourseInfo, CoursePart, LmsConnection, SpaceSummary } from "./lib/types";
import { announce } from "./shared/announce";
import { useComposeRequest } from "./shared/compose-request";
import { EduPage, EmptyState, ErrorState, LoadingRows, PageHeader, Row, RowList, Section } from "./shared/kit";
import { sitesChanged, useSitesVersion } from "./shared/signals";

type Data = { connections: LmsConnection[]; view: CourseAccessView; spaces: SpaceSummary[] };
let connectKey = 1;

export function CoursesView({ spaceId }: { spaceId: string }) {
  const space = spaceId;
  const nav = useNav();
  const version = useSitesVersion();
  const runStatus = useImportRun((s) => s.run?.status);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connect, setConnect] = useState<ConnectRequest | null>(null);
  const [confirmOut, setConfirmOut] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([lmsConnections(), courseAccessGet(), spacesList().catch(() => [] as SpaceSummary[])]).then(
      ([connections, view, spaces]) => setData({ connections, view, spaces: spaces.length ? spaces : view.spaces.map((id) => ({ id, name: id })) }),
      (e) => setError(errorText(e)),
    );
  }, []);
  useEffect(load, [load, version, runStatus]);

  const courseKeyInView = nav.view.kind === "courses" ? nav.view.course : undefined;
  const course = data?.view.courses.find((c) => c.key === courseKeyInView);
  const spaceName = (id: string) => data?.spaces.find((s) => s.id === id)?.name ?? id;
  const open = (r: Omit<ConnectRequest, "key">) => setConnect({ ...r, key: connectKey++ });

  const sync = async (c: LmsConnection) => {
    try {
      const list = await lmsCourses(c.id);
      const picked = list.filter((x) => c.courses.includes(x.id));
      if (!picked.length) return open({ connection: c, at: "choose" });
      useImportRun.getState().start(space, [space], c.id, connectionName(c), picked);
    } catch (e) {
      if (isSignedOut(e)) open({ connection: c, at: "signin" });
      else announce(errorText(e));
    }
  };

  const dialog = data && <ConnectDialog space={space} spaces={data.spaces} connections={data.connections} request={connect} onClose={() => (setConnect(null), sitesChanged())} />;

  if (course && data)
    return (
      <EduPage>
        <CourseDetail
          course={course}
          space={space}
          data={data}
          onBack={() => nav.go({ kind: "courses" })}
          onAccess={(s, parts) => setData({ ...data, view: { ...data.view, access: { ...data.view.access, [s]: { ...data.view.access[s], [course.key]: parts } } } })}
        />
        {dialog}
      </EduPage>
    );

  return (
    <EduPage>
      <PageHeader
        title="Courses"
        meta={data && data.view.courses.length ? `${plural(data.view.courses.length, "course")} in this vault` : undefined}
        actions={
          data && data.connections.length > 0 ? (
            <Button onClick={() => open({})} disabled={runStatus === "running"} data-import-open="">
              <PlugIcon aria-hidden />
              Import courses
            </Button>
          ) : undefined
        }
      />
      <ImportProgress spaceNames={spaceName} />
      {error ? (
        <ErrorState title="Your course sites couldn’t be read." message={error} onRetry={load} />
      ) : !data ? (
        <LoadingRows rows={3} label="Loading your course sites" />
      ) : data.connections.length === 0 ? (
        <EmptyState
          icon={<GraduationCapIcon />}
          title="Connect your course site"
          description="Sign in to Canvas, Brightspace, Moodle or Blackboard and Phaethon imports your courses: syllabus, assignments, files and grades."
        >
          <Button onClick={() => open({})} data-import-open="">
            Connect a course site
          </Button>
        </EmptyState>
      ) : (
        <>
          <Section title="Course sites">
            <RowList>
              {data.connections.map((c) => (
                <Row
                  key={c.id}
                  data-connection={c.id}
                  actions={
                    confirmOut === c.id ? (
                      <span role="alertdialog" aria-label={`Sign out of ${connectionName(c)}?`} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-muted-foreground">Imported courses stay.</span>
                        <Button size="sm" variant="outline" autoFocus onClick={() => setConfirmOut(null)}>
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={async () => {
                            try {
                              await lmsDisconnect(c.id);
                              announce(`Signed out of ${connectionName(c)}.`);
                              setConfirmOut(null);
                              sitesChanged();
                            } catch (e) {
                              announce(errorText(e));
                            }
                          }}
                        >
                          Sign out
                        </Button>
                      </span>
                    ) : c.signedIn ? (
                      <>
                        <Button size="sm" variant="outline" disabled={runStatus === "running"} onClick={() => void sync(c)}>
                          <RefreshCwIcon aria-hidden />
                          Update courses
                        </Button>
                        <Button size="sm" variant="ghost" disabled={runStatus === "running"} onClick={() => open({ connection: c, at: "choose" })}>
                          Choose courses
                        </Button>
                        <Button size="icon-sm" variant="ghost-destructive" aria-label={`Sign out of ${connectionName(c)}`} onClick={() => setConfirmOut(c.id)}>
                          <LogOutIcon aria-hidden />
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" onClick={() => open({ connection: c, at: "signin" })}>
                        Sign in again
                      </Button>
                    )
                  }
                >
                  <span className="flex items-center gap-2 text-[0.9375rem] font-medium text-foreground">
                    <LinkIcon aria-hidden className="size-4 text-muted-foreground" />
                    {connectionName(c)}
                  </span>
                  <span className="ps-6 text-sm text-muted-foreground">
                    {kindLabel(c.kind)} · {c.signedIn ? "Signed in" : <span className="text-warning-foreground">Signed out</span>}
                    {c.lastSync ? ` · updated ${whenText(c.lastSync)}` : ""} · {plural(c.courses.length, "course")}
                  </span>
                </Row>
              ))}
            </RowList>
          </Section>
          <Section title="Imported courses" description="Open a course to browse it and choose which spaces see it.">
            {data.view.courses.length === 0 ? (
              <p className="rounded-xl border border-dashed px-4 py-3.5 text-sm text-muted-foreground">No courses imported yet.</p>
            ) : (
              <RowList>
                {[...data.view.courses].sort(byCode).map((c) => (
                  <CourseRow key={c.key} c={c} view={data.view} spaceName={spaceName} onOpen={() => nav.go({ kind: "courses", course: c.key })} />
                ))}
              </RowList>
            )}
            {data.view.problems.length > 0 && (
              <details className="text-sm text-muted-foreground">
                <summary className="cursor-pointer">{plural(data.view.problems.length, "entry", "entries")} in the access file were ignored</summary>
                <ul className="mt-2 list-disc ps-5">
                  {data.view.problems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </details>
            )}
          </Section>
        </>
      )}
      {dialog}
    </EduPage>
  );
}

function CourseRow({ c, view, spaceName, onOpen }: { c: CourseInfo; view: CourseAccessView; spaceName: (id: string) => string; onOpen: () => void }) {
  const seers = Object.entries(view.access)
    .filter(([, m]) => (m[c.key]?.length ?? 0) > 0)
    .map(([s]) => spaceName(s));
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 px-4 py-3 text-start outline-none hover:bg-accent/40 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        data-course={c.key}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[0.9375rem] font-medium text-foreground">{c.name}</span>
          <span className="text-sm text-muted-foreground">
            {[c.code, c.term].filter(Boolean).join(" · ")}
            {(c.code || c.term) && " · "}
            {seers.length ? `Seen by ${seers.join(", ")}` : "No space sees it"}
          </span>
        </span>
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}

function CourseDetail({
  course,
  space,
  data,
  onBack,
  onAccess,
}: {
  course: CourseInfo;
  space: string;
  data: Data;
  onBack: () => void;
  onAccess: (space: string, parts: CoursePart[]) => void;
}) {
  const go = useNav((s) => s.go);
  const can = (s: string) => (data.view.access[s]?.[course.key]?.length ?? 0) > 0;
  const viewer = can(space) ? space : data.spaces.find((s) => can(s.id))?.id;
  const name = (id: string) => data.spaces.find((s) => s.id === id)?.name ?? id;
  return (
    <>
      <PageHeader
        back={{ label: "Courses", onClick: onBack }}
        title={course.name}
        focusKey={course.key}
        meta={[course.code, course.term].filter(Boolean).join(" · ") || undefined}
        actions={
          viewer && (
            <Button
              variant="outline"
              onClick={() => {
                useComposeRequest.getState().compose(viewer, `What’s coming up in ${course.name}, and what should I read first?`);
                go({ kind: "chat" }, viewer);
              }}
            >
              <MessageSquareIcon aria-hidden />
              Ask about this course
            </Button>
          )
        }
      />
      {course.material && course.material.lines.length > 0 && (
        <ul className="-mt-3 flex flex-col gap-1 text-sm text-muted-foreground">
          {course.material.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      <Section title="Content">
        {viewer ? (
          <ContentBrowser course={course} space={viewer} viewingAs={viewer !== space ? name(viewer) : undefined} />
        ) : (
          <p className="rounded-xl border border-dashed px-4 py-3.5 text-sm text-muted-foreground">No space sees this course yet. Give one access below to browse it.</p>
        )}
      </Section>
      <Section title="Who can see it" description="A space sees only the parts checked here.">
        <AccessTable course={course} spaces={data.spaces} access={data.view.access} onChange={onAccess} />
      </Section>
    </>
  );
}
