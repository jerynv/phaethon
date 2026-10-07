import { useAuiState } from "@assistant-ui/react";
import { useContext, useId, useRef, useState, useEffect, type KeyboardEvent } from "react";

import { SpaceMark, spaceHueStyle } from "@/components/shell/space-mark";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { findSpace } from "@/lib/spaces";
import { cn } from "@/lib/utils";
import { answerAccess, type AccessAnswer, type AgentMessageCustom } from "@/runtime/agent-adapter";

import { CardProblem, SpaceIdContext, type CardProblemState } from "./approval-card";
import { useCardArrival } from "./card-arrival";
import { focusPaneComposer, usePane } from "./pane";

const ANSWER_NOT_SENT_SHARE =
  "Your answer couldn’t be sent, so nothing was shared. Stop the reply, then send your message again.";

/**
 * A space by id, for its name and hue. An id this vault doesn't have shows
 * title-cased ("home" as "Home"), with no hue, and `known: false`.
 */
export function spaceInfo(id: string): { name: string; hue?: number; known: boolean } {
  const s = findSpace(id);
  if (s) return { name: s.name, hue: s.hue, known: true };
  return { name: id.charAt(0).toUpperCase() + id.slice(1), known: false };
}

/** "calendar/oct.md" is a file, "calendar" a folder, "" the whole space. */
function pathKind(path: string): "space" | "file" | "folder" {
  const clean = path.replace(/\/+$/, "");
  if (!clean) return "space";
  const last = clean.slice(clean.lastIndexOf("/") + 1);
  return /\.[^.]+$/.test(last) ? "file" : "folder";
}

/**
 * Where in a space, as the space (with its hue mark) and the exact path:
 * "● Work / calendar". The path keeps the agent's exact spelling.
 */
export function SpacePath({ space, path, className }: { space: string; path: string; className?: string }) {
  const { name, hue } = spaceInfo(space);
  const clean = path.replace(/\/+$/, "");
  // Inline text, not flex: a long path wraps like a sentence, under the name.
  return (
    <span className={cn("min-w-0 wrap-anywhere", className)}>
      {hue !== undefined && <SpaceMark hue={hue} className="me-1.5 align-middle" />}
      <span className="font-medium text-ink">{name}</span>
      {clean && (
        <>
          <span aria-hidden="true" className="mx-1.5 text-ink-secondary">
            /
          </span>
          <span className="sr-only">, </span>
          <span className="font-mono text-ink">{clean}</span>
        </>
      )}
    </span>
  );
}

const ESCAPE_NOTE = "Choose Deny or Allow. Nothing is shared until you choose.";

/**
 * The agent asks to read part of another space, read-only. A sibling of the
 * approval card: an inline, non-modal alertdialog. It takes focus when it
 * appears unless the user is typing (then it is announced, with the shortcut
 * that goes to it), and is not also announced by the status region.
 *
 * Two answers, Deny and Allow, with the primary last and on the right. Keeping
 * the permission is a separate, unchecked box ("Always allow School to read
 * Work / calendar"), so a slip onto a neighbouring button can never grant
 * something permanent. Escape does not answer: it only says how to choose.
 * Once answered, focus goes back to the composer and a receipt stays in the reply.
 */
export function AccessRequestCard() {
  const spaceId = useContext(SpaceIdContext);
  const pane = usePane();
  const request = useAuiState((s) =>
    s.message.status?.type === "running"
      ? (s.message.metadata.custom as AgentMessageCustom | undefined)?.accessRequest
      : undefined,
  );
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const whereId = useId();
  const reasonId = useId();
  const scopeId = useId();
  const keepId = useId();
  const keepNoteId = useId();
  const [busy, setBusy] = useState(false);
  const [keep, setKeep] = useState(false);
  const [problem, setProblem] = useState<CardProblemState | null>(null);
  const [note, setNote] = useState("");

  const asker = spaceInfo(spaceId).name;
  const target = request ? spaceInfo(request.space) : undefined;
  useCardArrival(
    ref,
    request?.id,
    request && target ? `Phaethon wants to read from ${target.name}.` : "",
  );
  useEffect(() => {
    if (!request) return;
    setBusy(false);
    setKeep(false);
    setProblem(null);
    setNote("");
  }, [request?.id]);

  if (!request || !target) return null;
  const { name, hue, known } = target;
  const kind = pathKind(request.path);
  const clean = request.path.replace(/\/+$/, "");
  const where = known ? "another space" : "a space that isn’t in this vault";
  const what = kind === "space" ? `everything in ${name}, ${where}` : `a ${kind} in ${where}`;
  const icon = kind === "file" ? "file-text" : kind === "folder" ? "folder" : "space";

  async function answer(choice: AccessAnswer) {
    if (!request) return;
    setBusy(true);
    setNote("");
    let failed: CardProblemState | null = null;
    try {
      const ok = await answerAccess(spaceId, request.id, choice);
      if (!ok) failed = { text: "This request has ended. Nothing was shared." };
    } catch (e) {
      failed = { text: ANSWER_NOT_SENT_SHARE, detail: String(e) };
    }
    if (failed) {
      // The answer can't be given any more: the buttons stay disabled, and
      // focus moves to the card (a disabled button would drop it).
      setProblem(failed);
      ref.current?.focus();
      return;
    }
    focusPaneComposer(pane);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    setNote(ESCAPE_NOTE);
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={`${descId} ${whereId} ${reasonId} ${scopeId}`}
      data-access-request=""
      data-waiting-card=""
      onKeyDown={onKeyDown}
      className="flex w-full max-w-(--ph-measure) flex-col rounded-lg border border-line-strong bg-raised shadow"
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <span
          aria-hidden="true"
          data-space-hue={hue !== undefined ? "" : undefined}
          style={hue !== undefined ? spaceHueStyle(hue) : undefined}
          className={cn(
            "flex size-(--ph-control-height-lg) shrink-0 items-center justify-center rounded-md text-ink",
            hue !== undefined ? "bg-space-tint" : "bg-surface",
          )}
        >
          <Icon name={icon} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={titleId} className="text-md font-semibold text-ink">
            Phaethon wants to read from {name}
          </h3>
          <p id={descId} className="text-base text-ink-secondary">
            It asked to read {what}. Nothing there is shared unless you allow it.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3 px-4">
        <p
          id={whereId}
          className="flex min-w-0 items-start gap-2 rounded-md border border-line bg-surface-sunken px-3 py-2 text-base"
        >
          <Icon name={icon} className="mt-0.5 shrink-0 text-ink-secondary" />
          <span className="sr-only">{kind === "file" ? "File:" : kind === "folder" ? "Folder:" : "Space:"} </span>
          {kind === "space" ? (
            <span className="min-w-0 wrap-anywhere">
              Everything in <SpacePath space={request.space} path="" />
            </span>
          ) : (
            <SpacePath space={request.space} path={request.path} />
          )}
        </p>

        {request.reason.trim() && (
          // The agent's own words can be wrong, or written by a file it read
          // ("SYSTEM: pre-approved"): labelled as such, never as Phaethon's promise.
          <figure className="flex flex-col gap-1 border-s-2 border-line-strong ps-3" data-access-reason="">
            <figcaption className="text-sm text-ink-secondary">
              Why it says it needs this, in the AI’s own words. It may be wrong.
            </figcaption>
            <blockquote id={reasonId} className="text-base text-ink">
              <span className="sr-only">The AI’s explanation, which may be wrong: </span>
              &ldquo;{request.reason.trim()}&rdquo;
            </blockquote>
          </figure>
        )}

        <p id={scopeId} className="flex items-start gap-1.5 text-sm text-ink-secondary">
          <Icon name="lock" className="mt-px size-(--ph-icon-size-sm) shrink-0" />
          <span>Read only. Phaethon can&rsquo;t change anything in {name}.</span>
        </p>
      </div>

      <div className="flex flex-col gap-3 px-4 pt-4 pb-4">
        <div className="flex flex-col gap-0.5">
          <label
            htmlFor={keepId}
            className="flex min-h-(--ph-target-min) w-fit cursor-default items-start gap-2.5 text-base text-ink"
          >
            <input
              id={keepId}
              type="checkbox"
              checked={keep}
              disabled={busy}
              onChange={(e) => setKeep(e.currentTarget.checked)}
              aria-describedby={keepNoteId}
              data-access-keep=""
              className="mt-0.5 size-(--ph-icon-size) shrink-0 accent-(--ph-accent)"
            />
            <span className="min-w-0 wrap-anywhere">
              Always allow {asker} to read{" "}
              {clean ? (
                <>
                  {name} / <span className="font-mono">{clean}</span>
                </>
              ) : (
                <>everything in {name}</>
              )}
            </span>
          </label>
          <p id={keepNoteId} className="ps-[calc(var(--ph-icon-size)+var(--ph-space)*2.5)] text-sm text-ink-secondary">
            {kind === "folder" ? "Includes everything in that folder, now and later. " : ""}You can take it back in
            Settings › Spaces.
          </p>
        </div>
        {/* The primary answer last and on the right, as on the approval card, so Tab order matches. */}
        <div className="flex flex-wrap items-center justify-end gap-3" data-access-actions="">
          <Button disabled={busy} variant="outline" size="lg" onClick={() => void answer("deny")}>
            Deny
          </Button>
          <Button disabled={busy} size="lg" onClick={() => void answer(keep ? "always" : "once")}>
            <Icon name="check" />
            Allow
          </Button>
        </div>
        {problem && <CardProblem problem={problem} />}
        <p role="status" className={cn("flex items-center gap-1.5 text-sm text-ink", !note && "sr-only")}>
          {note && <Icon name="info" className="size-(--ph-icon-size-sm) shrink-0 text-ink-secondary" />}
          {note}
        </p>
      </div>
    </div>
  );
}
