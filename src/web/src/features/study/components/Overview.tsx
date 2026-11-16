import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { useNav } from "@/app/store";
import { ArtCanvas } from "@/components/art";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Card, CardMedia } from "@/components/ui/card";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { StatGrid, StatTile } from "@/components/ui/stat-tile";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";
import { studyOverview, studySources } from "../api";
import { draftCount } from "../lib/quiz-answers";
import { shelves, shortName } from "../lib/shelf";
import type { CourseSource, DeckSummary, QuizSummary, StudyOverview } from "../lib/types";
import { percent, plural, reviewMinutes } from "../lib/words";
import type { StudyScreen } from "../StudyView";
import { useLoad } from "../use-load";
import { ConfirmDelete } from "./ConfirmDelete";
import { runningIn, useMakeJobs } from "../jobs";
import { MakeDialog } from "./MakeDialog";
import { MakingRow } from "./MakingRow";
import { EASE } from "./motion";
import { Page, StudyText } from "./parts";

/**
 * Study's front page (docs/UI-REBUILD.md › Study › Overview): what's due as a
 * hero card, four numbers, then decks and quizzes as compact cards that
 * never repeat the course (grouped by it when the space has several).
 */
export function Overview({ space, open }: { space: SpaceView; open: (s: StudyScreen) => void }) {
  const overview = useLoad(() => studyOverview(space.id), [space.id]);
  const sources = useLoad(() => studySources(space.id), [space.id]);
  const [make, setMake] = useState<"deck" | "quiz" | null>(null);
  const [lastMake, setLastMake] = useState<"deck" | "quiz">("deck");
  const [remove, setRemove] = useState<{ path: string; title: string; kind: "deck" | "quiz" } | null>(null);
  const skeleton = useDelayed(overview.loading && !overview.data);
  const data = overview.data;
  const nothing = data && !data.decks.length && !data.quizzes.length;
  const noCourses = !!sources.data && !sources.data.length;
  // Runs under way here, and a reload when one ends so what it made appears.
  const jobs = useMakeJobs((s) => s.jobs);
  const making = useMemo(() => runningIn(jobs, space.id), [jobs, space.id]);
  const finished = useMakeJobs((s) => s.finished);
  useEffect(() => {
    if (finished) overview.reload();
  }, [finished]);

  const startMake = (kind: "deck" | "quiz") => {
    setLastMake(kind);
    setMake(kind);
  };

  return (
    <>
      <Header
        actions={
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="outline" />}>
              <Icon icon={icons.add} />
              New
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-56">
              <MenuItem onClick={() => startMake("deck")}>
                <Icon icon={icons.deck} />
                Cards from course materials
              </MenuItem>
              <MenuItem onClick={() => startMake("quiz")}>
                <Icon icon={icons.quiz} />
                Quiz from course materials
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => open({ kind: "deck", path: null })}>
                <Icon icon={icons.rename} />
                Write cards yourself
              </MenuItem>
            </MenuPopup>
          </Menu>
        }
      />
      <Page>
        {overview.error ? <SurfaceError title="Couldn’t load your decks and quizzes" message={cleanMessage(overview.error)} onRetry={overview.reload} /> : null}
        {making.length ? (
          <section className="flex flex-col gap-3" aria-label="Making now" data-testid="making-now">
            <div className="flex h-8 items-center gap-2.5">
              <h2 className="font-medium text-base tracking-title">Making now</h2>
              <span className="text-sm text-subtle-foreground tabular-nums">{making.length > 1 ? making.length : ""}</span>
            </div>
            <Card className="divide-y">
              {making.map((j) => (
                <MakingRow key={j.id} job={j} className="px-4 py-3" />
              ))}
            </Card>
          </section>
        ) : null}
        {skeleton ? <OverviewSkeleton /> : null}
        {nothing ? (
          <EmptyStudy
            noCourses={noCourses}
            onCourses={() => useNav.getState().setView("courses")}
            onMake={() => startMake("deck")}
            onWrite={() => open({ kind: "deck", path: null })}
          />
        ) : data ? (
          <>
            <DueCard data={data} onReview={() => open({ kind: "review", paths: null })} onQuiz={(path) => open({ kind: "quiz", path })} onMake={() => startMake("deck")} />
            <Stats data={data} />
            <Section icon={icons.deck} label="Decks" count={data.decks.length} action="Make cards" onAction={() => startMake("deck")}>
              {data.decks.length ? (
                <Shelves
                  label="Decks"
                  items={data.decks}
                  sources={sources.data ?? []}
                  card={(d, name, i, twin) => (
                    <DeckCard
                      key={d.path}
                      index={i}
                      space={space.id}
                      deck={d}
                      name={name}
                      twin={twin}
                      onOpen={() => open({ kind: "review", paths: [d.path], title: name })}
                      onEdit={() => open({ kind: "deck", path: d.path })}
                      onDelete={() => setRemove({ path: d.path, title: name, kind: "deck" })}
                    />
                  )}
                />
              ) : (
                <SectionEmpty action="Make cards" onAction={() => startMake("deck")}>
                  No decks yet. Make some from a course, or write your own.
                </SectionEmpty>
              )}
            </Section>
            <Section icon={icons.quiz} label="Quizzes" count={data.quizzes.length} action="Make a quiz" onAction={() => startMake("quiz")}>
              {data.quizzes.length ? (
                <Shelves
                  label="Quizzes"
                  items={data.quizzes}
                  sources={sources.data ?? []}
                  card={(q, name, i, twin) => (
                    <QuizCard
                      key={q.path}
                      index={i}
                      space={space.id}
                      quiz={q}
                      name={name}
                      twin={twin}
                      onOpen={() => open({ kind: "quiz", path: q.path })}
                      onDelete={() => setRemove({ path: q.path, title: name, kind: "quiz" })}
                    />
                  )}
                />
              ) : (
                <SectionEmpty action="Make a quiz" onAction={() => startMake("quiz")}>
                  No quizzes yet. Practice for a test with questions from its materials.
                </SectionEmpty>
              )}
            </Section>
          </>
        ) : null}
      </Page>
      <MakeDialog
        space={space.id}
        kind={make ?? lastMake}
        open={make !== null}
        onOpenChange={(o) => !o && setMake(null)}
        sources={sources}
        onChanged={overview.reload}
        onOpen={(s) => {
          setMake(null);
          open(s);
        }}
      />
      <ConfirmDelete
        space={space.id}
        item={remove}
        onClose={() => setRemove(null)}
        onDeleted={(path) => {
          overview.setData((d) => d && { ...d, decks: d.decks.filter((x) => x.path !== path), quizzes: d.quizzes.filter((x) => x.path !== path) });
          overview.reload();
        }}
      />
    </>
  );
}

const newCards = (data: StudyOverview) => data.decks.reduce((n, d) => n + d.new, 0);

/** The quiz to suggest when no cards want you: one never taken, else the one taken longest ago. */
function staleQuiz(data: StudyOverview): QuizSummary | undefined {
  return [...data.quizzes].filter((q) => q.questions > 0).sort((a, b) => (a.lastTaken ?? 0) - (b.lastTaken ?? 0))[0];
}

/**
 * The hero: how much is due, about how long it takes, and the one ink action
 * (the overview's only ink button). Caught up, the action is still live: take
 * a quiz, or make more cards.
 */
function DueCard({ data, onReview, onQuiz, onMake }: { data: StudyOverview; onReview: () => void; onQuiz: (path: string) => void; onMake: () => void }) {
  const fresh = newCards(data);
  const quiz = !data.due && !fresh ? staleQuiz(data) : undefined;
  const { due, streakDays: streak } = data;
  const title = due ? plural(due, "card") + " due" : fresh ? `${plural(fresh, "new card")} to learn` : "You’re caught up";
  const meta = [
    due ? `About ${plural(reviewMinutes(due), "minute")}` : fresh ? null : quiz ? `${quiz.title} is ready to practise` : null,
    due && fresh ? `${fresh} new` : null,
    streak > 1 ? `${streak}-day streak` : null,
  ].filter(Boolean);
  return (
    <Card data-testid="study-due">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4 p-5">
        <div className="min-w-0 flex-1">
          <h2 className="font-medium text-lg tabular-nums tracking-title">{title}</h2>
          {meta.length ? <p className="mt-1 text-muted-foreground text-sm tabular-nums">{meta.join(" · ")}</p> : null}
        </div>
        {due || fresh ? (
          <Button onClick={onReview}>
            {due ? "Review due cards" : "Learn new cards"}
            <Icon icon={icons.arrowRight} />
          </Button>
        ) : quiz ? (
          <Button onClick={() => onQuiz(quiz.path)}>
            Take a quiz
            <Icon icon={icons.arrowRight} />
          </Button>
        ) : (
          <Button onClick={onMake}>
            <Icon icon={icons.add} />
            Make cards
          </Button>
        )}
      </div>
    </Card>
  );
}

/** Four numbers, label above. Mastery is weighted by how many cards each deck has. */
function Stats({ data }: { data: StudyOverview }) {
  const cards = data.decks.reduce((n, d) => n + d.cards, 0);
  const known = cards ? data.decks.reduce((n, d) => n + d.mastery * d.cards, 0) / cards : 0;
  return (
    <StatGrid>
      <StatTile label="Due now" value={data.due} />
      <StatTile label="New cards" value={newCards(data)} />
      <StatTile label="Known" value={cards ? `${Math.round(known * 100)}%` : "–"} />
      <StatTile label="Streak" value={data.streakDays} unit={data.streakDays === 1 ? "day" : "days"} />
    </StatGrid>
  );
}

function Section({ icon, label, count, action, onAction, children }: { icon: IconData; label: string; count: number; action: string; onAction: () => void; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={label}>
      <div className="flex h-8 items-center gap-2.5">
        <Icon icon={icon} className="size-4.5 text-muted-foreground" />
        <h2 className="font-medium text-base tracking-title">{label}</h2>
        {count ? <span className="text-sm text-subtle-foreground tabular-nums">{count}</span> : null}
        <Button size="xs" variant="ghost-muted" className="ml-auto" onClick={onAction}>
          <Icon icon={icons.add} />
          {action}
        </Button>
      </div>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  );
}

/**
 * A section's cards grouped by course (docs/UI-REBUILD.md › Study ›
 * Overview): a space with one course shows one plain grid, since the space
 * already says which; a space with several names each course once, above its
 * cards, instead of on every card.
 */
function Shelves<T extends { path: string; title: string; course?: string }>({
  label,
  items,
  sources,
  card,
}: {
  label: string;
  items: T[];
  sources: CourseSource[];
  card: (item: T, name: string, index: number, twin: boolean) => ReactNode;
}) {
  const groups = shelves(items, sources);
  let index = 0;
  return groups.map((g) => {
    const named = g.items.map((item) => ({ item, name: shortName(item.title, g.course) }));
    const heading = groups.length > 1 ? (g.course?.name ?? (label === "Decks" ? "Your own cards" : "Other quizzes")) : null;
    return (
      <div key={g.course?.folder ?? ""} className="flex flex-col gap-2" role={heading ? "group" : undefined} aria-label={heading ?? undefined}>
        {heading ? <h3 className="truncate px-0.5 text-muted-foreground text-sm">{heading}</h3> : null}
        <div className="grid grid-cols-1 gap-3 @xl/page:grid-cols-2">
          {named.map(({ item, name }) => card(item, name, index++, named.filter((n) => n.name.toLowerCase() === name.toLowerCase()).length > 1))}
        </div>
      </div>
    );
  });
}

/**
 * One deck or quiz as one compact card: its glyph, its name once, and one
 * quiet line of what differs from card to card (its state, then its size).
 * The whole card opens it; the "⋯" menu sits beside the open button, not in it.
 * Two cards that would read the same also show their first card or question.
 */
function StudyCard({
  index,
  icon,
  name,
  state,
  size,
  preview,
  onOpen,
  menu,
}: {
  index: number;
  icon: IconData;
  name: string;
  state?: { text: string; tone: "primary" | "warning" | "muted" };
  size: string;
  preview?: ReactNode;
  onOpen: () => void;
  menu: ReactNode;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay: Math.min(index, 6) * 0.03, ease: EASE }}
      className="group relative flex min-w-0 items-center gap-3 rounded-card border bg-card py-3 pr-2 pl-3 transition-colors duration-150 hover:border-border-strong"
      data-testid="study-card"
    >
      <button
        type="button"
        aria-label={name}
        onClick={onOpen}
        className="absolute inset-0 cursor-pointer rounded-card outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      />
      <span className="pointer-events-none flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-well">
        <Icon icon={icon} className="size-4.5 text-muted-foreground" />
      </span>
      <div className="pointer-events-none flex min-w-0 flex-1 flex-col">
        <Truncate className="min-w-0 font-medium text-foreground text-sm">{name}</Truncate>
        <span className="truncate text-muted-foreground text-sm tabular-nums">
          {state ? (
            <>
              <span className={cn(state.tone === "primary" ? "text-primary" : state.tone === "warning" ? "text-warning-foreground" : undefined)}>{state.text}</span>
              {" · "}
            </>
          ) : null}
          {size}
        </span>
        {preview ? <div className="mt-1 h-5 min-w-0 overflow-hidden text-muted-foreground text-sm">{preview}</div> : null}
      </div>
      <div className="relative shrink-0 self-start">{menu}</div>
    </motion.div>
  );
}

/** A card's first card or question, as study text on one line (math and blanks drawn, the rest cut). */
function SheetLine({ text, space, id }: { text: string; space: string; id: string }) {
  return <StudyText text={text} space={space} id={id} className="truncate [&_*]:inline [&_.katex-display]:my-0 [&_.markdown]:text-muted-foreground [&_.markdown]:text-sm [&_br]:hidden [&_p]:m-0" />;
}

function CardMenu({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={label}
            className="opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100"
          />
        }
      >
        <Icon icon={icons.more} />
      </MenuTrigger>
      <MenuPopup align="end">{children}</MenuPopup>
    </Menu>
  );
}

function DeckCard({
  index,
  space,
  deck,
  name,
  twin,
  onOpen,
  onEdit,
  onDelete,
}: {
  index: number;
  space: string;
  deck: DeckSummary;
  name: string;
  twin: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // What wants you first (due, else new, else how well it's known), then its size.
  const state = deck.due
    ? { text: `${deck.due} due`, tone: "primary" as const }
    : deck.new
      ? { text: `${deck.new} new`, tone: "muted" as const }
      : deck.cards
        ? { text: `${percent(deck.mastery)} known`, tone: "muted" as const }
        : undefined;
  return (
    <StudyCard
      index={index}
      icon={icons.deck}
      name={name}
      state={state}
      size={plural(deck.cards, "card")}
      preview={twin && deck.firstFront ? <SheetLine text={deck.firstFront} space={space} id={`sheet-${deck.path}`} /> : undefined}
      onOpen={onOpen}
      menu={
        <CardMenu label={`Actions for ${name}`}>
          <MenuItem onClick={onOpen}>
            <Icon icon={icons.play} />
            Review
          </MenuItem>
          <MenuItem onClick={onEdit}>
            <Icon icon={icons.edit} />
            Edit cards
          </MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={onDelete}>
            <Icon icon={icons.delete} />
            Delete…
          </MenuItem>
        </CardMenu>
      }
    />
  );
}

function QuizCard({ index, space, quiz, name, twin, onOpen, onDelete }: { index: number; space: string; quiz: QuizSummary; name: string; twin: boolean; onOpen: () => void; onDelete: () => void }) {
  const draft = draftCount(space, quiz.path);
  // Answers under way, else the last score (amber under 60%); a quiz never taken shows only its size.
  const state = draft
    ? { text: `${draft} answered`, tone: "primary" as const }
    : quiz.lastScore != null
      ? { text: percent(quiz.lastScore), tone: quiz.lastScore < 0.6 ? ("warning" as const) : ("muted" as const) }
      : undefined;
  return (
    <StudyCard
      index={index}
      icon={icons.quiz}
      name={name}
      state={state}
      size={plural(quiz.questions, "question")}
      preview={twin && quiz.firstPrompt ? <SheetLine text={quiz.firstPrompt} space={space} id={`sheet-${quiz.path}`} /> : undefined}
      onOpen={onOpen}
      menu={
        <CardMenu label={`Actions for ${name}`}>
          <MenuItem onClick={onOpen}>
            <Icon icon={icons.play} />
            Take quiz
          </MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={onDelete}>
            <Icon icon={icons.delete} />
            Delete…
          </MenuItem>
        </CardMenu>
      }
    />
  );
}

function SectionEmpty({ children, action, onAction }: { children: ReactNode; action: string; onAction: () => void }) {
  return (
    <Card variant="well" className="flex-row items-center gap-4 p-4">
      <p className="min-w-0 flex-1 text-muted-foreground text-sm">{children}</p>
      <Button size="sm" variant="outline" onClick={onAction}>
        {action}
      </Button>
    </Card>
  );
}

/** Nothing at all yet: an art card that says what Study does and how to start. */
function EmptyStudy({ noCourses, onCourses, onMake, onWrite }: { noCourses: boolean; onCourses: () => void; onMake: () => void; onWrite: () => void }) {
  return (
    <Card className="mx-auto mt-6 w-full max-w-md rounded-panel">
      <CardMedia className="h-32">
        <ArtCanvas palette="lilac" seed="study-empty" weave className="absolute inset-0" />
      </CardMedia>
      <div className="flex flex-col gap-1 px-6 pt-5">
        <h2 className="font-medium text-base tracking-title">Nothing to study yet</h2>
        <p className="text-muted-foreground text-sm">
          {noCourses ? "Import a course to make flashcards and practice quizzes from its materials." : "Make flashcards or a practice quiz from your course materials."}
        </p>
      </div>
      <div className="flex gap-2 p-6 pt-5">
        {noCourses ? (
          <Button className="flex-1" onClick={onCourses}>
            Open courses
          </Button>
        ) : (
          <Button className="flex-1" onClick={onMake}>
            <Icon icon={icons.deck} />
            Make cards
          </Button>
        )}
        <Button variant="outline" className="flex-1" onClick={onWrite}>
          Write your own
        </Button>
      </div>
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-10 motion-safe:animate-skeleton" aria-hidden>
      <div className="overflow-hidden rounded-panel border">
        <Skeleton className="h-28 animate-none rounded-none" />
        <div className="flex items-center gap-6 p-5">
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-36 animate-none" />
            <Skeleton className="h-3 w-56 animate-none" />
          </div>
          <Skeleton className="h-8 w-40 animate-none rounded-full" />
        </div>
      </div>
      <StatGrid>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-22 animate-none rounded-xl" />
        ))}
      </StatGrid>
      <div className="grid grid-cols-1 gap-3 @xl/page:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 animate-none rounded-card" />
        ))}
      </div>
    </div>
  );
}
