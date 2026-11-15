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
import { compactTime } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { studyOverview, studySources } from "../api";
import { draftCount } from "../lib/quiz-answers";
import type { DeckSummary, QuizSummary, StudyOverview } from "../lib/types";
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
 * hero card over lilac art, four numbers, then decks and quizzes as
 * artifact cards (a grey frame holding a white sheet, the name below).
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
                data.decks.map((d, i) => (
                  <DeckCard
                    key={d.path}
                    index={i}
                    space={space.id}
                    deck={d}
                    onOpen={() => open({ kind: "review", paths: [d.path], title: d.title })}
                    onEdit={() => open({ kind: "deck", path: d.path })}
                    onDelete={() => setRemove({ path: d.path, title: d.title, kind: "deck" })}
                  />
                ))
              ) : (
                <SectionEmpty action="Make cards" onAction={() => startMake("deck")}>
                  No decks yet. Make some from a course, or write your own.
                </SectionEmpty>
              )}
            </Section>
            <Section icon={icons.quiz} label="Quizzes" count={data.quizzes.length} action="Make a quiz" onAction={() => startMake("quiz")}>
              {data.quizzes.length ? (
                data.quizzes.map((q, i) => (
                  <QuizCard
                    key={q.path}
                    index={i}
                    space={space.id}
                    quiz={q}
                    onOpen={() => open({ kind: "quiz", path: q.path })}
                    onDelete={() => setRemove({ path: q.path, title: q.title, kind: "quiz" })}
                  />
                ))
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

/** "2h ago", "just now", "Nov 5" (b72b's "1h ago" under each card). */
function ago(ms: number): string {
  const t = compactTime(ms);
  return t === "now" ? "just now" : /^\d+[mhd]$/.test(t) ? `${t} ago` : t;
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
    <section className="flex flex-col gap-4" aria-label={label}>
      <div className="flex h-8 items-center gap-2.5">
        <Icon icon={icon} className="size-4.5 text-muted-foreground" />
        <h2 className="font-medium text-base tracking-title">{label}</h2>
        {count ? <span className="text-sm text-subtle-foreground tabular-nums">{count}</span> : null}
        <Button size="xs" variant="ghost-muted" className="ml-auto" onClick={onAction}>
          <Icon icon={icons.add} />
          {action}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-7 @xl/page:grid-cols-2">{children}</div>
    </section>
  );
}

/**
 * An artifact card (after b72b): a grey frame holding a white sheet that runs
 * off its bottom edge, with the item's glyph and its first line; the name
 * and a muted line sit under the frame.
 */
function ArtifactCard({
  index,
  icon,
  title,
  line,
  badge,
  meta,
  onOpen,
  menu,
}: {
  index: number;
  icon: IconData;
  title: string;
  line: ReactNode;
  badge?: ReactNode;
  meta: ReactNode;
  onOpen: () => void;
  menu: ReactNode;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay: Math.min(index, 6) * 0.03, ease: EASE }}
      className="group relative flex min-w-0 flex-col gap-3"
    >
      {/* The whole card opens it: one real button stretched over the card, with the menu beside it (not inside). */}
      <button
        type="button"
        aria-label={title}
        onClick={onOpen}
        className="absolute inset-0 cursor-pointer rounded-card outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
      />
      <div className="pointer-events-none relative h-28 overflow-hidden rounded-card border border-border/70 bg-well transition-colors duration-150 group-hover:border-border-strong">
        <div className="absolute inset-x-8 top-5 -bottom-px flex flex-col gap-3 rounded-t-xl border border-b-0 bg-card px-5 pt-5 transition-transform duration-200 ease-(--ease-out-soft) group-hover:-translate-y-1">
          <div className="flex items-center justify-between gap-2">
            <Icon icon={icon} className="size-4.5 text-muted-foreground" />
            {badge}
          </div>
          <div className="h-5 min-w-0 overflow-hidden text-muted-foreground text-sm">{line}</div>
        </div>
      </div>
      <div className="absolute top-2 right-2">{menu}</div>
      <div className="pointer-events-none relative flex min-w-0 flex-col gap-0.5 px-0.5">
        <Truncate className="min-w-0 font-medium text-base text-foreground">{title}</Truncate>
        <span className="truncate text-muted-foreground text-sm tabular-nums">{meta}</span>
      </div>
    </motion.div>
  );
}

/** A sheet's line: the first card or question, as study text on one line (math and blanks drawn, the rest cut). */
function SheetLine({ text, fallback, space, id }: { text?: string; fallback: string; space: string; id: string }) {
  if (!text) return <Truncate className="min-w-0">{fallback}</Truncate>;
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

/** A small status chip on a sheet ("2 due", "60%"): blue for what wants you, muted otherwise. */
function Chip({ tone = "muted", children }: { tone?: "primary" | "muted" | "warning"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-md px-1.5 py-0.5 font-medium text-xs tabular-nums",
        tone === "primary" ? "bg-primary/10 text-primary" : tone === "warning" ? "bg-warning/12 text-warning-foreground" : "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function DeckCard({ index, space, deck, onOpen, onEdit, onDelete }: { index: number; space: string; deck: DeckSummary; onOpen: () => void; onEdit: () => void; onDelete: () => void }) {
  // What's due is on the sheet's chip; the line under the name says where it's from and how well it's known.
  const meta = [deck.course ?? "Your own cards", plural(deck.cards, "card"), deck.cards ? `${percent(deck.mastery)} known` : null].filter(Boolean).join(" · ");
  return (
    <ArtifactCard
      index={index}
      icon={icons.deck}
      title={deck.title}
      line={<SheetLine text={deck.firstFront} fallback="No cards yet" space={space} id={`sheet-${deck.path}`} />}
      badge={deck.due ? <Chip tone="primary">{deck.due} due</Chip> : deck.new ? <Chip>{deck.new} new</Chip> : null}
      meta={meta}
      onOpen={onOpen}
      menu={
        <CardMenu label={`Actions for ${deck.title}`}>
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

function QuizCard({ index, space, quiz, onOpen, onDelete }: { index: number; space: string; quiz: QuizSummary; onOpen: () => void; onDelete: () => void }) {
  const draft = draftCount(space, quiz.path);
  const meta = [quiz.course, plural(quiz.questions, "question"), quiz.lastTaken ? `taken ${ago(quiz.lastTaken)}` : "not taken yet"].filter(Boolean).join(" · ");
  return (
    <ArtifactCard
      index={index}
      icon={icons.quiz}
      title={quiz.title}
      line={<SheetLine text={quiz.firstPrompt} fallback="Practice quiz" space={space} id={`sheet-${quiz.path}`} />}
      badge={
        draft ? (
          <Chip tone="primary">{draft} answered</Chip>
        ) : quiz.lastScore != null ? (
          <Chip tone={quiz.lastScore < 0.6 ? "warning" : "muted"}>{percent(quiz.lastScore)}</Chip>
        ) : null
      }
      meta={meta}
      onOpen={onOpen}
      menu={
        <CardMenu label={`Actions for ${quiz.title}`}>
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
    <Card variant="well" className="flex-row items-center gap-4 p-4 @xl/page:col-span-2">
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
      <div className="grid grid-cols-1 gap-x-6 gap-y-7 @xl/page:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-3">
            <Skeleton className="h-36 animate-none rounded-card" />
            <Skeleton className="h-3 w-32 animate-none" />
            <Skeleton className="h-2.5 w-24 animate-none" />
          </div>
        ))}
      </div>
    </div>
  );
}
