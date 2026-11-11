import { Cards, Exam } from "@phosphor-icons/react";
import { EllipsisIcon, PencilLineIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { useNav } from "@/app/store";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useDelayed } from "@/hooks/use-delayed";
import { compactTime } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { studyOverview, studySources } from "../api";
import { draftCount } from "../lib/quiz-answers";
import type { DeckSummary, QuizSummary } from "../lib/types";
import { percent, plural, reviewMinutes } from "../lib/words";
import type { StudyScreen } from "../StudyView";
import { useLoad } from "../use-load";
import { ConfirmDelete } from "./ConfirmDelete";
import { MakeDialog } from "./MakeDialog";
import { GroupLabel } from "./parts";

const WIDTHS = ["58%", "44%", "67%", "51%"];

export function Overview({ space, open }: { space: SpaceView; open: (s: StudyScreen) => void }) {
  const overview = useLoad(() => studyOverview(space.id), [space.id]);
  const sources = useLoad(() => studySources(space.id), [space.id]);
  const [make, setMake] = useState<"deck" | "quiz" | null>(null);
  const [lastMake, setLastMake] = useState<"deck" | "quiz">("deck");
  const [remove, setRemove] = useState<{ path: string; title: string; kind: "deck" | "quiz" } | null>(null);
  const skeleton = useDelayed(overview.loading && !overview.data);
  const data = overview.data;
  const nothing = data && !data.decks.length && !data.quizzes.length;

  const startMake = (kind: "deck" | "quiz") => {
    setLastMake(kind);
    setMake(kind);
  };

  return (
    <>
      <Header
        title="Study"
        actions={
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="outline" />}>
              <PlusIcon />
              New
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-52">
              <MenuItem onClick={() => startMake("deck")}>
                <Cards />
                Cards from course materials
              </MenuItem>
              <MenuItem onClick={() => startMake("quiz")}>
                <Exam />
                Quiz from course materials
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => open({ kind: "deck", path: null })}>
                <PencilLineIcon />
                Write cards yourself
              </MenuItem>
            </MenuPopup>
          </Menu>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
          {overview.error ? <SurfaceError title="Couldn’t load your decks and quizzes" message={cleanMessage(overview.error)} onRetry={overview.reload} /> : null}
          {skeleton ? <OverviewSkeleton /> : null}
          {nothing ? (
            <Empty className="min-h-[60vh]">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Cards />
                </EmptyMedia>
                <EmptyTitle>Nothing to study yet</EmptyTitle>
                <EmptyDescription>
                  {sources.data && !sources.data.length
                    ? "Import a course to make flashcards and practice quizzes from its materials."
                    : "Make flashcards or a practice quiz from your course materials."}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                {sources.data && !sources.data.length ? (
                  <Button size="sm" onClick={() => useNav.getState().setView("courses")}>
                    Open courses
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => startMake("deck")}>
                    <Cards />
                    Make cards
                  </Button>
                )}
              </EmptyContent>
            </Empty>
          ) : data ? (
            <>
              <DueStrip
                due={data.due}
                fresh={data.decks.reduce((n, d) => n + d.new, 0)}
                streak={data.streakDays}
                onReview={() => open({ kind: "review", paths: null })}
              />
              <section className="flex flex-col gap-1">
                <ListHead label="Decks" count={data.decks.length} columns={["Due", "Cards", "Mastery"]} />
                {data.decks.length ? (
                  data.decks.map((d) => (
                    <DeckRow
                      key={d.path}
                      deck={d}
                      onOpen={() => open({ kind: "review", paths: [d.path], title: d.title })}
                      onEdit={() => open({ kind: "deck", path: d.path })}
                      onDelete={() => setRemove({ path: d.path, title: d.title, kind: "deck" })}
                    />
                  ))
                ) : (
                  <InlineEmpty action="Make cards" onAction={() => startMake("deck")}>
                    No decks yet.
                  </InlineEmpty>
                )}
              </section>
              <section className="flex flex-col gap-1">
                <ListHead label="Quizzes" count={data.quizzes.length} columns={["Questions", "Last score", "Taken"]} />
                {data.quizzes.length ? (
                  data.quizzes.map((q) => (
                    <QuizRow key={q.path} space={space.id} quiz={q} onOpen={() => open({ kind: "quiz", path: q.path })} onDelete={() => setRemove({ path: q.path, title: q.title, kind: "quiz" })} />
                  ))
                ) : (
                  <InlineEmpty action="Make a quiz" onAction={() => startMake("quiz")}>
                    No quizzes yet.
                  </InlineEmpty>
                )}
              </section>
            </>
          ) : null}
        </div>
      </div>
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

function DueStrip({ due, fresh, streak, onReview }: { due: number; fresh: number; streak: number; onReview: () => void }) {
  const title = due ? plural(due, "card") + " due" : fresh ? `${plural(fresh, "new card")} to learn` : "Nothing due";
  const meta = [
    due ? `About ${plural(reviewMinutes(due), "minute")}` : fresh ? null : "Cards come due again as you review them",
    due && fresh ? `${fresh} new` : null,
    streak > 1 ? `${streak}-day streak` : null,
  ].filter(Boolean);
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Cards className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm tabular-nums">{title}</div>
        {meta.length ? <div className="truncate text-muted-foreground text-xs tabular-nums">{meta.join(" · ")}</div> : null}
      </div>
      <Button size="xs" disabled={!due && !fresh} onClick={onReview}>
        {due ? "Review due cards" : "Learn new cards"}
      </Button>
    </div>
  );
}

function ListHead({ label, count, columns }: { label: string; count: number; columns: [string, string, string] }) {
  return (
    <div className="flex h-6 items-center gap-2.5 pr-2">
      <GroupLabel count={count} className="flex-1">
        {label}
      </GroupLabel>
      <span className="w-16 text-right text-2xs text-muted-foreground max-[640px]:hidden">{columns[0]}</span>
      <span className="w-16 text-right text-2xs text-muted-foreground">{columns[1]}</span>
      <span className="w-16 text-right text-2xs text-muted-foreground max-[640px]:hidden">{columns[2]}</span>
      <span className="w-6" />
    </div>
  );
}

function Row({ icon, title, course, onOpen, cells, menu }: { icon: ReactNode; title: string; course?: string; onOpen: () => void; cells: [ReactNode, ReactNode, ReactNode]; menu: ReactNode }) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={title}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (e.preventDefault(), onOpen())}
      className="group flex h-8 cursor-pointer items-center gap-2.5 rounded-md pr-2 pl-2 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">{icon}</span>
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <Truncate className="min-w-0 shrink">{title}</Truncate>
        {course ? <Truncate className="min-w-0 max-w-80 flex-1 text-muted-foreground text-xs max-[760px]:hidden">{course}</Truncate> : null}
      </div>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums max-[640px]:hidden">{cells[0]}</span>
      <span className="w-16 shrink-0 text-right text-muted-foreground text-xs tabular-nums">{cells[1]}</span>
      <span className="w-16 shrink-0 text-right text-muted-foreground text-xs tabular-nums max-[640px]:hidden">{cells[2]}</span>
      <div className="flex w-6 shrink-0 justify-end" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {menu}
      </div>
    </div>
  );
}

function RowMenu({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-xs" variant="ghost-muted" aria-label={label} className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100" />}
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">{children}</MenuPopup>
    </Menu>
  );
}

function DeckRow({ deck, onOpen, onEdit, onDelete }: { deck: DeckSummary; onOpen: () => void; onEdit: () => void; onDelete: () => void }) {
  return (
    <Row
      icon={<Cards />}
      title={deck.title}
      course={deck.course}
      onOpen={onOpen}
      cells={[
        deck.due ? <span className="font-medium text-primary">{deck.due}</span> : deck.new ? <span className="text-muted-foreground">{deck.new} new</span> : <span className="text-subtle-foreground">–</span>,
        deck.cards,
        deck.cards ? percent(deck.mastery) : "–",
      ]}
      menu={
        <RowMenu label={`Actions for ${deck.title}`}>
          <MenuItem onClick={onOpen}>Review</MenuItem>
          <MenuItem onClick={onEdit}>Edit cards</MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={onDelete}>
            Delete…
          </MenuItem>
        </RowMenu>
      }
    />
  );
}

function QuizRow({ space, quiz, onOpen, onDelete }: { space: string; quiz: QuizSummary; onOpen: () => void; onDelete: () => void }) {
  const draft = draftCount(space, quiz.path);
  return (
    <Row
      icon={<Exam />}
      title={quiz.title}
      course={quiz.course}
      onOpen={onOpen}
      cells={[
        quiz.questions || "–",
        draft ? <span className="text-primary">{draft} answered</span> : quiz.lastScore != null ? <span className={cn("text-foreground", quiz.lastScore < 0.6 && "text-warning-foreground")}>{percent(quiz.lastScore)}</span> : "–",
        quiz.lastTaken ? compactTime(quiz.lastTaken) : <span className="text-subtle-foreground">Not yet</span>,
      ]}
      menu={
        <RowMenu label={`Actions for ${quiz.title}`}>
          <MenuItem onClick={onOpen}>Take quiz</MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={onDelete}>
            Delete…
          </MenuItem>
        </RowMenu>
      }
    />
  );
}

function InlineEmpty({ children, action, onAction }: { children: ReactNode; action: string; onAction: () => void }) {
  return (
    <div className="flex h-8 items-center gap-1.5 px-2 text-muted-foreground text-xs">
      {children}
      <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6 motion-safe:animate-skeleton" aria-hidden>
      <div className="flex items-center gap-3 rounded-xl border px-3.5 py-3">
        <Skeleton className="size-8 animate-none rounded-lg" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-2.5 w-28 animate-none" />
          <Skeleton className="h-2 w-44 animate-none" />
        </div>
        <Skeleton className="h-6 w-28 animate-none rounded-md" />
      </div>
      {[4, 2].map((n, g) => (
        <div key={g} className="flex flex-col gap-1">
          <Skeleton className="mx-2 my-2 h-2 w-14 animate-none" />
          {Array.from({ length: n }, (_, i) => (
            <div key={i} className="flex h-8 items-center gap-2.5 px-2">
              <Skeleton className="size-4 animate-none rounded-[4px]" />
              <div className="flex-1">
                <Skeleton className="h-2.5 animate-none" style={{ width: WIDTHS[(i + g) % WIDTHS.length] }} />
              </div>
              <Skeleton className="h-2.5 w-8 animate-none" />
              <Skeleton className="h-2.5 w-8 animate-none" />
              <Skeleton className="h-2.5 w-8 animate-none" />
              <span className="w-6" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
