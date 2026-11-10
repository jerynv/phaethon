/**
 * A review session: one card at a time, reveal, then how well you knew it
 * (1–5, also by keyboard). A card you barely knew comes back later in the
 * session. Ends with a summary: cards studied, time, what to revisit, and how
 * each deck's mastery moved.
 */
import { CheckIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";

import { EduPage, EmptyState, ErrorState, LiveText, Meter, PageHeader, RowList } from "../courses/shared/kit";
import { studyOverview, studyRate, studySession } from "./api";
import { CardText, MathText } from "./CardText";
import { SourceLine } from "./Grounding";
import { dueNow, masteryChanges, requeue } from "./lib/review";
import type { Confidence, SessionCard, StudyOverview } from "./lib/types";
import { baseName, cardCites, clozeAnswer, CONFIDENCE, durationText, plural, spokenFront } from "./lib/words";

type Summary = { studied: number; ms: number; revisit: SessionCard[]; changes: ReturnType<typeof masteryChanges> };

export function ReviewSession({ space, paths, title, dueOnly, onExit }: { space: string; paths: string[] | null; title: string; dueOnly: boolean; onExit: () => void }) {
  const [queue, setQueue] = useState<SessionCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const before = useRef<StudyOverview | null>(null);
  const started = useRef(Date.now());
  const studied = useRef(0);
  const revisit = useRef<SessionCard[]>([]);
  const showRef = useRef<HTMLButtonElement>(null);
  const ratingsRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setError(null);
    setQueue(null);
    Promise.all([studySession(space, paths, 40), studyOverview(space).catch(() => null)]).then(
      ([cards, overview]) => {
        before.current = overview;
        started.current = Date.now();
        setQueue(dueOnly ? dueNow(cards) : cards);
      },
      (e) => setError(errorText(e)),
    );
  }, [space, paths, dueOnly]);
  useEffect(load, [load]);

  const card = queue?.[at];

  const finish = useCallback(async () => {
    const after = await studyOverview(space).catch(() => null);
    setSummary({
      studied: studied.current,
      ms: Date.now() - started.current,
      revisit: revisit.current,
      changes: before.current && after ? masteryChanges(before.current.decks, after.decks) : [],
    });
  }, [space]);

  const reveal = useCallback(() => {
    if (!card || revealed) return;
    setRevealed(true);
    setSaid(`Answer: ${card.kind === "cloze" ? clozeAnswer(card) : card.back}`);
    requestAnimationFrame(() => ratingsRef.current?.focus());
  }, [card, revealed]);

  const rate = useCallback(
    async (c: Confidence) => {
      if (!card || !revealed || saving || !queue) return;
      setSaving(true);
      setProblem(null);
      try {
        const r = await studyRate(space, card.deck, card.id, c);
        studied.current++;
        if (c <= 2 && !revisit.current.some((x) => x.id === card.id)) revisit.current.push(card);
        const next = r.again ? requeue(queue, at, card, c) : queue;
        const last = at + 1 >= next.length;
        setQueue(next);
        setRevealed(false);
        if (last) {
          await finish();
        } else {
          setAt(at + 1);
          setSaid(`Rated ${CONFIDENCE[c - 1]}.${r.again ? " It comes back later." : ""} Card ${at + 2} of ${next.length}.`);
          requestAnimationFrame(() => showRef.current?.focus());
        }
      } catch (e) {
        setProblem(`That rating couldn’t be saved: ${errorText(e)}`);
      } finally {
        setSaving(false);
      }
    },
    [card, revealed, saving, queue, space, at, finish],
  );

  useEffect(() => {
    if (summary || !card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable=true]")) return;
      const onControl = !!t?.closest("button, a, summary");
      if ((e.key === " " || e.key === "Enter") && !revealed && !onControl) {
        e.preventDefault();
        reveal();
      } else if (/^[1-5]$/.test(e.key) && revealed) {
        e.preventDefault();
        void rate(Number(e.key) as Confidence);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card, revealed, reveal, rate, summary]);

  const exit = () => (studied.current > 0 && !summary ? void finish() : onExit());

  if (summary) return <SessionSummary title={title} s={summary} onExit={onExit} />;

  return (
    <EduPage narrow label={`Review: ${title}`}>
      <LiveText>{said}</LiveText>
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost-muted" size="sm" className="-ms-2" onClick={exit}>
          <XIcon aria-hidden />
          {studied.current > 0 ? "End review" : "Back to Study"}
        </Button>
        {queue && queue.length > 0 && (
          <span className="text-sm text-muted-foreground tabular-nums" data-session-progress="">
            Card {at + 1} of {queue.length}
          </span>
        )}
      </div>
      {queue && queue.length > 0 && <Meter value={at / queue.length} className="-mt-5" />}

      {error ? (
        <ErrorState title="The cards couldn’t be loaded." message={error} onRetry={load} />
      ) : !queue ? (
        <div role="status" aria-label="Getting your cards" className="h-72 rounded-2xl border bg-card motion-safe:animate-pulse" />
      ) : !card ? (
        <EmptyState icon={<CheckIcon />} title="Nothing is due right now" description="Cards come back on the day they’re due.">
          <Button onClick={onExit}>Back to Study</Button>
        </EmptyState>
      ) : (
        <>
          <article
            aria-labelledby="review-front"
            className="flex min-h-72 flex-col gap-6 rounded-2xl border bg-card p-6 sm:p-8"
            data-session-card={card.id}
          >
            <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
              <span>{card.kind === "cloze" ? "Fill in the blank" : "Question"}</span>
              <span className="truncate">{title === baseName(card.deck) ? "" : baseName(card.deck)}</span>
            </div>
            <div id="review-front" className="text-xl leading-relaxed text-foreground sm:text-2xl sm:leading-relaxed">
              <span className="sr-only">{spokenFront(card)}</span>
              <span aria-hidden>
                <CardText text={card.front} reveal={revealed} />
              </span>
            </div>
            {revealed && (
              <div className="flex flex-col gap-3 border-t pt-5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200" data-session-answer="">
                <span className="text-sm text-muted-foreground">Answer</span>
                <div className="text-lg leading-relaxed text-foreground">
                  <MathText text={card.kind === "cloze" ? clozeAnswer(card) : card.back} />
                </div>
                <SourceLine cites={cardCites(card)} space={space} />
              </div>
            )}
          </article>

          {!revealed ? (
            <div className="flex flex-col items-center gap-2">
              <Button ref={showRef} size="lg" className="min-w-48" onClick={reveal} aria-describedby="review-front" data-show-answer="">
                Show answer
              </Button>
              <span className="text-sm text-muted-foreground" aria-hidden>
                or press <Kbd>Space</Kbd>
              </span>
            </div>
          ) : (
            <div ref={ratingsRef} tabIndex={-1} role="group" aria-labelledby="review-rate-label" className="flex flex-col gap-3 rounded-xl outline-none" data-ratings="">
              <p id="review-rate-label" className="text-center text-sm font-medium text-foreground">
                How well did you know it?
              </p>
              <div className="grid grid-cols-5 gap-2">
                {CONFIDENCE.map((word, i) => (
                  <button
                    key={word}
                    type="button"
                    aria-disabled={saving || undefined}
                    aria-keyshortcuts={String(i + 1)}
                    onClick={() => void rate((i + 1) as Confidence)}
                    className={cn(
                      "flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border bg-card px-1 py-2 text-center text-sm font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-60 motion-reduce:transition-none",
                      i <= 1 && "hover:border-warning/50",
                      i >= 3 && "hover:border-success/50",
                    )}
                    data-rate={i + 1}
                  >
                    <Kbd aria-hidden>{i + 1}</Kbd>
                    <span className="leading-tight">{word}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {problem && (
            <p role="alert" className="text-center text-sm text-destructive-foreground">
              {problem}
            </p>
          )}
        </>
      )}
    </EduPage>
  );
}

function SessionSummary({ title, s, onExit }: { title: string; s: Summary; onExit: () => void }) {
  return (
    <EduPage narrow label="Review finished">
      <PageHeader title="Review done" meta={title} focusKey="summary" />
      <dl className="grid grid-cols-3 divide-x rounded-2xl border bg-card">
        {[
          ["Cards studied", String(s.studied)],
          ["Time", durationText(s.ms)],
          ["To revisit", String(s.revisit.length)],
        ].map(([k, v]) => (
          <div key={k} className="flex flex-col gap-1 px-4 py-4 sm:px-6">
            <dt className="text-sm text-muted-foreground">{k}</dt>
            <dd className="text-2xl font-semibold tracking-tight text-foreground tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {s.changes.length > 0 && (
        <section aria-labelledby="mastery-h" className="flex flex-col gap-2">
          <h2 id="mastery-h" className="text-base font-semibold">
            Mastery
          </h2>
          <ul className="flex flex-col gap-1.5 text-sm">
            {s.changes.map((c) => (
              <li key={c.path} className="flex justify-between gap-4">
                <span className="text-foreground">{c.title}</span>
                <span className="text-muted-foreground tabular-nums">
                  {c.was}% → {c.now}% ({c.now > c.was ? "up" : "down"})
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="revisit-h" className="flex flex-col gap-2">
        <h2 id="revisit-h" className="text-base font-semibold">
          Cards to revisit
        </h2>
        {s.revisit.length === 0 ? (
          <p className="text-sm text-muted-foreground">You knew every card well.</p>
        ) : (
          <RowList>
            {s.revisit.map((c) => (
              <li key={c.id} className="flex flex-col gap-1 px-4 py-3">
                <CardText text={c.front} reveal className="text-[0.9375rem] text-foreground" />
                {c.kind !== "cloze" && <MathText text={c.back} className="text-sm text-muted-foreground" />}
              </li>
            ))}
          </RowList>
        )}
      </section>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onExit}>Back to Study</Button>
        {s.revisit.length > 0 && (
          <span className="text-sm text-muted-foreground self-center">
            <RotateCcwIcon aria-hidden className="me-1 inline size-3.5" />
            {plural(s.revisit.length, "card")} will come back soon.
          </span>
        )}
      </div>
    </EduPage>
  );
}
