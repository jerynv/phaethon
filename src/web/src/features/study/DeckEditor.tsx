/**
 * A deck: its cards with the passages they came from and how well each is
 * known, search, add, edit and delete. Saving sends the whole deck with each
 * card's source, so an edited card keeps where it came from; a card whose
 * question changes starts over (the core keys progress by the question).
 */
import { EllipsisIcon, FileTextIcon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { useNav } from "@/app/nav";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Textarea } from "@/components/ui/textarea";
import { errorText } from "@/lib/core";

import { announce } from "../courses/shared/announce";
import { EduPage, EmptyState, ErrorState, LiveText, LoadingRows, PageHeader } from "../courses/shared/kit";
import { studyDeck, studyDeckSave, studyDelete } from "./api";
import { CardText, MathText } from "./CardText";
import { SourceLine } from "./Grounding";
import type { Card, CardInput, DeckView } from "./lib/types";
import { baseName, cardCites, clozeAnswer, confidenceWord, dayText, isCloze, plural } from "./lib/words";

const toInput = (c: Card): CardInput => ({ front: c.front, back: c.back, ...(c.source ? { source: c.source } : {}) });

export function DeckEditor({ space, path, onBack, onReview }: { space: string; path: string; onBack: () => void; onReview: (path: string, title: string) => void }) {
  const [deck, setDeck] = useState<DeckView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleteDeck, setDeleteDeck] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const openFile = useNav((s) => s.openFile);
  const listRef = useRef<HTMLUListElement>(null);
  const searchId = useId();

  const load = useCallback(() => {
    setError(null);
    return studyDeck(space, path).then(
      (d) => setDeck(d),
      (e) => setError(errorText(e)),
    );
  }, [space, path]);
  useEffect(() => void load(), [load]);

  const shown = useMemo(() => {
    if (!deck) return [];
    const q = query.trim().toLowerCase();
    return q ? deck.cards.filter((c) => `${c.front}\n${c.back}`.toLowerCase().includes(q)) : deck.cards;
  }, [deck, query]);

  const save = async (cards: CardInput[], said: string, focusAt: number) => {
    if (!deck) return false;
    setProblem(null);
    try {
      await studyDeckSave(space, deck.path, deck.title, cards);
      await load();
      setEditing(null);
      setConfirming(null);
      announce(said);
      requestAnimationFrame(() => {
        const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-card-row]");
        const row = rows?.[Math.min(focusAt, (rows?.length ?? 1) - 1)];
        row?.focus();
      });
      return true;
    } catch (e) {
      setProblem(errorText(e));
      return false;
    }
  };

  if (error)
    return (
      <EduPage>
        <PageHeader title={baseName(path)} back={{ label: "Study", onClick: onBack }} focusKey="error" />
        <ErrorState title="This deck couldn’t be opened." message={error} onRetry={() => void load()} />
      </EduPage>
    );

  return (
    <EduPage>
      <PageHeader
        back={{ label: "Study", onClick: onBack }}
        title={deck?.title ?? baseName(path)}
        focusKey={deck ? "ready" : undefined}
        meta={deck ? [plural(deck.cards.length, "card"), deck.course].filter(Boolean).join(" · ") : "Opening the deck…"}
        actions={
          deck && (
            <>
              <Button disabled={!deck.cards.length} onClick={() => onReview(deck.path, deck.title)}>
                Review this deck
              </Button>
              <Menu>
                <MenuTrigger render={<Button variant="outline" size="icon" aria-label="More for this deck" />}>
                  <EllipsisIcon aria-hidden />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem variant="destructive" onClick={() => setDeleteDeck(true)}>
                    <Trash2Icon aria-hidden />
                    Delete deck…
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </>
          )
        }
      />

      {!deck ? (
        <LoadingRows rows={5} label="Opening the deck" />
      ) : (
        <>
          {deck.sources.length > 0 && (
            <div className="-mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span>Made from</span>
              {deck.sources.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => openFile(s, space)}
                >
                  <FileTextIcon aria-hidden className="size-3.5 text-muted-foreground" />
                  {baseName(s)}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="max-w-sm flex-1 basis-56">
              <InputGroupAddon>
                <SearchIcon aria-hidden />
              </InputGroupAddon>
              <InputGroupInput id={searchId} type="search" aria-label="Search cards" placeholder="Search cards" value={query} onChange={(e) => setQuery(e.target.value)} />
            </InputGroup>
            <Button variant="outline" disabled={editing !== null} onClick={() => setEditing("new")} data-add-card="">
              <PlusIcon aria-hidden />
              Add card
            </Button>
          </div>
          <LiveText>{query.trim() ? `${plural(shown.length, "card")} match “${query.trim()}”.` : ""}</LiveText>

          {editing === "new" && (
            <CardForm
              heading="New card"
              onCancel={() => setEditing(null)}
              problem={problem}
              onSave={(c) => save([c, ...deck.cards.map(toInput)], "Card added.", 0)}
            />
          )}

          {shown.length === 0 && editing !== "new" ? (
            query.trim() ? (
              <EmptyState title="No cards match" description="Try other words.">
                <Button variant="outline" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              </EmptyState>
            ) : (
              <EmptyState title="This deck has no cards yet">
                <Button onClick={() => setEditing("new")}>Add a card</Button>
              </EmptyState>
            )
          ) : (
            <ul ref={listRef} aria-label="Cards" className="flex flex-col gap-3">
              {shown.map((c) => {
                const index = deck.cards.indexOf(c);
                return editing === c.id ? (
                  <li key={c.id}>
                    <CardForm
                      heading={`Edit card ${index + 1}`}
                      initial={c}
                      problem={problem}
                      onCancel={() => setEditing(null)}
                      onSave={(next) => save(deck.cards.map((x) => (x.id === c.id ? { ...next, ...(c.source ? { source: c.source } : {}) } : toInput(x))), "Card saved.", shown.indexOf(c))}
                    />
                  </li>
                ) : (
                  <CardRow
                    key={c.id}
                    card={c}
                    n={index + 1}
                    space={space}
                    busy={editing !== null}
                    confirming={confirming === c.id}
                    onEdit={() => {
                      setProblem(null);
                      setEditing(c.id);
                    }}
                    onDelete={() => setConfirming(c.id)}
                    onCancelDelete={() => setConfirming(null)}
                    onConfirmDelete={() => save(deck.cards.filter((x) => x.id !== c.id).map(toInput), "Card deleted.", shown.indexOf(c))}
                  />
                );
              })}
            </ul>
          )}
        </>
      )}

      <AlertDialog open={deleteDeck} onOpenChange={setDeleteDeck}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deck?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>Its {plural(deck?.cards.length ?? 0, "card")} and your progress on them go too.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" autoFocus />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={async () => {
                try {
                  await studyDelete(space, path);
                  announce(`Deleted “${deck?.title}”.`);
                  setDeleteDeck(false);
                  onBack();
                } catch (e) {
                  setProblem(errorText(e));
                  setDeleteDeck(false);
                }
              }}
            >
              Delete deck
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </EduPage>
  );
}

function Mastery({ card }: { card: Card }) {
  const c = card.confidence;
  return (
    <span className="flex items-center gap-2 text-sm text-muted-foreground">
      <span aria-hidden className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={`size-1.5 rounded-full ${c && i <= c ? "bg-success forced-colors:bg-[CanvasText]" : "bg-muted-foreground/25"}`} />
        ))}
      </span>
      {c ? `Knew it: ${confidenceWord(c)}` : "Not studied yet"}
      {c && card.due ? ` · Due ${dayText(card.due)}` : ""}
    </span>
  );
}

function CardRow({
  card,
  n,
  space,
  busy,
  confirming,
  onEdit,
  onDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  card: Card;
  n: number;
  space: string;
  busy: boolean;
  confirming: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  return (
    <li tabIndex={-1} data-card-row={card.id} className="group flex flex-col gap-3 rounded-xl border bg-card px-4 py-3.5 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 w-6 shrink-0 text-sm text-muted-foreground tabular-nums" aria-hidden>
          {n}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="text-[0.9375rem] leading-relaxed font-medium text-foreground">
            <CardText text={card.front} reveal />
          </div>
          {!isCloze(card.front) || card.back ? (
            <div className="text-[0.9375rem] leading-relaxed text-muted-foreground">
              <MathText text={card.back || clozeAnswer(card)} />
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-0.5">
          <Button size="icon-sm" variant="ghost" aria-label={`Edit card ${n}`} disabled={busy} onClick={onEdit}>
            <PencilIcon aria-hidden />
          </Button>
          <Button size="icon-sm" variant="ghost-destructive" aria-label={`Delete card ${n}`} disabled={busy} onClick={onDelete}>
            <Trash2Icon aria-hidden />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 ps-9">
        <SourceLine cites={cardCites(card)} space={space} />
        <Mastery card={card} />
      </div>
      {confirming && (
        <div role="alertdialog" aria-label={`Delete card ${n}?`} className="ms-9 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-error-surface px-3 py-2 text-sm">
          <span className="me-auto text-foreground">Delete this card and its progress?</span>
          <Button size="sm" variant="outline" autoFocus onClick={onCancelDelete}>
            Keep it
          </Button>
          <Button size="sm" variant="destructive" onClick={onConfirmDelete}>
            Delete card
          </Button>
        </div>
      )}
    </li>
  );
}

function CardForm({
  heading,
  initial,
  problem,
  onSave,
  onCancel,
}: {
  heading: string;
  initial?: Card;
  problem: string | null;
  onSave: (c: CardInput) => Promise<boolean>;
  onCancel: () => void;
}) {
  const id = useId();
  const [front, setFront] = useState(initial?.front ?? "");
  const [back, setBack] = useState(initial?.back ?? "");
  const [invalid, setInvalid] = useState<"front" | "back" | null>(null);
  const [saving, setSaving] = useState(false);
  const frontRef = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLTextAreaElement>(null);
  const changedQuestion = !!initial && initial.front.trim() !== front.trim() && (initial.confidence != null || !!initial.quote);
  const cloze = isCloze(front);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!front.trim()) {
      setInvalid("front");
      frontRef.current?.focus();
      return;
    }
    if (!back.trim() && !cloze) {
      setInvalid("back");
      backRef.current?.focus();
      return;
    }
    setInvalid(null);
    setSaving(true);
    await onSave({ front: front.trim(), back: back.trim() });
    setSaving(false);
  };

  return (
    <form onSubmit={submit} aria-labelledby={`${id}-h`} className="flex flex-col gap-4 rounded-xl border border-primary/40 bg-card p-4 sm:p-5" data-card-form="">
      <h3 id={`${id}-h`} className="text-sm font-semibold text-foreground">
        {heading}
      </h3>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-front`}>Front</Label>
        <Textarea
          ref={frontRef}
          id={`${id}-front`}
          autoFocus
          rows={2}
          value={front}
          aria-invalid={invalid === "front" || undefined}
          aria-describedby={`${id}-front-hint${invalid === "front" ? ` ${id}-front-err` : ""}`}
          onChange={(e) => setFront(e.target.value)}
        />
        <p id={`${id}-front-hint`} className="text-sm text-muted-foreground">
          Put a blank in double braces, like {"{{bijection}}"}, to make a fill-in card. Math goes between $ signs.
        </p>
        {invalid === "front" && (
          <p id={`${id}-front-err`} className="text-sm text-destructive-foreground">
            Write the question or the sentence with a blank.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-back`}>Back{cloze && <span className="font-normal text-muted-foreground"> (optional for a fill-in card)</span>}</Label>
        <Textarea
          ref={backRef}
          id={`${id}-back`}
          rows={2}
          value={back}
          aria-invalid={invalid === "back" || undefined}
          aria-describedby={invalid === "back" ? `${id}-back-err` : undefined}
          onChange={(e) => setBack(e.target.value)}
        />
        {invalid === "back" && (
          <p id={`${id}-back-err`} className="text-sm text-destructive-foreground">
            Write the answer.
          </p>
        )}
      </div>
      {changedQuestion && <p className="text-sm text-warning-foreground">Changing the front starts this card over: its ratings and quoted passage don’t carry to a new question.</p>}
      {problem && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {initial ? "Save card" : "Add card"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
