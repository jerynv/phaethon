import { useEffect, useState } from "react";
import type { SpaceView } from "@/app/api";
import { DeckEditor } from "./components/DeckEditor";
import { useStudyFlow } from "./flow-store";
import { Overview } from "./components/Overview";
import { QuizScreen } from "./components/QuizScreen";
import { ReviewSession } from "./components/ReviewSession";

/**
 * Study: the overview of decks and quizzes, and the screens it opens (a
 * review session, a quiz, the deck editor). Making a deck or quiz is a
 * dialog over the overview.
 */
export type StudyScreen =
  | { kind: "overview" }
  | { kind: "review"; paths: string[] | null; title?: string }
  | { kind: "quiz"; path: string }
  | { kind: "deck"; path: string | null };

export function StudyView({ space }: { space: SpaceView }) {
  // A screen asked for from elsewhere (a quiz made from a chat card) opens first.
  const [screen, setScreen] = useState<StudyScreen>(() => useStudyFlow.getState().take(space.id) ?? { kind: "overview" });
  const next = useStudyFlow((s) => (s.next?.space === space.id ? s.next.screen : null));
  useEffect(() => {
    if (next) setScreen(useStudyFlow.getState().take(space.id) ?? next);
  }, [next, space.id]);
  const back = () => setScreen({ kind: "overview" });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {screen.kind === "overview" ? <Overview space={space} open={setScreen} /> : null}
      {screen.kind === "review" ? <ReviewSession key={JSON.stringify(screen.paths)} space={space} paths={screen.paths} title={screen.title} onBack={back} /> : null}
      {screen.kind === "quiz" ? <QuizScreen key={screen.path} space={space} path={screen.path} onBack={back} open={setScreen} /> : null}
      {screen.kind === "deck" ? <DeckEditor key={screen.path ?? "new"} space={space} path={screen.path} onBack={back} open={setScreen} /> : null}
    </div>
  );
}
