import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";

import { announce } from "@/components/shell/announcer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "@/icons";
import { studyDeck, studyDeckSave, studyDelete, type Card } from "@/lib/study";
import { cn } from "@/lib/utils";
import { openSpaceFile } from "@/runtime/records";

import { CardText } from "./card-text";
import { baseName, confidenceWord, dayText, plainError, plural, spokenFront } from "./words";

type Deck = Awaited<ReturnType<typeof studyDeck>>;
/** The card being edited: an existing one by id, or a new one ("new"). */
type Editing = { id: string; front: string; back: string } | null;

/**
 * One deck: its cards (searchable), each with how well you know it, and
 * inline editing: add, edit, delete. The whole deck is saved on each change
 * (study_deck_save validates it). Sources open in their own app.
 */
export function DeckEditor({
  space,
  path,
  onBack,
  onStudy,
  onDeleted,
}: {
  space: string;
  path: string;
  onBack: () => void;
  onStudy: (path: string, title: string) => void;
  onDeleted: (title: string) => void;
}) {
  const id = useId();
  const [deck, setDeck] = useState<Deck | null>(null);
  const [error, setError] = useState("");
  const [problem, setProblem] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [askDeleteDeck, setAskDeleteDeck] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focusNext = useRef<string | null>(null);

  const load = useCallback(
    () =>
      studyDeck(space, path).then(
        (d) => {
          setDeck(d);
          setError("");
        },
        (e: unknown) => setError(plainError(e)),
      ),
    [space, path],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useLayoutEffect(() => {
    if (deck || error) headingRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!deck || !!error]);

  // After a save, delete or cancel, focus goes to what makes sense (a selector in the list, or the heading).
  useLayoutEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    const el = want === "heading" ? headingRef.current : document.querySelector<HTMLElement>(want);
    (el ?? headingRef.current)?.focus();
  });

  const save = async (cards: { front: string; back: string }[], said: string, focus: string) => {
    if (!deck) return false;
    setSaving(true);
    setProblem("");
    try {
      await studyDeckSave(space, deck.path, deck.title, cards);
      await load();
      announce(said);
      focusNext.current = focus;
      return true;
    } catch (e) {
      setProblem(plainError(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <Shell onBack={onBack}>
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-ink" data-view-focus="">
          {baseName(path)}
        </h2>
        <div role="alert" className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3 py-2.5 text-base text-ink">
          <Icon name="error" className="mt-0.5 shrink-0 text-danger-ink" />
          <p>This deck couldn’t be opened. {error}</p>
        </div>
      </Shell>
    );
  }
  if (!deck) {
    return (
      <Shell onBack={onBack}>
        <p role="status" className="flex items-center gap-2 text-md text-ink-secondary">
          <Icon name="spinner" className="animate-spin" />
          Opening the deck…
        </p>
      </Shell>
    );
  }

  const q = query.trim().toLowerCase();
  const shown = deck.cards.filter((c) => !q || c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q));
  const plain = deck.cards.map((c) => ({ front: c.front, back: c.back }));

  async function submitEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing || !deck) return;
    const front = editing.front.trim();
    const back = editing.back.trim();
    const cloze = /\{\{.+?\}\}/.test(front);
    if (!front || (!back && !cloze)) {
      setProblem(!front ? "A card needs a question on its front." : "A card needs an answer on its back (or a {{blank}} in its front).");
      document.getElementById(`${id}-${!front ? "front" : "back"}`)?.focus();
      return;
    }
    const isNew = editing.id === "new";
    const cards = isNew ? [{ front, back }, ...plain] : deck.cards.map((c) => (c.id === editing.id ? { front, back } : { front: c.front, back: c.back }));
    const ok = await save(cards, isNew ? "Card added." : "Card saved.", isNew ? "[data-add-card]" : `[data-card-row] [data-edit-card="${CSS.escape(editing.id)}"]`);
    if (ok) {
      // An edited front gets a new id: focus its row's Edit by position instead.
      if (!isNew) {
        const index = deck.cards.findIndex((c) => c.id === editing.id);
        focusNext.current = `[data-card-row]:nth-child(${index + 1}) [data-edit-card]`;
      }
      setEditing(null);
    }
  }

  async function remove(card: Card) {
    if (!deck) return;
    const index = shown.findIndex((c) => c.id === card.id);
    const ok = await save(
      deck.cards.filter((c) => c.id !== card.id).map((c) => ({ front: c.front, back: c.back })),
      "Card deleted.",
      // The row that takes its place, or the one before, or the search.
      `[data-card-row]:nth-child(${Math.max(1, Math.min(index + 1, shown.length - 1))}) [data-edit-card]`,
    );
    if (ok) setConfirming(null);
  }

  async function deleteDeck() {
    if (!deck) return;
    try {
      await studyDelete(space, deck.path);
      onDeleted(deck.title);
    } catch (e) {
      setProblem(plainError(e));
    }
  }

  const editor = (card: { id: string }) =>
    editing && editing.id === card.id ? (
      <form onSubmit={submitEdit} className="flex flex-col gap-2 px-3.5 py-3" data-card-editor={card.id}>
        <label htmlFor={`${id}-front`} className="text-sm font-medium text-ink">
          Front
        </label>
        <Textarea
          id={`${id}-front`}
          autoFocus
          value={editing.front}
          onChange={(e) => setEditing({ ...editing, front: e.target.value })}
          aria-describedby={`${id}-front-hint`}
          data-edit-front=""
        />
        <p id={`${id}-front-hint`} className="text-sm text-ink-secondary">
          For a fill-in-the-blank card, put the missing words in double braces: {"The {{chromatic number}} is 2."}
        </p>
        <label htmlFor={`${id}-back`} className="text-sm font-medium text-ink">
          Back
        </label>
        <Textarea id={`${id}-back`} value={editing.back} onChange={(e) => setEditing({ ...editing, back: e.target.value })} data-edit-back="" />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              focusNext.current = editing.id === "new" ? "[data-add-card]" : `[data-edit-card="${CSS.escape(editing.id)}"]`;
              setEditing(null);
              setProblem("");
            }}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving} data-save-card="">
            {saving && <Icon name="spinner" className="animate-spin" />}
            {editing.id === "new" ? "Add card" : "Save card"}
          </Button>
        </div>
      </form>
    ) : null;

  return (
    <Shell onBack={onBack}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold wrap-break-word text-ink" data-view-focus="" data-deck-title="">
            {deck.title}
          </h2>
          <p className="text-sm text-ink-secondary">
            {plural(deck.cards.length, "card")}
            {deck.course ? ` · ${deck.course}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => onStudy(deck.path, deck.title)} disabled={deck.cards.length === 0} data-study-deck="">
            <Icon name="play" />
            Study this deck
          </Button>
          <Button type="button" variant="outline" onClick={() => setAskDeleteDeck(true)} data-delete-deck="">
            <Icon name="remove" />
            Delete deck…
          </Button>
        </div>
      </div>

      {askDeleteDeck && (
        <div role="alertdialog" aria-labelledby={`${id}-del-deck`} className="flex flex-col gap-2 rounded-lg border border-line bg-surface-sunken px-3.5 py-3 forced-colors:border-[CanvasText]" data-delete-deck-confirm="">
          <p id={`${id}-del-deck`} className="text-base text-ink">
            Delete “{deck.title}” and what you’ve learned in it? Its file in the space is removed too. This can’t be undone.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" autoFocus onClick={() => {
              setAskDeleteDeck(false);
              focusNext.current = "[data-delete-deck]";
            }}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={() => void deleteDeck()} data-delete-deck-yes="">
              Delete deck
            </Button>
          </div>
        </div>
      )}

      {deck.sources.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-secondary">
          <span>Made from</span>
          <ul className="contents">
            {deck.sources.map((s) => (
              <li key={s}>
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  title={s}
                  onClick={() => openSpaceFile(space, s).catch((e: unknown) => setProblem(plainError(e)))}
                  data-source-link={s}
                >
                  <Icon name="file-text" />
                  {baseName(s)}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {problem && (
        <div role="alert" className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3 py-2 text-base text-ink" data-deck-problem="">
          <Icon name="error" className="mt-0.5 shrink-0 text-danger-ink" />
          <p className="min-w-0 flex-1 wrap-break-word">{problem}</p>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={`${id}-search`} className="text-sm font-medium text-ink">
            Search cards
          </label>
          <Input
            id={`${id}-search`}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-describedby={`${id}-count`}
            data-card-search=""
          />
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={!!editing}
          onClick={() => {
            setProblem("");
            setEditing({ id: "new", front: "", back: "" });
          }}
          data-add-card=""
        >
          <Icon name="plus" />
          Add a card
        </Button>
      </div>
      <p id={`${id}-count`} role="status" className="text-sm text-ink-secondary" data-card-count="">
        {q ? `${plural(shown.length, "card")} match “${query.trim()}”.` : ""}
      </p>

      {editing?.id === "new" && <div className="rounded-lg border border-line bg-raised">{editor({ id: "new" })}</div>}

      {shown.length === 0 ? (
        <p className="text-base text-ink-secondary">{q ? "No cards match. Try other words." : "This deck has no cards yet. Add one."}</p>
      ) : (
        <ul ref={listRef} aria-label="Cards" className="flex flex-col divide-y divide-line rounded-lg border border-line bg-raised">
          {shown.map((c) => (
            <li key={c.id} data-card-row={c.id} className="flex flex-col">
              {editor(c) ?? (
                <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-3.5 py-3">
                  <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
                    <p className="text-base font-medium wrap-break-word text-ink">
                      <span className="sr-only">{spokenFront(c)}</span>
                      <span aria-hidden="true">
                        <CardText text={c.front} />
                      </span>
                    </p>
                    <p className="text-base wrap-break-word text-ink-secondary">{c.kind === "cloze" ? <CardText text={c.front} reveal /> : c.back}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Mastery card={c} />
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={!!editing}
                        aria-label={`Edit “${spokenFront(c)}”`}
                        onClick={() => {
                          setProblem("");
                          setEditing({ id: c.id, front: c.front, back: c.back });
                        }}
                        data-edit-card={c.id}
                      >
                        <Icon name="edit" />
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={!!editing}
                        aria-label={`Delete “${spokenFront(c)}”`}
                        onClick={() => {
                          setConfirming(c.id);
                          focusNext.current = `[data-delete-cancel="${CSS.escape(c.id)}"]`;
                        }}
                        data-delete-card={c.id}
                      >
                        <Icon name="remove" />
                        Delete
                      </Button>
                    </div>
                  </div>
                  {confirming === c.id && (
                    <div role="group" aria-label="Delete this card?" className="flex w-full flex-wrap items-center justify-end gap-2" data-delete-card-confirm="">
                      <span className="text-sm text-ink">Delete this card and what you’ve learned on it?</span>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => {
                          setConfirming(null);
                          focusNext.current = `[data-delete-card="${CSS.escape(c.id)}"]`;
                        }}
                        data-delete-cancel={c.id}
                      >
                        Keep it
                      </Button>
                      <Button type="button" variant="destructive" size="xs" disabled={saving} onClick={() => void remove(c)} data-delete-yes={c.id}>
                        Delete card
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

/** How well you know a card: five dots, and the same in words (never the dots alone). */
function Mastery({ card }: { card: Card }) {
  const n = card.confidence ?? 0;
  const words = n ? `Knew it: ${confidenceWord(n)}` : "Not studied yet";
  const due = card.due ? `Due ${dayText(card.due)}` : "";
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-2 text-sm text-ink-secondary" data-card-mastery={n}>
      <span aria-hidden="true" className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={cn(
              "size-(--ph-space-mark-size) rounded-full border border-ink-secondary forced-colors:border-[CanvasText]",
              i <= n && "bg-ink-secondary forced-colors:bg-[CanvasText]",
            )}
          />
        ))}
      </span>
      <span>
        {words}
        {due && <span>{` · ${due}`}</span>}
      </span>
    </div>
  );
}

function Shell({ onBack, children }: { onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-(--ph-thread-width) flex-col gap-4 px-6 py-5">
      <div>
        <Button type="button" variant="ghost" size="sm" className="-ms-2" onClick={onBack} data-back-to-study="">
          <Icon name="chevron-left" />
          Back to Study
        </Button>
      </div>
      {children}
    </div>
  );
}
