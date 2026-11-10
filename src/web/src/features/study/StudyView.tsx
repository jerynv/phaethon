/**
 * Study for one space: the hub, a review session, a deck, a quiz, and the
 * make wizard over all of them. The deck or quiz to open can come from
 * navigation (`useNav().go({kind: "study", deck | quiz})`, paths).
 */
import { useCallback, useEffect, useState } from "react";

import { useNav } from "@/app/nav";
import { errorText } from "@/lib/core";

import { useImportRun } from "../courses/import-store";
import { useCourseContext } from "../courses/shared/course-context";
import { useSitesVersion } from "../courses/shared/signals";
import { studyOverview, studySources } from "./api";
import { DeckEditor } from "./DeckEditor";
import { Hub, type HubData } from "./Hub";
import { MakeDialog, type Made } from "./MakeDialog";
import { QuizView } from "./QuizView";
import { ReviewSession } from "./ReviewSession";
import { useStudyStore, type StudyScreen } from "./store";

const HUB: StudyScreen = { kind: "hub" };

export function StudyView({ spaceId }: { spaceId: string }) {
  const space = spaceId;
  const screen = useStudyStore((s) => s.screens[space] ?? HUB);
  const leftFrom = useStudyStore((s) => s.leftFrom[space]);
  const make = useStudyStore((s) => s.make[space] ?? null);
  const { show, openMake, closeMake } = useStudyStore.getState();
  const view = useNav((s) => s.view);
  const go = useNav((s) => s.go);
  const ctx = useCourseContext(space);
  const sitesVersion = useSitesVersion();
  const importing = useImportRun((s) => s.run?.status === "running");
  const [data, setData] = useState<HubData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([studyOverview(space), studySources(space).catch(() => [])]).then(
      ([overview, sources]) => setData({ overview, sources }),
      (e) => setError(errorText(e)),
    );
  }, [space]);

  useEffect(() => {
    setData(null);
  }, [space]);
  useEffect(() => {
    if (!importing) load();
  }, [load, sitesVersion, importing]);

  // A deck or quiz asked for through navigation (palette, chat card, plan).
  useEffect(() => {
    if (view.kind !== "study") return;
    if (view.deck) show(space, { kind: "deck", path: view.deck });
    else if (view.quiz) show(space, { kind: "quiz", path: view.quiz, arrived: true });
  }, [view, space, show]);

  const toHub = (from?: string) => {
    show(space, HUB, from);
    if (view.kind === "study" && (view.deck || view.quiz)) go({ kind: "study" }, space);
    load();
  };

  const onMade = (m: Made) => {
    if (m.next === null) return load();
    closeMake(space);
    if (m.next === "take") show(space, { kind: "quiz", path: m.path });
    else if (m.next === "open") show(space, { kind: "deck", path: m.path });
    else show(space, { kind: "session", paths: [m.path], title: "New cards", dueOnly: false });
  };

  let body;
  if (screen.kind === "session")
    body = <ReviewSession key={JSON.stringify(screen)} space={space} paths={screen.paths} title={screen.title} dueOnly={screen.dueOnly} onExit={() => toHub(leftFrom)} />;
  else if (screen.kind === "deck")
    body = (
      <DeckEditor
        key={screen.path}
        space={space}
        path={screen.path}
        onBack={() => toHub(screen.path)}
        onReview={(path, title) => show(space, { kind: "session", paths: [path], title, dueOnly: false }, path)}
      />
    );
  else if (screen.kind === "quiz")
    body = (
      <QuizView
        key={screen.path}
        space={space}
        path={screen.path}
        arrived={screen.arrived}
        onBack={() => toHub(screen.path)}
        onMakeFromMistakes={(attempt, quiz) => openMake(space, { kind: "deck", fromAttempt: { path: attempt.path, sources: quiz.sources, quizTitle: quiz.title } })}
        onStudyDeck={(path) => show(space, { kind: "session", paths: [path], title: "Cards from your mistakes", dueOnly: false })}
      />
    );
  else
    body = (
      <Hub
        space={space}
        data={data}
        error={error}
        reload={load}
        courses={ctx.courses}
        reach={ctx.reach}
        selectedFolder={ctx.selected?.folder ?? null}
        onSelect={(o) => ctx.select(o ? { folder: o.folder, name: o.name } : null)}
        onReview={(paths, title, from) => show(space, { kind: "session", paths, title, dueOnly: true }, from)}
        onOpenDeck={(path) => show(space, { kind: "deck", path }, path)}
        onOpenQuiz={(path) => show(space, { kind: "quiz", path }, path)}
        onMake={(kind, course) => openMake(space, { kind, course })}
        focusTarget={leftFrom}
      />
    );

  return (
    <div className="h-full min-h-0" data-study-view={space}>
      {body}
      <MakeDialog space={space} request={make} sources={data?.sources ?? []} onClose={() => closeMake(space)} onMade={onMade} />
    </div>
  );
}
