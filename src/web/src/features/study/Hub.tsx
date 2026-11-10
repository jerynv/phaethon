/**
 * The Study hub: what's due now first (one review across the courses in view,
 * with a count and a time estimate), then each course's flashcards and
 * quizzes with an explicit way into each, and making new practice.
 */
import { BookOpenCheckIcon, ClipboardListIcon, FolderOpenIcon, GraduationCapIcon, LayersIcon, PlusIcon, SparklesIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";

import { CourseFilter } from "../courses/shared/CourseFilter";
import { EduPage, EmptyState, ErrorState, LoadingRows, Meter, PageHeader, Row, RowList, Section } from "../courses/shared/kit";
import { NoCourseAccess } from "../courses/shared/NoCourseAccess";
import { courseMatches, folderKey, GENERAL } from "../courses/lib/selection";
import { hiddenCourses, type CourseReach } from "../courses/lib/reach";
import type { CourseInfo } from "../courses/lib/types";
import { draftCount } from "./lib/quiz-answers";
import type { CourseSource, DeckSummary, QuizSummary, StudyOverview } from "./lib/types";
import { percent, plural, reviewMinutes } from "./lib/words";

export type HubData = { overview: StudyOverview; sources: CourseSource[] };

type Group = { folder: string; name: string; decks: DeckSummary[]; quizzes: QuizSummary[]; course?: CourseInfo };

/** The courses to show: imported ones the space sees, plus any a deck or quiz names; "General" for the rest. */
export function groupsOf(data: HubData, courses: CourseInfo[]): Group[] {
  const groups: Group[] = [];
  const add = (folder: string, name: string) => {
    if (!groups.some((g) => folderKey(g.folder).toLowerCase() === folderKey(folder).toLowerCase())) {
      groups.push({ folder: `courses/${folderKey(folder)}`, name, decks: [], quizzes: [], course: courses.find((c) => folderKey(c.folder) === folderKey(folder)) });
    }
  };
  for (const s of data.sources) add(s.folder, s.name);
  for (const x of [...data.overview.decks, ...data.overview.quizzes]) if (x.course) add(x.course, x.course);
  groups.sort((a, b) => a.name.localeCompare(b.name));
  if ([...data.overview.decks, ...data.overview.quizzes].some((x) => !x.course)) groups.push({ folder: GENERAL, name: "General", decks: [], quizzes: [] });
  for (const g of groups) {
    g.decks = data.overview.decks.filter((d) => courseMatches(d.course, g.folder, g.name));
    g.quizzes = data.overview.quizzes.filter((q) => courseMatches(q.course, g.folder, g.name));
  }
  return groups;
}

export function Hub({
  space,
  data,
  error,
  reload,
  courses,
  reach,
  selectedFolder,
  onSelect,
  onReview,
  onOpenDeck,
  onOpenQuiz,
  onMake,
  focusTarget,
}: {
  space: string;
  data: HubData | null;
  error: string | null;
  reload: () => void;
  courses: CourseInfo[];
  reach: CourseReach | null;
  selectedFolder: string | null;
  onSelect: (o: { folder: string; name: string } | null) => void;
  onReview: (paths: string[] | null, title: string, leftFrom: string) => void;
  onOpenDeck: (path: string) => void;
  onOpenQuiz: (path: string) => void;
  onMake: (kind: "deck" | "quiz" | null, course?: string) => void;
  focusTarget?: string;
}) {
  const go = useNav((s) => s.go);
  const groups = useMemo(() => (data ? groupsOf(data, courses) : []), [data, courses]);
  const shown = selectedFolder ? groups.filter((g) => folderKey(g.folder).toLowerCase() === folderKey(selectedFolder).toLowerCase()) : groups;
  const visible = selectedFolder && shown.length === 0 ? groups : shown;
  const rootRef = useRef<HTMLDivElement>(null);

  // Coming back from a deck, quiz or review: focus what was left.
  useEffect(() => {
    if (!focusTarget || !data) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusTarget)}"]`);
    el?.focus();
  }, [focusTarget, data]);

  const options = groups.filter((g) => g.folder !== GENERAL || groups.length > 1).map((g) => ({ folder: g.folder, name: g.name }));
  const hidden = hiddenCourses(reach);
  const decks = visible.flatMap((g) => g.decks);
  const due = decks.reduce((n, d) => n + d.due, 0);
  const fresh = decks.reduce((n, d) => n + d.new, 0);
  const total = due + fresh;
  const round = Math.min(total, 40);
  const scopeName = selectedFolder && visible.length === 1 ? visible[0]!.name : null;
  const nothing = data && groups.length === 0;

  const makeMenu = (
    <Menu>
      <MenuTrigger render={<Button variant="outline" />} data-make-menu="">
        <PlusIcon aria-hidden />
        New practice
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => onMake("deck", selectedFolder ?? undefined)}>
          <LayersIcon aria-hidden />
          Flashcards…
        </MenuItem>
        <MenuItem onClick={() => onMake("quiz", selectedFolder ?? undefined)}>
          <ClipboardListIcon aria-hidden />
          Practice quiz…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );

  return (
    <EduPage>
      <div ref={rootRef} className="contents">
        <PageHeader
          title="Study"
          meta={data && data.overview.streakDays > 1 ? `${data.overview.streakDays}-day streak` : undefined}
          actions={
            data && !nothing ? (
              <>
                <CourseFilter options={options} value={selectedFolder} onChange={onSelect} />
                {makeMenu}
              </>
            ) : undefined
          }
        />

        {error ? (
          <ErrorState title="Study couldn’t be loaded." message={error} onRetry={reload} />
        ) : !data ? (
          <>
            <div role="status" aria-label="Loading Study" className="h-36 rounded-2xl border bg-card motion-safe:animate-pulse" />
            <LoadingRows rows={4} label="Loading decks and quizzes" />
          </>
        ) : nothing ? (
          hidden === "none" ? (
            <NoCourseAccess why="none" />
          ) : (
            <EmptyState
              icon={<GraduationCapIcon />}
              title="No courses yet"
              description="Import a course and Phaethon makes flashcards and quizzes from its files, each one tied to the passage it came from."
            >
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => go({ kind: "courses" })}>Import courses</Button>
                <Button variant="outline" onClick={() => onMake("deck")}>
                  Make flashcards
                </Button>
              </div>
            </EmptyState>
          )
        ) : (
          <>
            <DueNow
              total={total}
              due={due}
              fresh={fresh}
              round={round}
              scope={scopeName}
              byCourse={visible.filter((g) => g.decks.some((d) => d.due + d.new > 0)).map((g) => ({ name: g.name, n: g.decks.reduce((n, d) => n + d.due + d.new, 0) }))}
              hasDecks={decks.length > 0}
              onStart={() => onReview(selectedFolder ? decks.map((d) => d.path) : null, scopeName ? `Due in ${scopeName}` : "Due now", "due")}
              onMake={() => onMake("deck", selectedFolder ?? undefined)}
            />
            {visible.map((g) => (
              <CourseSection
                key={g.folder}
                space={space}
                group={g}
                onReview={onReview}
                onOpenDeck={onOpenDeck}
                onOpenQuiz={onOpenQuiz}
                onMake={onMake}
                onMaterials={g.course ? () => go({ kind: "courses", course: g.course!.key }) : undefined}
              />
            ))}
          </>
        )}
      </div>
    </EduPage>
  );
}

function DueNow({
  total,
  due,
  fresh,
  round,
  scope,
  byCourse,
  hasDecks,
  onStart,
  onMake,
}: {
  total: number;
  due: number;
  fresh: number;
  round: number;
  scope: string | null;
  byCourse: { name: string; n: number }[];
  hasDecks: boolean;
  onStart: () => void;
  onMake: () => void;
}) {
  const parts = [due ? `${due} to review` : "", fresh ? `${fresh} new` : ""].filter(Boolean).join(" · ");
  return (
    <section aria-labelledby="study-due-heading" className="flex flex-col gap-5 rounded-2xl border border-primary/20 bg-card bg-linear-to-br from-primary/[0.04] to-transparent p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6" data-study-due="">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h2 id="study-due-heading" className="text-sm font-medium text-muted-foreground">
          {scope ? `Due now in ${scope}` : "Due now"}
        </h2>
        {total > 0 ? (
          <>
            <p className="text-3xl font-semibold tracking-tight text-foreground tabular-nums">{plural(total, "card")}</p>
            <p className="text-sm text-muted-foreground">
              {parts}
              {" · "}about {plural(reviewMinutes(round), "minute")}
              {total > round && ` for the first ${round}`}
            </p>
            {byCourse.length > 1 && (
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                {byCourse.map((c) => (
                  <li key={c.name}>
                    <span className="text-foreground">{c.n}</span> {c.name}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <p className="text-2xl font-semibold tracking-tight text-foreground">{hasDecks ? "All caught up" : "No flashcards yet"}</p>
            <p className="text-sm text-muted-foreground">{hasDecks ? "Cards come back here on the day they’re due." : "Make a deck from your course files to start reviewing."}</p>
          </>
        )}
      </div>
      {total > 0 ? (
        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
          <Button size="lg" onClick={onStart} data-focus-key="due" data-study-start="">
            <BookOpenCheckIcon aria-hidden />
            Start review
          </Button>
          <span className="hidden text-sm text-muted-foreground sm:block" aria-hidden>
            Rate with <Kbd>1</Kbd>–<Kbd>5</Kbd>
          </span>
        </div>
      ) : (
        !hasDecks && (
          <Button variant="outline" onClick={onMake} className="self-start sm:self-center">
            <SparklesIcon aria-hidden />
            Make flashcards
          </Button>
        )
      )}
    </section>
  );
}

function CourseSection({
  space,
  group,
  onReview,
  onOpenDeck,
  onOpenQuiz,
  onMake,
  onMaterials,
}: {
  space: string;
  group: Group;
  onReview: (paths: string[] | null, title: string, leftFrom: string) => void;
  onOpenDeck: (path: string) => void;
  onOpenQuiz: (path: string) => void;
  onMake: (kind: "deck" | "quiz" | null, course?: string) => void;
  onMaterials?: () => void;
}) {
  const course = group.folder === GENERAL ? undefined : group.folder;
  const empty = !group.decks.length && !group.quizzes.length;
  return (
    <Section
      title={group.name}
      description={group.course?.code ? [group.course.code, group.course.term].filter(Boolean).join(" · ") : undefined}
      actions={
        onMaterials && (
          <Button variant="ghost-muted" size="sm" onClick={onMaterials}>
            <FolderOpenIcon aria-hidden />
            Materials
          </Button>
        )
      }
    >
      {empty ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed px-4 py-3.5 text-sm text-muted-foreground">
          <span>No practice for this course yet.</span>
          <span className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => onMake("deck", course)}>
              Make flashcards
            </Button>
            <Button size="sm" variant="outline" onClick={() => onMake("quiz", course)}>
              Make a quiz
            </Button>
          </span>
        </div>
      ) : (
        <RowList label={`Practice for ${group.name}`}>
          {group.decks.map((d) => (
            <DeckRow key={d.path} d={d} onOpen={() => onOpenDeck(d.path)} onReview={() => onReview([d.path], d.title, d.path)} />
          ))}
          {group.quizzes.map((q) => (
            <QuizRow key={q.path} space={space} q={q} onOpen={() => onOpenQuiz(q.path)} />
          ))}
        </RowList>
      )}
    </Section>
  );
}

function TitleButton({ children, onClick, label }: { children: string; onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="self-start rounded-sm text-start text-[0.9375rem] font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function DeckRow({ d, onOpen, onReview }: { d: DeckSummary; onOpen: () => void; onReview: () => void }) {
  const waiting = d.due + d.new;
  return (
    <Row
      data-deck={d.path}
      actions={
        <>
          <span className="flex items-center gap-2 text-sm whitespace-nowrap text-muted-foreground tabular-nums" title="Share of cards you rated Mostly or Perfectly in the last 30 days">
            <Meter value={d.mastery} className="w-16" tone="success" />
            {percent(d.mastery)} known
          </span>
          <Button size="sm" variant={waiting ? "secondary" : "outline"} disabled={d.cards === 0} onClick={onReview} aria-label={`Review ${d.title}`} data-focus-key={d.path}>
            Review
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2">
        <LayersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <TitleButton onClick={onOpen}>{d.title}</TitleButton>
      </div>
      <p className="ps-6 text-sm text-muted-foreground">
        Flashcards · {plural(d.cards, "card")}
        {d.due > 0 && ` · ${d.due} due`}
        {d.new > 0 && ` · ${d.new} new`}
      </p>
    </Row>
  );
}

function QuizRow({ space, q, onOpen }: { space: string; q: QuizSummary; onOpen: () => void }) {
  const draft = draftCount(space, q.path);
  const status =
    q.questions === 0
      ? "Can’t be read"
      : draft > 0
        ? `Draft · ${draft} of ${q.questions} answered`
        : q.lastScore != null
          ? `Last score ${percent(q.lastScore)}${q.lastTaken ? ` · ${new Date(q.lastTaken).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}`
          : "Not taken yet";
  return (
    <Row
      data-quiz={q.path}
      actions={
        <Button size="sm" variant={draft > 0 ? "secondary" : "outline"} disabled={q.questions === 0} onClick={onOpen} aria-label={`${draft > 0 ? "Continue" : "Take"} ${q.title}`} data-focus-key={q.path}>
          {draft > 0 ? "Continue" : "Take quiz"}
        </Button>
      }
    >
      <div className="flex items-center gap-2">
        <ClipboardListIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <TitleButton onClick={onOpen}>{q.title}</TitleButton>
      </div>
      <p className="ps-6 text-sm text-muted-foreground">
        Quiz · {plural(q.questions, "question")} · {status}
      </p>
    </Row>
  );
}
