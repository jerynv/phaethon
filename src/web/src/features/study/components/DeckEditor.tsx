import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { useNav } from "@/app/store";
import { cleanMessage, FieldError, SurfaceError } from "@/components/errors";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";
import { studyDeck, studyDeckSave } from "../api";
import type { DeckView } from "../lib/types";
import { isCloze, plural } from "../lib/words";
import type { StudyScreen } from "../StudyView";
import { useLoad } from "../use-load";
import { ConfirmDelete } from "./ConfirmDelete";
import { Crumbs } from "./parts";

type Row = { key: number; front: string; back: string; source?: string };

/**
 * A deck's name and cards, edited as text (math as `$…$`, a cloze blank as
 * `{{answer}}`, which needs no back). Cards keep their progress when their
 * front stays the same.
 */
export function DeckEditor({ space, path, onBack, open }: { space: SpaceView; path: string | null; onBack: () => void; open: (s: StudyScreen) => void }) {
  const deck = useLoad<DeckView | null>(() => (path ? studyDeck(space.id, path) : Promise.resolve(null)), [space.id, path]);
  const skeleton = useDelayed(deck.loading && !deck.data && !!path);
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ title?: string; rows?: Record<number, string>; save?: string }>({});
  const [remove, setRemove] = useState(false);
  const [savedPath, setSavedPath] = useState(path);
  const next = useRef(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (ready || deck.loading) return;
    if (path && !deck.data) return;
    setReady(true);
    const d = deck.data;
    setTitle(d?.title ?? "");
    setRows(d?.cards.length ? d.cards.map((c) => ({ key: next.current++, front: c.front, back: c.back, source: c.source })) : [{ key: next.current++, front: "", back: "" }]);
  }, [deck.data, deck.loading, path, ready]);

  const edit = (key: number, part: "front" | "back", value: string) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [part]: value } : r)));
    setDirty(true);
    if (errors.rows?.[key]) setErrors((e) => ({ ...e, rows: { ...e.rows, [key]: "" } }));
  };
  const add = () => {
    const key = next.current++;
    setRows((rs) => [...rs, { key, front: "", back: "" }]);
    setDirty(true);
    requestAnimationFrame(() => document.getElementById(`card-front-${key}`)?.focus());
  };

  const save = async () => {
    const kept = rows.filter((r) => r.front.trim() || r.back.trim());
    const rowErrors: Record<number, string> = {};
    for (const r of kept) {
      if (!r.front.trim()) rowErrors[r.key] = "Write the front.";
      else if (!r.back.trim() && !isCloze(r.front)) rowErrors[r.key] = "Write the back, or make a blank in the front with {{answer}}.";
    }
    const errs = { title: title.trim() ? undefined : "Give the deck a name.", rows: rowErrors };
    setErrors(errs);
    if (errs.title || Object.keys(rowErrors).length) return;
    setSaving(true);
    try {
      const p = await studyDeckSave(space.id, savedPath, title.trim(), kept.map((r) => ({ front: r.front, back: r.back, ...(r.source ? { source: r.source } : {}) })));
      setSavedPath(p);
      setRows(kept.length ? kept : [{ key: next.current++, front: "", back: "" }]);
      setDirty(false);
      toast.success(`Saved ${title.trim()}`, plural(kept.length, "card"));
    } catch (e) {
      setErrors((x) => ({ ...x, save: cleanMessage(e) }));
    } finally {
      setSaving(false);
    }
  };

  const filled = rows.filter((r) => r.front.trim()).length;

  return (
    <>
      <Header
        title={<Crumbs onBack={onBack}>{title.trim() || (path ? deck.data?.title : null) || "New deck"}</Crumbs>}
        actions={
          <>
            {savedPath ? (
              <Tooltip>
                <TooltipTrigger render={<Button size="icon-xs" variant="ghost-destructive" aria-label="Delete deck" onClick={() => setRemove(true)} />}>
                  <Trash2Icon />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Delete deck</TooltipPopup>
              </Tooltip>
            ) : null}
            {savedPath && !dirty ? (
              <Button size="xs" variant="outline" onClick={() => open({ kind: "review", paths: [savedPath], title: title.trim() })}>
                Review
              </Button>
            ) : null}
            <Button size="xs" disabled={saving || (!dirty && !!savedPath)} onClick={() => void save()}>
              {saving ? <Spinner size="xs" /> : null}
              {saving ? "Saving…" : dirty || !savedPath ? "Save" : "Saved"}
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
          {deck.error ? <SurfaceError title="Couldn’t open the deck" message={cleanMessage(deck.error)} onRetry={deck.reload} /> : null}
          {errors.save ? <SurfaceError title="Couldn’t save the deck" message={errors.save} onRetry={() => void save()} /> : null}
          {skeleton ? <EditorSkeleton /> : null}
          {ready ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Input
                  aria-label="Deck name"
                  placeholder="Deck name"
                  className="font-medium text-lg"
                  value={title}
                  maxLength={120}
                  autoFocus={!path}
                  aria-invalid={errors.title ? true : undefined}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setDirty(true);
                    setErrors((x) => ({ ...x, title: undefined }));
                  }}
                />
                <FieldError>{errors.title}</FieldError>
                {deck.data?.course || deck.data?.sources.length ? <SourceLine course={deck.data.course} sources={deck.data.sources} space={space.id} /> : null}
              </div>
              <div className="flex flex-col gap-2">
                <div className="grid grid-cols-[1.5rem_1fr_1fr_1.75rem] gap-2 px-0.5 text-2xs text-muted-foreground">
                  <span />
                  <span>Front</span>
                  <span>Back</span>
                  <span />
                </div>
                {rows.map((r, i) => (
                  <div key={r.key} className="flex flex-col gap-1">
                    <div className="group grid grid-cols-[1.5rem_1fr_1fr_1.75rem] items-start gap-2">
                      <span className="pt-2 text-right text-muted-foreground text-xs tabular-nums">{i + 1}</span>
                      <Textarea
                        id={`card-front-${r.key}`}
                        rows={2}
                        className="text-sm"
                        placeholder={i === 0 ? "Question, or a sentence with a {{blank}}" : ""}
                        value={r.front}
                        aria-invalid={errors.rows?.[r.key] && !r.front.trim() ? true : undefined}
                        onChange={(e) => edit(r.key, "front", e.target.value)}
                      />
                      <Textarea
                        rows={2}
                        className={cn("text-sm", isCloze(r.front) && !r.back && "opacity-70")}
                        placeholder={isCloze(r.front) ? "Not needed for a blank" : i === 0 ? "Answer" : ""}
                        value={r.back}
                        aria-invalid={errors.rows?.[r.key] && r.front.trim() && !r.back.trim() ? true : undefined}
                        onChange={(e) => edit(r.key, "back", e.target.value)}
                        onKeyDown={(e) => e.key === "Tab" && !e.shiftKey && i === rows.length - 1 && r.front.trim() && (e.preventDefault(), add())}
                      />
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Remove card ${i + 1}`}
                        className="mt-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => {
                          setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : [{ key: next.current++, front: "", back: "" }]));
                          setDirty(true);
                        }}
                      >
                        <XIcon />
                      </Button>
                    </div>
                    {errors.rows?.[r.key] ? <FieldError className="pl-8">{errors.rows[r.key]}</FieldError> : null}
                  </div>
                ))}
                <div className="flex items-center gap-3 pl-8">
                  <Button size="xs" variant="outline" onClick={add}>
                    <PlusIcon />
                    Add card
                  </Button>
                  <span className="text-muted-foreground text-xs tabular-nums">{plural(filled, "card")}</span>
                  <span className="ml-auto hidden text-subtle-foreground text-xs sm:block">Math as $x^2$; a blank as {"{{answer}}"}</span>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
      <ConfirmDelete
        space={space.id}
        item={remove && savedPath ? { path: savedPath, title: title.trim() || "this deck", kind: "deck" } : null}
        onClose={() => setRemove(false)}
        onDeleted={onBack}
      />
    </>
  );
}

function SourceLine({ course, sources, space }: { course?: string; sources: string[]; space: string }) {
  const openFile = useNav((s) => s.openFile);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-0.5 text-muted-foreground text-xs">
      {course ? <span className="max-w-64 truncate">{course}</span> : null}
      {sources.length ? (
        <>
          {course ? <span className="text-subtle-foreground">·</span> : null}
          <span>From</span>
          {sources.slice(0, 4).map((s) => (
            <button key={s} type="button" className="inline-flex max-w-52 items-center rounded-md border bg-muted/60 px-1.5 leading-5 hover:text-foreground" onClick={() => openFile(space, s)}>
              <MiddleTruncate value={s.split("/").pop() || s} />
            </button>
          ))}
          {sources.length > 4 ? <span className="tabular-nums">+{sources.length - 4}</span> : null}
        </>
      ) : null}
    </div>
  );
}

function EditorSkeleton() {
  return (
    <div className="flex flex-col gap-5 motion-safe:animate-skeleton" aria-hidden>
      <Skeleton className="h-8 w-full animate-none rounded-lg" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="grid grid-cols-[1.5rem_1fr_1fr_1.75rem] gap-2">
          <span />
          <Skeleton className="h-14 animate-none rounded-lg" />
          <Skeleton className="h-14 animate-none rounded-lg" />
          <span />
        </div>
      ))}
    </div>
  );
}
