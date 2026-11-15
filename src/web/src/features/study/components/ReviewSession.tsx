import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { ArtCanvas } from "@/components/art";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Card, CardMedia } from "@/components/ui/card";
import { KeyAction, KeyActions } from "@/components/ui/key-actions";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { useDelayed } from "@/hooks/use-delayed";
import { CitationChip } from "@/features/chat/components/CitationChip";
import { studyOverview, studyRate, studySession } from "../api";
import { dueNow, masteryChanges, requeue } from "../lib/review";
import type { Confidence, DeckSummary, SessionCard } from "../lib/types";
import { baseName, cardCites, durationText, plural } from "../lib/words";
import { useLoad } from "../use-load";
import { EASE } from "./motion";
import { Crumbs, Disc, Page, StudyText } from "./parts";

/** Four answers, keys 1–4. "Somewhat" (3) is left out: four choices are quicker to pick from, and 4–5 count toward mastery. */
const RATINGS: { key: string; label: string; confidence: Confidence }[] = [
  { key: "1", label: "Not at all", confidence: 1 },
  { key: "2", label: "Barely", confidence: 2 },
  { key: "3", label: "Mostly", confidence: 4 },
  { key: "4", label: "Perfectly", confidence: 5 },
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
            <Button size="sm" variant="outline" onClick={onBack}>
              End session
            </Button>
          ) : null
        }
      />
      <Page narrow className="gap-6">
        {load.error ? <SurfaceError title="Couldn’t load the cards" message={cleanMessage(load.error)} onRetry={load.reload} /> : null}
        {skeleton ? <ReviewSkeleton /> : null}
        {queue && !queue.length ? (
          <EndCard title="You’re caught up" line="Nothing is due. Cards come due again as you review them." seed="review-empty">
            <Button variant="outline" className="w-full" onClick={onBack}>
              Back to study
            </Button>
          </EndCard>
        ) : null}
        {card ? (
          <>
            <div className="flex flex-col gap-3">
              <div className="flex h-8 items-center gap-3 text-sm">
                <Icon icon={icons.deck} className="size-4 text-muted-foreground" />
                <Truncate className="min-w-0 flex-1 text-muted-foreground">{deckTitle(card.deck)}</Truncate>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  Card <span className="text-foreground">{at + 1}</span> of {total}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Session" aria-valuemin={0} aria-valuemax={total} aria-valuenow={at}>
                <div className="h-full rounded-full bg-ink transition-[width] duration-300 ease-(--ease-out-soft)" style={{ width: `${(at / Math.max(1, total)) * 100}%` }} />
              </div>
            </div>
            <FlashCard key={`${card.id}-${at}`} card={card} space={space.id} revealed={revealed} />
            {revealed ? (
              <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: EASE }} className="flex flex-col gap-3">
                <p className="text-center text-muted-foreground text-sm">How well did you know it?</p>
                <KeyActions aria-label="How well did you know it?" className="max-sm:grid-flow-row max-sm:grid-cols-2 max-sm:divide-x-0">
                  {RATINGS.map((r) => (
                    <KeyAction key={r.key} shortcut={r.key} onClick={() => rate(r.confidence)} className="justify-center text-sm">
                      {r.label}
                    </KeyAction>
                  ))}
                </KeyActions>
              </motion.div>
            ) : (
              <div className="flex justify-center">
                <Button className="min-w-48 pr-2" onClick={() => setRevealed(true)}>
                  Show answer
                  <Kbd className="ml-1 h-5 bg-ink-foreground/15 px-1.5 text-ink-foreground/80">Space</Kbd>
                </Button>
              </div>
            )}
          </>
        ) : null}
        {finished ? <Summary rated={rated} ms={Date.now() - started.current} before={load.data?.before ?? []} after={after} onBack={onBack} /> : null}
      </Page>
    </>
  );
}

/** The card: its front, and once shown, the back under a hairline with where it comes from. */
function FlashCard({ card, space, revealed }: { card: SessionCard; space: string; revealed: boolean }) {
  const reduce = useReducedMotion();
  return (
    <motion.div initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE }}>
      <Card className="min-h-72">
        <div className="flex flex-1 flex-col justify-center px-8 py-10">
          <StudyText text={card.front} space={space} id={`card-${card.id}-front`} reveal={revealed && card.kind === "cloze"} className="text-center text-foreground [&_.markdown]:text-xl [&_.markdown]:tracking-title" />
        </div>
        <AnimatePresence initial={false}>
          {revealed ? (
            <motion.div
              key="back"
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              transition={{ type: "spring", stiffness: 420, damping: 40, opacity: { duration: 0.15 } }}
              className="overflow-hidden"
            >
              <div className="flex flex-col gap-3 border-t bg-well px-8 py-6">
                {card.kind !== "cloze" || card.back.trim() ? (
                  <StudyText text={card.back} space={space} id={`card-${card.id}-back`} className="text-center [&_.markdown]:text-base" />
                ) : null}
                {cardCites(card).length ? (
                  <div className="flex justify-center">
                    {cardCites(card).map((c) => (
                      <CitationChip key={c.source} space={space} citation={{ path: c.source, quote: c.quote }} />
                    ))}
                  </div>
                ) : null}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </Card>
    </motion.div>
  );
}

/** The closing card of a session (c06d): art across the top, a title, a line, then what changed. */
function EndCard({ title, line, seed, children, list }: { title: string; line: string; seed: string; children: React.ReactNode; list?: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE }} className="mx-auto mt-4 w-full max-w-md">
      <Card>
        <CardMedia className="h-28">
          <ArtCanvas palette="lilac" seed={seed} weave className="absolute inset-0" />
        </CardMedia>
        <div className="flex flex-col gap-5 p-6">
          <div className="text-center">
            <h2 className="font-medium text-lg tracking-title">{title}</h2>
            <p className="mt-1 text-muted-foreground text-sm tabular-nums">{line}</p>
          </div>
          {list}
          {children}
        </div>
      </Card>
    </motion.div>
  );
}

function Summary({ rated, ms, before, after, onBack }: { rated: { again: number; total: number }; ms: number; before: DeckSummary[]; after: DeckSummary[] | null; onBack: () => void }) {
  const changes = after ? masteryChanges(before, after) : [];
  return (
    <EndCard
      title="Session done"
      seed="review-done"
      line={`${plural(rated.total, "answer")} in ${durationText(ms)}${rated.again ? ` · ${plural(rated.again, "card")} to see again soon` : ""}`}
      list={
        changes.length ? (
          <Card variant="well" className="gap-0 px-4 py-1.5">
            {changes.map((c) => (
              <div key={c.path} className="flex h-9 items-center gap-3 text-sm">
                <Disc tone={c.now > c.was ? "done" : "muted"} />
                <Truncate className="min-w-0 flex-1 text-foreground">{c.title}</Truncate>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {c.was}% → <span className="text-foreground">{c.now}%</span>
                </span>
              </div>
            ))}
          </Card>
        ) : null
      }
    >
      <Button className="w-full" onClick={onBack}>
        Back to study
      </Button>
    </EndCard>
  );
}

function ReviewSkeleton() {
  return (
    <div className="flex flex-col gap-6 motion-safe:animate-skeleton" aria-hidden>
      <div className="flex flex-col gap-3">
        <div className="flex h-8 items-center justify-between">
          <Skeleton className="h-3 w-32 animate-none" />
          <Skeleton className="h-3 w-16 animate-none" />
        </div>
        <Skeleton className="h-1 w-full animate-none" />
      </div>
      <div className="flex min-h-72 flex-col items-center justify-center gap-3 rounded-card border">
        <Skeleton className="h-4 w-3/5 animate-none" />
        <Skeleton className="h-4 w-2/5 animate-none" />
      </div>
      <div className="flex justify-center">
        <Skeleton className="h-8 w-48 animate-none rounded-full" />
      </div>
    </div>
  );
}
