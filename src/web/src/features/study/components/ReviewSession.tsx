import { Cards } from "@phosphor-icons/react";
import { CircleCheckIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { toast } from "@/components/toast";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { useDelayed } from "@/hooks/use-delayed";
import { CitationChip } from "@/features/chat/components/CitationChip";
import { cn } from "@/lib/utils";
import { studyOverview, studyRate, studySession } from "../api";
import { dueNow, masteryChanges, requeue } from "../lib/review";
import type { Confidence, DeckSummary, SessionCard } from "../lib/types";
import { baseName, cardCites, durationText, plural } from "../lib/words";
import { useLoad } from "../use-load";
import { Crumbs, StudyText } from "./parts";

/** Four answers, keys 1–4. "Somewhat" (3) is left out: four choices are quicker to pick from, and 4–5 count toward mastery. */
const RATINGS: { key: string; label: string; confidence: Confidence; tone: string }[] = [
  { key: "1", label: "Not at all", confidence: 1, tone: "hover:border-error/40 hover:bg-error/6" },
  { key: "2", label: "Barely", confidence: 2, tone: "hover:border-warning/40 hover:bg-warning/6" },
  { key: "3", label: "Mostly", confidence: 4, tone: "hover:border-primary/40 hover:bg-primary/6" },
  { key: "4", label: "Perfectly", confidence: 5, tone: "hover:border-success/40 hover:bg-success/6" },
];

type Load = { cards: SessionCard[]; before: DeckSummary[] };

/**
 * One card at a time: the front, then (space) the back, then how well it was
 * known (1–4). A card the core says to see again comes back a few cards
 * later. Ends on a summary of the session.
 */
export function ReviewSession({ space, paths, title, onBack }: { space: SpaceView; paths: string[] | null; title?: string; onBack: () => void }) {
  const load = useLoad<Load>(
    async () => {
      const [cards, overview] = await Promise.all([studySession(space.id, paths), studyOverview(space.id).catch(() => null)]);
      return { cards: paths ? cards : dueNow(cards), before: overview?.decks ?? [] };
    },
    [space.id, JSON.stringify(paths)],
  );
  const skeleton = useDelayed(load.loading && !load.data);
  const [queue, setQueue] = useState<SessionCard[] | null>(null);
  const [at, setAt] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [rated, setRated] = useState<{ again: number; total: number }>({ again: 0, total: 0 });
  const started = useRef(Date.now());
  const [after, setAfter] = useState<DeckSummary[] | null>(null);

  useEffect(() => {
    if (load.data && queue === null) {
      setQueue(load.data.cards);
      started.current = Date.now();
    }
  }, [load.data, queue]);

  const card = queue?.[at];
  const finished = queue !== null && queue.length > 0 && at >= queue.length;

  useEffect(() => {
    if (finished && after === null) studyOverview(space.id).then((o) => setAfter(o.decks), () => setAfter([]));
  }, [finished, after, space.id]);

  const rate = useCallback(
    (confidence: Confidence) => {
      if (!card || !queue) return;
      const i = at;
      setRevealed(false);
      setAt(i + 1);
      setRated((r) => ({ ...r, total: r.total + 1 }));
      studyRate(space.id, card.deck, card.id, confidence).then(
        (r) => {
          if (!r.again) return;
          setRated((x) => ({ ...x, again: x.again + 1 }));
          setQueue((cur) => (cur ? requeue(cur, i, card, confidence) : cur));
        },
        (e) => {
          toast.error("Couldn’t save that answer", `${cleanMessage(e)} The card comes back at the end.`);
          setQueue((cur) => (cur ? [...cur, card] : cur));
        },
      );
    },
    [card, queue, at, space.id],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !card) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable=true], [role=menu], [role=dialog]")) return;
      if (!revealed && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        setRevealed(true);
        return;
      }
      if (revealed) {
        const r = RATINGS.find((x) => x.key === e.key);
        if (r) {
          e.preventDefault();
          rate(r.confidence);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card, revealed, rate]);

  const total = queue?.length ?? 0;
  const deckTitle = (path: string) => load.data?.before.find((d) => d.path === path)?.title ?? baseName(path);

  return (
    <>
      <Header
        title={<Crumbs onBack={onBack}>{title ?? "Review"}</Crumbs>}
        actions={
          queue?.length && !finished ? (
            <Button size="xs" variant="ghost-muted" onClick={onBack}>
              End session
            </Button>
          ) : null
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">
          {load.error ? <SurfaceError title="Couldn’t load the cards" message={cleanMessage(load.error)} onRetry={load.reload} /> : null}
          {skeleton ? <ReviewSkeleton /> : null}
          {queue && !queue.length ? (
            <Empty className="min-h-[50vh]">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Cards />
                </EmptyMedia>
                <EmptyTitle>Nothing due</EmptyTitle>
                <EmptyDescription>You’re caught up. Cards come due again as you review them.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button size="sm" variant="outline" onClick={onBack}>
                  Back to study
                </Button>
              </EmptyContent>
            </Empty>
          ) : null}
          {card ? (
            <>
              <div className="flex items-center gap-3">
                <Truncate className="min-w-0 flex-1 text-muted-foreground text-xs">{deckTitle(card.deck)}</Truncate>
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {at + 1}/{total}
                </span>
              </div>
              <div className="h-0.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${(at / Math.max(1, total)) * 100}%` }} />
              </div>
              <div className="flex min-h-64 flex-col rounded-xl border bg-card">
                <div className="flex flex-1 flex-col justify-center px-6 py-8">
                  <StudyText key={`${card.id}-f`} text={card.front} space={space.id} id={`card-${card.id}-front`} reveal={revealed && card.kind === "cloze"} className="text-center [&_.markdown]:text-[0.9375rem]" />
                </div>
                {revealed ? (
                  <div className="flex flex-col gap-3 border-t px-6 py-5">
                    {card.kind !== "cloze" || card.back.trim() ? (
                      <StudyText text={card.back} space={space.id} id={`card-${card.id}-back`} className="text-center [&_.markdown]:text-[0.9375rem]" />
                    ) : null}
                    {cardCites(card).length ? (
                      <div className="flex justify-center">
                        {cardCites(card).map((c) => (
                          <CitationChip key={c.source} space={space.id} citation={{ path: c.source, quote: c.quote }} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {revealed ? (
                <div className="flex flex-col gap-2">
                  <p className="text-center text-muted-foreground text-xs">How well did you know it?</p>
                  <div className="grid grid-cols-4 gap-1.5">
                    {RATINGS.map((r) => (
                      <button
                        key={r.key}
                        type="button"
                        onClick={() => rate(r.confidence)}
                        className={cn("flex h-9 items-center justify-center gap-2 rounded-lg border bg-card px-2 font-medium text-sm transition-colors", r.tone)}
                      >
                        <span className="truncate">{r.label}</span>
                        <Kbd className="max-[700px]:hidden">{r.key}</Kbd>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex justify-center">
                  <Button size="sm" variant="outline" className="min-w-40" onClick={() => setRevealed(true)}>
                    Show answer
                    <Kbd>Space</Kbd>
                  </Button>
                </div>
              )}
            </>
          ) : null}
          {finished ? <Summary rated={rated} ms={Date.now() - started.current} before={load.data?.before ?? []} after={after} onBack={onBack} /> : null}
        </div>
      </div>
    </>
  );
}

function Summary({ rated, ms, before, after, onBack }: { rated: { again: number; total: number }; ms: number; before: DeckSummary[]; after: DeckSummary[] | null; onBack: () => void }) {
  const changes = after ? masteryChanges(before, after) : [];
  return (
    <div className="flex flex-col items-center gap-5 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-success/10 text-success">
        <CircleCheckIcon className="size-5" strokeWidth={1.75} />
      </div>
      <div>
        <h2 className="font-semibold text-xl tracking-[-0.015em]">Session done</h2>
        <p className="mt-1 text-muted-foreground text-sm tabular-nums">
          {plural(rated.total, "answer")} in {durationText(ms)}
          {rated.again ? ` · ${plural(rated.again, "card")} to see again soon` : ""}
        </p>
      </div>
      {changes.length ? (
        <div className="w-full max-w-sm divide-y rounded-xl border text-left">
          {changes.map((c) => (
            <div key={c.path} className="flex h-9 items-center gap-3 px-3 text-sm">
              <Truncate className="min-w-0 flex-1">{c.title}</Truncate>
              <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                {c.was}% → <span className={cn("font-medium", c.now > c.was ? "text-success-foreground" : "text-foreground")}>{c.now}%</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <Button size="sm" onClick={onBack}>
        Back to study
      </Button>
    </div>
  );
}

function ReviewSkeleton() {
  return (
    <div className="flex flex-col gap-4 motion-safe:animate-skeleton" aria-hidden>
      <div className="flex justify-between">
        <Skeleton className="h-2.5 w-32 animate-none" />
        <Skeleton className="h-2.5 w-10 animate-none" />
      </div>
      <Skeleton className="h-0.5 w-full animate-none" />
      <div className="flex min-h-64 flex-col items-center justify-center gap-2.5 rounded-xl border">
        <Skeleton className="h-3 w-[58%] animate-none" />
        <Skeleton className="h-3 w-[36%] animate-none" />
      </div>
      <div className="flex justify-center">
        <Skeleton className="h-7 w-40 animate-none rounded-md" />
      </div>
    </div>
  );
}
