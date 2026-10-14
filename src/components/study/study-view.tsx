import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { relativeDate } from "@/components/chat/conversations-bar";
import { hiddenCourses, NoCourseAccess, useCourseReach } from "@/components/lms/course-reach";
import { openCourseImport, useRun, useSitesVersion } from "@/components/lms/import-store";
import { announce } from "@/components/shell/announcer";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { studyOverview, type Attempt, type DeckSummary, type Quiz, type QuizSummary } from "@/lib/study";
import type { Space } from "@/lib/spaces";
import { cn } from "@/lib/utils";

import { DeckEditor } from "./deck-editor";
import { MakeDialog, type Made, type MakeKind, type MakeRequest } from "./make-dialog";
import { QuizView } from "./quiz-view";
import { ReviewSession } from "./review-session";
import { useStudyRequest } from "./space-view";
import { courseFolders, percent, plainError, plural, type CourseFolder } from "./words";

type Overview = Awaited<ReturnType<typeof studyOverview>>;

type Screen =
  | { at: "hub" }
  | { at: "session"; paths: string[] | null; title: string }
  | { at: "deck"; path: string }
  /** `arrived`: opened from the chat, just made; focus goes to its first question. */
  | { at: "quiz"; path: string; arrived?: number };

/**
 * A space's Study view. The hub: what's due today and the streak, the decks
 * (how well each is known, due and new cards, course) and the quizzes (last
 * score), with Study everything due, Make flashcards and Make a quiz. From
 * there: a review session, a deck's cards, a quiz and its results. A space
 * with nothing to study yet gets an empty state that says what this is and
 * offers to import courses or make cards.
 */
export function StudyView({ space, shown }: { space: Space; shown: boolean }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [courses, setCourses] = useState<CourseFolder[] | null>(null);
  const [screen, setScreen] = useState<Screen>({ at: "hub" });
  const [make, setMake] = useState<MakeRequest | null>(null);
  const makeKey = useRef(1);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Where focus goes when the hub shows again (the control that opened what was left).
  const returnTo = useRef<string | null>(null);
  const importEnded = useRun()?.status !== "running";
  const sitesChanged = useSitesVersion();

  const load = useCallback(() => {
    studyOverview(space.id).then(
      (o) => {
        setOverview(o);
        setError("");
        void courseFolders(space.id, [...o.decks.map((d) => d.course), ...o.quizzes.map((q) => q.course)]).then(setCourses);
      },
      (e: unknown) => setError(plainError(e)),
    );
  }, [space.id]);
  // Read again whenever it comes into view, and when an import ends (new courses).
  useEffect(() => {
    if (shown) load();
  }, [shown, load, importEnded, sitesChanged]);

  const openMake = useCallback((kind: MakeKind, from?: MakeRequest["fromAttempt"]) => {
    setMake({ kind, key: makeKey.current++, fromAttempt: from });
  }, []);

  const goHub = useCallback(
    (focus: string | null = null) => {
      returnTo.current = focus;
      setScreen({ at: "hub" });
      load();
    },
    [load],
  );

  // The palette asks for something here.
  const req = useStudyRequest();
  const handled = useRef(0);
  useEffect(() => {
    if (!req || req.space !== space.id || handled.current === req.key) return;
    handled.current = req.key;
    if (req.what === "take" && req.path) setScreen({ at: "quiz", path: req.path, arrived: req.key });
    else if (req.what === "cards" && req.path) setScreen({ at: "session", paths: [req.path], title: "New cards" });
    else if (req.what === "due") setScreen({ at: "session", paths: null, title: "Everything due" });
    else if (req.what === "review") {
      // A deck by its title: its path from the overview; unknown → the hub, where the decks are.
      void studyOverview(space.id).then(
        (o) => {
          const d = o.decks.find((x) => x.title === req.deck);
          setScreen(d ? { at: "session", paths: [d.path], title: d.title } : { at: "hub" });
        },
        () => setScreen({ at: "hub" }),
      );
    } else if (req.what === "deck" || req.what === "quiz") {
      setScreen({ at: "hub" });
      openMake(req.what);
    }
  }, [req, space.id, openMake]);

  // Back on the hub, focus goes back to what opened the screen left (or the heading).
  useLayoutEffect(() => {
    if (screen.at !== "hub" || !shown) return;
    const want = returnTo.current;
    if (want === null) return;
    returnTo.current = null;
    requestAnimationFrame(() => (document.querySelector<HTMLElement>(`[data-study-hub="${CSS.escape(space.id)}"] ${want}`) ?? headingRef.current)?.focus());
  }, [screen, shown, space.id, overview]);

  const onMade = (m: Made) => {
    load();
    if (m.next === "study") setScreen({ at: "session", paths: [m.path], title: "New cards" });
    else if (m.next === "open") setScreen({ at: "deck", path: m.path });
    else if (m.next === "take") setScreen({ at: "quiz", path: m.path });
  };

  const fromMistakes = (attempt: Attempt, quiz: Quiz) =>
    openMake("deck", { path: attempt.path, sources: quiz.sources, quizTitle: quiz.title });

  const dialog = (
    <MakeDialog
      space={space.id}
      request={make}
      courses={courses ?? []}
      // Radix puts focus back on what opened it.
      onClose={() => setMake(null)}
      onMade={onMade}
    />
  );

  if (screen.at === "session") {
    return (
      <>
        <ReviewSession key={JSON.stringify(screen.paths)} space={space.id} paths={screen.paths} title={screen.title} onExit={() => goHub(screen.paths ? null : "[data-study-due]")} />
        {dialog}
      </>
    );
  }
  if (screen.at === "deck") {
    return (
      <>
        <DeckEditor
          space={space.id}
          path={screen.path}
          onBack={() => goHub(`[data-open-deck="${CSS.escape(screen.path)}"]`)}
          onStudy={(path, title) => setScreen({ at: "session", paths: [path], title })}
          onDeleted={(title) => {
            announce(`Deleted “${title}”.`);
            goHub(null);
          }}
        />
        {dialog}
      </>
    );
  }
  if (screen.at === "quiz") {
    return (
      <>
        <QuizView
          key={`${screen.path}\n${screen.arrived ?? ""}`}
          space={space.id}
          path={screen.path}
          arrived={screen.arrived != null}
          onBack={() => goHub(`[data-take-quiz="${CSS.escape(screen.path)}"]`)}
          onMakeFromMistakes={fromMistakes}
          onStudyDeck={(path) => setScreen({ at: "session", paths: [path], title: "Cards from your mistakes" })}
        />
        {dialog}
      </>
    );
  }

  let body;
  if (error) {
    body = (
      <div role="alert" className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3 py-2.5 text-base text-ink">
        <Icon name="error" className="mt-0.5 shrink-0 text-danger-ink" />
        <div className="flex min-w-0 flex-col gap-2">
          <p className="wrap-break-word">Study couldn’t be loaded. {error}</p>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={load}>
              <Icon name="retry" />
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  } else if (!overview) {
    body = (
      <p role="status" className="flex items-center gap-2 text-md text-ink-secondary">
        <Icon name="spinner" className="animate-spin" />
        Loading Study…
      </p>
    );
  } else if (overview.decks.length === 0 && overview.quizzes.length === 0) {
    body = <Empty space={space} hasCourses={(courses?.length ?? 0) > 0} loading={courses === null} onMake={openMake} />;
  } else {
    const { decks, quizzes, due, streakDays } = overview;
    body = (
      <>
        <section aria-label="Today" className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-line bg-raised px-5 py-4 shadow-sm forced-colors:border-[CanvasText]">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-2xl font-semibold text-ink" data-due-count="">
              {due === 0 ? "Nothing due today" : `${plural(due, "card")} due today`}
            </p>
            <p className="text-base text-ink-secondary" data-streak="">
              {streakDays > 0 ? `You’ve studied ${plural(streakDays, "day")} in a row.` : "Study today to start a streak."}
            </p>
          </div>
          <Button
            type="button"
            size="lg"
            disabled={due === 0}
            onClick={() => setScreen({ at: "session", paths: null, title: "Everything due" })}
            data-study-due=""
          >
            <Icon name="play" />
            Study everything due
          </Button>
        </section>

        <section aria-labelledby={`decks-${space.id}`} className="flex flex-col gap-2">
          <h3 id={`decks-${space.id}`} className="text-md font-semibold text-ink">
            Flashcards
          </h3>
          {decks.length === 0 ? (
            <p className="text-base text-ink-secondary">No decks yet. Make flashcards from your courses to start.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-raised" data-deck-list="">
              {decks.map((d) => (
                <DeckRow
                  key={d.path}
                  deck={d}
                  onOpen={() => setScreen({ at: "deck", path: d.path })}
                  onStudy={() => setScreen({ at: "session", paths: [d.path], title: d.title })}
                />
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby={`quizzes-${space.id}`} className="flex flex-col gap-2">
          <h3 id={`quizzes-${space.id}`} className="text-md font-semibold text-ink">
            Quizzes
          </h3>
          {quizzes.length === 0 ? (
            <p className="text-base text-ink-secondary">No quizzes yet. Make one to practise for a test.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-raised" data-quiz-list="">
              {quizzes.map((q) => (
                <QuizRow key={q.path} quiz={q} onTake={() => setScreen({ at: "quiz", path: q.path })} />
              ))}
            </ul>
          )}
        </section>
      </>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-(--ph-thread-width) flex-col gap-5 px-6 py-5" data-study-hub={space.id}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-ink" data-view-focus="">
          Study
        </h2>
        {overview && (overview.decks.length > 0 || overview.quizzes.length > 0) && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => openMake("deck")} data-make="deck">
              <Icon name="plus" />
              Make flashcards…
            </Button>
            <Button type="button" variant="outline" onClick={() => openMake("quiz")} data-make="quiz">
              <Icon name="plus" />
              Make a quiz…
            </Button>
          </div>
        )}
      </div>
      {body}
      {dialog}
    </div>
  );
}

function Empty({ space, hasCourses, loading, onMake }: { space: Space; hasCourses: boolean; loading: boolean; onMake: (k: MakeKind) => void }) {
  const hidden = hiddenCourses(useCourseReach(space.id));
  return (
    <div className="flex flex-col items-center gap-3 px-2 py-8 text-center" data-study-empty="">
      <span className="grid size-[calc(var(--ph-icon-size-lg)*2.5)] place-items-center rounded-full bg-accent-soft text-accent-soft-ink">
        <Icon name="book" className="size-(--ph-icon-size-lg)" />
      </span>
      <p className="text-lg font-semibold text-ink">Turn your courses into flashcards and practice quizzes</p>
      <p className="max-w-(--ph-measure) text-base text-ink-secondary">
        Phaethon reads your syllabus, assignments and course files and makes cards and questions from them. Each card comes back just
        before you’d forget it, and a quiz tells you what to study next.
      </p>
      {!loading && !hasCourses && hidden && <NoCourseAccess why={hidden} />}
      {!loading && !hasCourses && !hidden && (
        <p className="max-w-(--ph-measure) text-base text-ink-secondary">There are no courses in {space.name} yet: import them first.</p>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {!loading && !hasCourses && hidden ? null : !loading && !hasCourses ? (
          <Button type="button" onClick={() => openCourseImport({ space: space.id })} data-empty-import="">
            <Icon name="book" />
            Import courses…
          </Button>
        ) : (
          <>
            <Button type="button" onClick={() => onMake("deck")} data-make="deck">
              <Icon name="plus" />
              Make flashcards…
            </Button>
            <Button type="button" variant="outline" onClick={() => onMake("quiz")} data-make="quiz">
              <Icon name="plus" />
              Make a quiz…
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function DeckRow({ deck, onOpen, onStudy }: { deck: DeckSummary; onOpen: () => void; onStudy: () => void }) {
  const m = Math.round(deck.mastery * 100);
  const counts = [deck.due ? `${deck.due} due` : "none due", deck.new ? `${deck.new} new` : "", plural(deck.cards, "card")].filter(Boolean).join(" · ");
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-3" data-deck-row={deck.path}>
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
        <Button type="button" variant="link" className="h-auto justify-start text-start text-md font-semibold text-ink" onClick={onOpen} data-open-deck={deck.path}>
          {deck.title}
        </Button>
        {deck.course && <p className="text-sm wrap-break-word text-ink-secondary">{deck.course}</p>}
        <p className="text-sm text-ink-secondary">{counts}</p>
      </div>
      <div className="flex w-[calc(var(--ph-control-height)*5)] max-w-full flex-col gap-1">
        <p className="text-sm text-ink" data-deck-mastery={m}>
          {percent(deck.mastery)} known
        </p>
        <div aria-hidden="true" className="h-(--ph-space) overflow-hidden rounded-full bg-surface-sunken forced-colors:border forced-colors:border-[CanvasText]">
          <div className="h-full rounded-full bg-success-ink forced-colors:bg-[CanvasText]" style={{ width: `${m}%` }} />
        </div>
      </div>
      <Button
        type="button"
        variant={deck.due ? "default" : "outline"}
        size="sm"
        disabled={deck.cards === 0}
        onClick={onStudy}
        aria-label={`Study ${deck.title}`}
        data-study-deck-row={deck.path}
        className={cn(!deck.due && "text-ink")}
      >
        Study
      </Button>
    </li>
  );
}

function QuizRow({ quiz, onTake }: { quiz: QuizSummary; onTake: () => void }) {
  const last = quiz.lastScore != null ? `Last score ${percent(quiz.lastScore)}${quiz.lastTaken ? ` · ${relativeDate(quiz.lastTaken)}` : ""}` : "Not taken yet";
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-3" data-quiz-row={quiz.path}>
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <p className="text-md font-semibold wrap-break-word text-ink">{quiz.title}</p>
        <p className="text-sm text-ink-secondary">
          {plural(quiz.questions, "question")}
          {quiz.course ? ` · ${quiz.course}` : ""}
        </p>
      </div>
      <p className="text-sm text-ink" data-last-score="">
        {last}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onTake} data-take-quiz={quiz.path}>
        Take quiz<span className="sr-only">: {quiz.title}</span>
      </Button>
    </li>
  );
}
