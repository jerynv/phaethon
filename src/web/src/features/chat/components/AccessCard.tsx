import { FileTextIcon, FolderIcon, LayersIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import type { AccessAnswer } from "#shared/agent.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useSpace } from "../context";
import type { PendingAccess } from "../lib/timeline";
import { CardProblem, KeyHint, cardActions, cardKeys, cardShell, useCardArrival } from "./cards";
import { SpacePath } from "./Records";

/** "calendar/oct.md" is a file, "calendar" a folder, "" the whole space. */
function pathKind(path: string): "space" | "file" | "folder" {
  const clean = path.replace(/\/+$/, "");
  if (!clean) return "space";
  return /\.[^./]+$/.test(clean.slice(clean.lastIndexOf("/") + 1)) ? "file" : "folder";
}

/**
 * The assistant asks to read part of another space, read-only. Two answers,
 * Don't allow and Allow; keeping the permission is a separate, unticked box,
 * so a slip onto a button never grants something permanent.
 */
export function AccessCard({
  request,
  asker,
  onAnswer,
  announce,
}: {
  request: PendingAccess;
  asker: string;
  onAnswer: (id: string, answer: AccessAnswer) => Promise<string | null>;
  announce: (t: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const keepId = useId();
  const target = useSpace(request.space);
  const from = useSpace(asker);
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useCardArrival(ref, request.id, announce, `Phaethon wants to read from ${target.name}.`);

  const kind = pathKind(request.path);
  const Icon = kind === "file" ? FileTextIcon : kind === "folder" ? FolderIcon : LayersIcon;
  const clean = request.path.replace(/\/+$/, "");

  const answer = async (choice: AccessAnswer) => {
    if (busy) return;
    setBusy(true);
    const failed = await onAnswer(request.id, choice);
    if (failed) {
      setProblem(failed);
      ref.current?.focus();
    }
  };

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onKeyDown={cardKeys(() => void answer(keep ? "always" : "once"), () => void answer("deny"), busy || !!problem)}
      className={cardShell}
      data-access-card=""
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4.5" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={titleId} className="text-base font-semibold leading-snug">
            Phaethon wants to read from {target.name}
          </h3>
          <p id={descId} className="text-sm text-muted-foreground">
            {target.known ? null : `${target.name} isn’t in your Phaethon folder.`}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <p className="flex min-w-0 items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          <span className="sr-only">{kind === "file" ? "File:" : kind === "folder" ? "Folder:" : "Space:"} </span>
          {kind === "space" ? (
            <span>
              Everything in <SpacePath space={request.space} path="" />
            </span>
          ) : (
            <SpacePath space={request.space} path={request.path} />
          )}
        </p>
        {request.reason.trim() && (
          <div className="text-sm">
            <p className="font-medium">Why it asked</p>
            <p className="text-muted-foreground">{request.reason}</p>
          </div>
        )}
        <label htmlFor={keepId} className="flex cursor-pointer items-start gap-2.5 text-sm">
          <Checkbox id={keepId} checked={keep} onCheckedChange={(v) => setKeep(Boolean(v))} className="mt-0.5" />
          <span>
            Always let {from.name} read {clean ? <span className="font-mono text-[0.8125rem]">{target.name}/{clean}</span> : `all of ${target.name}`}
            <span className="block text-muted-foreground">You can take it back in Settings › Coding agents.</span>
          </span>
        </label>
      </div>
      <div className={cardActions}>
        {problem && <CardProblem text={problem} />}
        <Button variant="outline" size="lg" disabled={busy} aria-keyshortcuts="Control+Backspace Meta+Backspace" onClick={() => void answer("deny")}>
          Don’t allow
          <KeyHint keyName="⌫" />
        </Button>
        <Button size="lg" disabled={busy} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={() => void answer(keep ? "always" : "once")}>
          {keep ? "Allow from now on" : "Allow for this reply"}
          <KeyHint keyName="↵" />
        </Button>
      </div>
    </div>
  );
}
