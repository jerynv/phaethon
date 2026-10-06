import { useAuiState, type DataMessagePartComponent } from "@assistant-ui/react";
import { useContext, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { SpaceMark, spaceHueStyle } from "@/components/shell/space-mark";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { STUB_SPACES } from "@/lib/spaces";
import { cn } from "@/lib/utils";
import {
  answerAccess,
  type AccessAnswer,
  type AccessReceipt,
  type AgentMessageCustom,
} from "@/runtime/agent-adapter";

import { SpaceIdContext, focusComposer } from "./approval-card";

/** A space by id, for its name and hue. An unknown id shows as itself, with no hue. */
export function spaceInfo(id: string): { name: string; hue?: number } {
  const s = STUB_SPACES.find((x) => x.id === id);
  return s ? { name: s.name, hue: s.hue } : { name: id };
}

/** "calendar/oct.md" is a file, "calendar" a folder, "" the whole space. */
function pathKind(path: string): "space" | "file" | "folder" {
  const clean = path.replace(/\/+$/, "");
  if (!clean) return "space";
  const last = clean.slice(clean.lastIndexOf("/") + 1);
  return /\.[^.]+$/.test(last) ? "file" : "folder";
}

/**
 * Where in the other space, as the space (with its hue mark) and the exact
 * path: "● Work / calendar". The path keeps the agent's exact spelling.
 */
function SpacePath({ space, path, className }: { space: string; path: string; className?: string }) {
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

const ESCAPE_NOTE = "Choose Allow once, Always allow or Deny. Nothing is shared until you choose.";

/**
 * The agent asks to read part of another space, read-only. A sibling of the
 * approval card: an inline, non-modal alertdialog that takes focus when it
 * appears and is not also announced by the status region. Its job differs (a
 * permission over another compartment, not a change to a file), so it leads
 * with that space's hue and ends in three explicit choices.
 *
 * Keyboard: Tab moves through Allow once, Always allow and Deny, in the order
 * they are shown. Escape does not answer: leaving a permission prompt is never
 * a silent "no", so it only says how to choose. Once answered, focus goes back
 * to the composer and the card becomes a receipt in the reply.
 */
export function AccessRequestCard() {
  const spaceId = useContext(SpaceIdContext);
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
  const onceHintId = useId();
  const alwaysHintId = useId();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!request) return;
    setBusy(false);
    setProblem("");
    setNote("");
    ref.current?.focus();
  }, [request?.id]);

  if (!request) return null;
  const { name, hue } = spaceInfo(request.space);
  const kind = pathKind(request.path);
  const what = kind === "space" ? "everything in another space" : `a ${kind} in another space`;

  async function answer(choice: AccessAnswer) {
    if (!request) return;
    setBusy(true);
    setNote("");
    try {
      const ok = await answerAccess(spaceId, request.id, choice);
      if (!ok) {
        setProblem("This request is no longer waiting for an answer.");
        setBusy(false);
        return;
      }
    } catch (e) {
      setProblem(String(e));
      setBusy(false);
      return;
    }
    focusComposer();
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
      onKeyDown={onKeyDown}
      className="flex w-full max-w-(--st-measure) flex-col rounded-lg border border-line-strong bg-raised shadow"
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <span
          aria-hidden="true"
          data-space-hue={hue !== undefined ? "" : undefined}
          style={hue !== undefined ? spaceHueStyle(hue) : undefined}
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md text-ink",
            hue !== undefined ? "bg-space-tint" : "bg-surface",
          )}
        >
          <Icon name={kind === "file" ? "file-text" : "folder"} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={titleId} className="text-md font-semibold text-ink">
            steward wants to read from {name}
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
          <Icon name={kind === "file" ? "file-text" : "folder"} className="mt-0.5 shrink-0 text-ink-secondary" />
          <span className="sr-only">{kind === "file" ? "File:" : kind === "folder" ? "Folder:" : "Space:"} </span>
          <SpacePath space={request.space} path={request.path} />
        </p>

        {request.reason.trim() && (
          <figure className="flex flex-col gap-1 border-s-2 border-line-strong ps-3">
            <blockquote id={reasonId} className="text-base text-ink">
              <span className="sr-only">steward&rsquo;s reason: </span>
              &ldquo;{request.reason.trim()}&rdquo;
            </blockquote>
            <figcaption aria-hidden="true" className="text-sm text-ink-secondary">
              steward&rsquo;s reason, in its words
            </figcaption>
          </figure>
        )}

        <p id={scopeId} className="flex items-start gap-1.5 text-sm text-ink-secondary">
          <Icon name="lock" className="mt-px size-(--st-icon-size-sm) shrink-0" />
          <span>
            Read only. steward can&rsquo;t change anything in {name}.
          </span>
        </p>
      </div>

      <div className="flex flex-col gap-2 px-4 pt-4 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy} size="sm" aria-describedby={onceHintId} onClick={() => void answer("once")}>
            <Icon name="check" className="size-(--st-icon-size-sm)" />
            Allow once
          </Button>
          <Button
            disabled={busy}
            variant="outline"
            size="sm"
            aria-describedby={alwaysHintId}
            onClick={() => void answer("always")}
          >
            Always allow
          </Button>
          <Button disabled={busy} variant="ghost" size="sm" onClick={() => void answer("deny")}>
            Deny
          </Button>
        </div>
        <p className="text-sm text-ink-secondary">
          <span id={onceHintId}>Allow once lasts for this reply only.</span>{" "}
          <span id={alwaysHintId}>Always allow is saved; you can revoke it in Settings &gt; Spaces.</span>
        </p>
        {problem && (
          <p role="alert" className="flex items-center gap-1.5 text-sm text-danger-ink">
            <Icon name="warning" className="size-(--st-icon-size-sm) shrink-0" />
            {problem}
          </p>
        )}
        <p role="status" className={cn("flex items-center gap-1.5 text-sm text-ink", !note && "sr-only")}>
          {note && <Icon name="info" className="size-(--st-icon-size-sm) shrink-0 text-ink-secondary" />}
          {note}
        </p>
      </div>
    </div>
  );
}

const RECEIPT: Record<AccessAnswer, { verb: string; icon: "check" | "close" }> = {
  once: { verb: "Allowed once", icon: "check" },
  always: { verb: "Always allowed", icon: "check" },
  deny: { verb: "Not allowed", icon: "close" },
};

/** The receipt's words, also spoken by the status region. */
export function receiptText(r: AccessReceipt): string {
  const { name } = spaceInfo(r.space);
  const clean = r.path.replace(/\/+$/, "");
  return `${RECEIPT[r.answer].verb}: ${clean ? `${name} / ${clean}` : `all of ${name}`}`;
}

/**
 * What the user answered, left in the reply where the request was:
 * "Allowed once: ● Work / calendar". A quiet line, not a card.
 */
export const AccessReceiptLine: DataMessagePartComponent<AccessReceipt> = (props) => {
  const data: AccessReceipt = props.data;
  const r = RECEIPT[data.answer];
  return (
    <p
      data-access-receipt={data.answer}
      className="my-3 flex w-fit max-w-full items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1 text-sm text-ink-secondary first:mt-0"
    >
      <Icon
        name={r.icon}
        className={cn(
          "size-(--st-icon-size-sm) shrink-0",
          data.answer === "deny" ? "text-ink-secondary" : "text-success-ink",
        )}
      />
      <span className="shrink-0">{r.verb}:</span>
      {data.path.replace(/\/+$/, "") ? (
        <SpacePath space={data.space} path={data.path} />
      ) : (
        <span>
          all of <SpacePath space={data.space} path="" />
        </span>
      )}
      {data.answer === "always" && <span className="sr-only">. You can revoke it in Settings, Spaces.</span>}
    </p>
  );
};
