import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { Keys } from "@/components/shell/command-palette";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { studyOverview, studyRate, studySession, type Confidence, type DeckSummary } from "@/lib/study";
import { cn } from "@/lib/utils";

import { mathAsText } from "@/lib/study-math";

import { CardText, MathText } from "./card-text";
import { baseName, clozeAnswer, CONFIDENCE, durationText, percent, plainError, plural, spokenFront } from "./words";

type SessionCard = Awaited<ReturnType<typeof studySession>>[number];

/** How many cards one session shows at most (repeats come on top). */
const SESSION_LIMIT = 40;
/** A card rated 1 comes back after this many cards; rated 2, after this many (or at the end). */
const AGAIN_SOON = 3;
const AGAIN_LATER = 8;

type Ended = { studied: number; ms: number; revisit: SessionCard[]; before: DeckSummary[]; after: DeckSummary[] };

/**
 * A review session, Brainscape-style: one card at a time, the front first.
 * Space or Enter shows the answer, then 1 to 5 says how well you knew it
 * ("Not at all" … "Perfectly"). A card you barely knew comes back later in
 * the same session. At the end: what changed, how long it took, and the
 * cards to revisit.
 *
 * Screen readers: the Show answer button is described by the front, so the
 * front is read with it; showing the answer says it and puts focus on the
 * ratings; after a rating focus is on the next card's Show answer. Focus is
 * never left on something that went away. Reduced motion: no flip.
 */
export function ReviewSession({
  space,
  paths,
  title,
  onExit,
}: {
  space: string;
  /** null: everything due in the space. */
  paths: string[] | null;
  title: string;
  onExit: () => void;
}) {
  const id = useId();
  const [queue, setQueue] = useState<SessionCard[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [at, setAt] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [rating, setRating] = useState(false);
  const [rateError, setRateError] = useState("");
  const [ended, setEnded] = useState<Ended | null>(null);
  const [said, setSaid] = useState("");
  const started = useRef(Date.now());
  const before = useRef<DeckSummary[]>([]);
  const studied = useRef(new Set<string>());
  const revisit = useRef(new Map<string, SessionCard>());
  const repeats = useRef(0);
  const showRef = useRef<HTMLButtonElement>(null);
  const ratingsRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const say = useCallback((m: string) => {
    setSaid("");
    requestAnimationFrame(() => setSaid(m));
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([studySession(space, paths, SESSION_LIMIT), studyOverview(space).catch(() => null)]).then(
      ([cards, overview]) => {
        if (!live) return;
        before.current = overview?.decks ?? [];
        started.current = Date.now();
        setQueue(cards);
      },
      (e: unknown) => live && setLoadError(plainError(e)),
    );
    return () => {
      live = false;
    };
  }, [space, paths]);

  // The first card's Show answer takes focus once the cards are here (its description reads the front).
  useLayoutEffect(() => {
    if (queue && queue.length > 0 && at === 0 && !flipped) showRef.current?.focus();
    else if (queue && queue.length === 0) headingRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue === null]);

  const card = queue && !ended ? queue[at] : undefined;

  const flip = useCallback(() => {
    if (!card || flipped) return;
    setFlipped(true);
    say(`Answer: ${mathAsText(card.kind === "cloze" ? clozeAnswer(card) : card.back)}`);
  }, [card, flipped, say]);

  // Focus follows the card: the ratings once it is turned, the next Show answer after a rating.
  const turned = useRef({ at: 0, flipped: false });
  useLayoutEffect(() => {
    const was = turned.current;
    turned.current = { at, flipped };
    if (flipped && !was.flipped) ratingsRef.current?.focus();
    else if (!flipped && at !== was.at) showRef.current?.focus();
  }, [at, flipped]);

  const finish = useCallback(async () => {
    const after = await studyOverview(space).then(
      (o) => o.decks,
      () => [] as DeckSummary[],
    );
    setEnded({ studied: studied.current.size, ms: Date.now() - started.current, revisit: [...revisit.current.values()], before: before.current, after });
  }, [space]);

  const rate = useCallback(
    async (confidence: Confidence) => {
      if (!card || !flipped || rating || !queue) return;
      setRating(true);
      setRateError("");
      try {
        const r = await studyRate(space, card.deck, card.id, confidence);
        studied.current.add(card.id);
        if (confidence <= 2) revisit.current.set(card.id, card);
        let next = queue;
        if (r.again) {
          // Comes back in this session: soon after a 1, later after a 2.
          const gap = confidence <= 1 ? AGAIN_SOON : AGAIN_LATER;
          const pos = Math.min(queue.length, at + 1 + gap);
          next = [...queue.slice(0, pos), card, ...queue.slice(pos)];
          repeats.current++;
          setQueue(next);
        }
        const word = CONFIDENCE[confidence - 1];
        if (at + 1 >= next.length) {
          say(`Rated ${word}. That was the last card.`);
          await finish();
          return;
        }
        setAt(at + 1);
        setFlipped(false);
        say(`Rated ${word}.${r.again ? " This card comes back later in this session." : ""} Card ${at + 2} of ${next.length}.`);
      } catch (e) {
        // The card stays, so nothing is lost: rate it again.
        setRateError(`That rating couldn’t be saved: ${plainError(e)}`);
      } finally {
        setRating(false);
      }
    },
    [card, flipped, rating, queue, space, at, finish, say],
  );

  // A key pressed while focus is nowhere (the page itself) still reaches the card.
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useEffect(() => {
    const onWindow = (e: globalThis.KeyboardEvent) => {
      if (document.activeElement === document.body || !document.activeElement) onKeyRef.current(e);
    };
    window.addEventListener("keydown", onWindow);
    return () => window.removeEventListener("keydown", onWindow);
  }, []);

  // The ended screen's heading takes focus.
  useLayoutEffect(() => {
    if (ended) headingRef.current?.focus();
  }, [ended]);

  // Space or Enter shows the answer; 1 to 5 rate it. Not while a button other than these has focus.
  function onKey(e: KeyboardEvent<HTMLDivElement> | globalThis.KeyboardEvent) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !card) return;
    const target = e.target as HTMLElement;
    const onOtherButton = target.closest("button, a, input, textarea") && !target.closest("[data-show-answer], [data-ratings]");
    if (!flipped && (e.key === " " || e.key === "Enter")) {
      if (onOtherButton) return;
      e.preventDefault();
      flip();
      return;
    }
    if (flipped && /^[1-5]$/.test(e.key)) {
      if (target.closest("input, textarea")) return;
      e.preventDefault();
      void rate(Number(e.key) as Confidence);
    }
  }

  if (loadError) {
    return (
      <Frame title={title} onExit={onExit} headingRef={headingRef}>
        <div role="alert" className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3 py-2.5 text-base text-ink">
          <Icon name="error" className="mt-0.5 shrink-0 text-danger-ink" />
          <p>The cards couldn’t be loaded. {loadError}</p>
        </div>
      </Frame>
    );
  }
  if (!queue) {
    return (
      <Frame title={title} onExit={onExit} headingRef={headingRef}>
        <p role="status" className="flex items-center gap-2 text-md text-ink-secondary">
          <Icon name="spinner" className="animate-spin" />
          Getting your cards…
        </p>
      </Frame>
    );
  }
  if (queue.length === 0) {
    return (
      <Frame title={title} onExit={onExit} headingRef={headingRef}>
        <p className="text-md text-ink" data-session-empty="">
          Nothing is due right now. Cards come back when it’s time to see them again.
        </p>
      </Frame>
    );
  }
  if (ended) return <Summary title={title} ended={ended} onExit={onExit} headingRef={headingRef} />;
  if (!card) return null;

  const total = queue.length;
  const frontId = `${id}-front`;
  const cloze = card.kind === "cloze";
  // Ending part way through still shows what was done.
  const endEarly = () => (studied.current.size ? void finish() : onExit());
  return (
    <Frame title={title} onExit={endEarly} headingRef={headingRef} wide>
      <div onKeyDown={onKey} className="flex min-h-0 flex-1 flex-col gap-4" data-review-session="" data-card-id={card.id} data-flipped={flipped ? "" : undefined}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <p className="text-base font-medium text-ink" data-session-progress="">
            Card {at + 1} of {total}
          </p>
          <div aria-hidden="true" className="h-(--ph-space) min-w-24 flex-1 overflow-hidden rounded-full bg-surface-sunken forced-colors:border forced-colors:border-[CanvasText]">
            <div className="h-full rounded-full bg-accent-fill forced-colors:bg-[Highlight]" style={{ width: `${Math.round((at / total) * 100)}%` }} />
          </div>
          <p className="text-sm text-ink-secondary">{baseName(card.deck)}</p>
        </div>

        <section
          aria-label="Card"
          className="flex flex-col gap-5 rounded-xl border border-line bg-raised px-6 py-6 shadow-sm forced-colors:border-[CanvasText]"
        >
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium tracking-wide text-ink-secondary uppercase">{cloze ? "Fill in the blank" : "Question"}</p>
            <p id={frontId} className="text-2xl leading-normal wrap-break-word text-ink" data-card-front="">
              <span className="sr-only">
                <MathText text={spokenFront(card)} />
              </span>
              <span aria-hidden="true">
                <CardText text={card.front} reveal={flipped} />
              </span>
            </p>
          </div>
          {flipped && (
            <div
              className="flex flex-col gap-1 border-t border-line pt-5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-(--ph-duration-slow)"
              data-card-back=""
            >
              <p className="text-sm font-medium tracking-wide text-ink-secondary uppercase">Answer</p>
              <p className="text-2xl leading-normal wrap-break-word text-ink">
                <MathText text={cloze ? clozeAnswer(card) : card.back} />
              </p>
            </div>
          )}
        </section>

        {rateError && (
          <div role="alert" className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3 py-2 text-base text-ink">
            <Icon name="error" className="mt-0.5 shrink-0 text-danger-ink" />
            <p className="min-w-0 wrap-break-word">{rateError}</p>
          </div>
        )}

        {!flipped ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button ref={showRef} type="button" size="lg" onClick={flip} aria-describedby={frontId} aria-keyshortcuts="Space Enter" data-show-answer="">
              Show answer
            </Button>
            <span className="flex items-center gap-1.5 text-sm text-ink-secondary">
              or press <Keys keys={["Space"]} />
            </span>
          </div>
        ) : (
          <div
            ref={ratingsRef}
            tabIndex={-1}
            role="group"
            aria-labelledby={`${id}-ask`}
            data-ratings=""
            className="flex flex-col gap-2 rounded-lg"
          >
            <p id={`${id}-ask`} className="text-base font-medium text-ink">
              How well did you know it?
            </p>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,calc(var(--ph-control-height-lg)*3.5)),1fr))] gap-2">
              {CONFIDENCE.map((word, i) => (
                <Button
                  key={word}
                  type="button"
                  variant="outline"
                  // Not disabled while saving: a disabled button would drop focus.
                  aria-disabled={rating || undefined}
                  onClick={() => void rate((i + 1) as Confidence)}
                  aria-keyshortcuts={String(i + 1)}
                  data-rate={i + 1}
                  className={cn("min-h-(--ph-control-height-lg) flex-col gap-0.5 py-1.5", i === 0 && "border-danger/50", i === 4 && "border-success-ink/50")}
                >
                  <span className="font-mono text-sm text-ink-secondary">
                    {i + 1}
                    <span className="sr-only">{": "}</span>
                  </span>
                  <span>{word}</span>
                </Button>
              ))}
            </div>
            <p className="text-sm text-ink-secondary">Cards you rate 1 or 2 come back later in this session.</p>
          </div>
        )}
      </div>
      <p role="status" className="sr-only" data-session-status="">
        {said}
      </p>
    </Frame>
  );
}

function Frame({
  title,
  onExit,
  headingRef,
  wide,
  children,
}: {
  title: string;
  onExit: () => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mx-auto flex w-full flex-col gap-4 px-6 py-5", wide ? "max-w-(--ph-thread-width)" : "max-w-(--ph-measure)")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 ref={headingRef} tabIndex={-1} className="min-w-0 text-xl font-semibold wrap-break-word text-ink" data-view-focus="">
          {title}
        </h2>
        <Button type="button" variant="ghost" size="sm" onClick={onExit} data-session-exit="">
          <Icon name="chevron-left" />
          End and go back
        </Button>
      </div>
      {children}
    </div>
  );
}

function Summary({
  title,
  ended,
  onExit,
  headingRef,
}: {
  title: string;
  ended: Ended;
  onExit: () => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const changes = ended.after
    .map((d) => ({ d, was: ended.before.find((b) => b.path === d.path)?.mastery }))
    .filter((x) => x.was !== undefined && Math.round(x.was * 100) !== Math.round(x.d.mastery * 100));
  return (
    <div className="mx-auto flex w-full max-w-(--ph-measure) flex-col gap-5 px-6 py-5" data-session-summary="">
      <div className="flex flex-col gap-1">
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-ink" data-view-focus="">
          Session done
        </h2>
        <p className="text-base text-ink-secondary">{title}</p>
      </div>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,calc(var(--ph-control-height)*6)),1fr))] gap-3">
        <Stat label="Cards studied" value={String(ended.studied)} />
        <Stat label="Time" value={durationText(ended.ms)} />
        <Stat label="To revisit" value={String(ended.revisit.length)} />
      </dl>
      {changes.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-md font-semibold text-ink">Mastery</h3>
          <ul className="flex flex-col gap-1 text-base text-ink" data-mastery-change="">
            {changes.map(({ d, was }) => (
              <li key={d.path} className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium">{d.title}:</span>
                <span>
                  {percent(was ?? 0)} <span aria-hidden="true">→</span>
                  <span className="sr-only">to</span> {percent(d.mastery)}
                </span>
                <span className="text-ink-secondary">({d.mastery >= (was ?? 0) ? "up" : "down"})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {ended.revisit.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-md font-semibold text-ink">Cards to revisit</h3>
          <p className="text-sm text-ink-secondary">You rated these 1 or 2. They’ll come back soon.</p>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-raised" data-revisit="">
            {ended.revisit.map((c) => (
              <li key={c.id} className="flex flex-col gap-0.5 px-3.5 py-2.5">
                <span className="text-base font-medium wrap-break-word text-ink">
                  <MathText text={spokenFront(c)} />
                </span>
                <span className="text-sm wrap-break-word text-ink-secondary">
                  <MathText text={c.kind === "cloze" ? clozeAnswer(c) : c.back} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-base text-ink">You knew every card well. {plural(ended.studied, "card")} done.</p>
      )}
      <div>
        <Button type="button" onClick={onExit} data-summary-done="">
          Back to Study
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-line bg-raised px-3.5 py-2.5">
      <dt className="text-sm text-ink-secondary">{label}</dt>
      <dd className="text-xl font-semibold text-ink">{value}</dd>
    </div>
  );
}
