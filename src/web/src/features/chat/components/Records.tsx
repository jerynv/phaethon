import {
  CheckIcon,
  CircleHelpIcon,
  FileTextIcon,
  FolderIcon,
  RouteIcon,
  SearchIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { UiRecord } from "#shared/agent.ts";
import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fileOpen } from "../api";
import { hueColor, useSpace, useSpaceId } from "../context";
import { accessVerb } from "../lib/timeline";
import { confidenceWords } from "./Confidence";
import { Mermaid } from "./Mermaid";

/** A space with its colour mark and an exact path: "● Work / calendar". */
export function SpacePath({ space, path }: { space: string; path: string }) {
  const { name, hue } = useSpace(space);
  const clean = path.replace(/\/+$/, "");
  return (
    <span className="min-w-0 wrap-anywhere">
      <span aria-hidden className="me-1.5 inline-block size-2 rounded-full align-middle" style={{ background: hueColor(hue) }} />
      <span className="font-medium text-foreground">{name}</span>
      {clean && (
        <>
          <span aria-hidden className="mx-1 text-muted-foreground">
            /
          </span>
          <span className="sr-only">, </span>
          <span className="font-mono text-[0.8125rem] text-foreground">{clean}</span>
        </>
      )}
    </span>
  );
}

function Receipt({ icon, ok, children, kind }: { icon: ReactNode; ok?: boolean; children: ReactNode; kind: string }) {
  return (
    <p
      className="ph-block flex w-fit max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md border bg-muted/40 px-2.5 py-1 text-sm text-muted-foreground"
      data-record={kind}
    >
      <span aria-hidden className={cn("shrink-0 [&_svg]:size-3.5", ok ? "text-success" : "text-muted-foreground")}>
        {icon}
      </span>
      {children}
    </p>
  );
}

function WrittenFile({ path }: { path: string }) {
  const space = useSpaceId();
  const openFile = useNav((s) => s.openFile);
  return (
    <>
      <Button variant="link" size="xs" className="h-auto min-h-6 px-0 font-mono text-[0.8125rem] text-foreground underline" onClick={() => openFile(path, space)}>
        {path}
        <span className="sr-only">, view</span>
      </Button>
      <Button variant="ghost-muted" size="xs" className="min-h-6" onClick={() => void fileOpen(space, path, true).catch(() => {})}>
        <FolderIcon aria-hidden />
        Show in folder
        <span className="sr-only">: {path}</span>
      </Button>
    </>
  );
}

function LessonPlanCard({ record }: { record: Extract<UiRecord, { kind: "lessonPlan" }> }) {
  return (
    <section aria-label="Lesson plan" className="ph-block flex flex-col gap-3 rounded-xl border bg-card p-4" data-record="lessonPlan">
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <RouteIcon className="size-4.5" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Lesson plan</p>
          <p className="font-semibold leading-snug">{record.goal}</p>
        </div>
      </div>
      {record.map.trim() && <Mermaid code={record.map} streaming={false} label="Map of what comes before what. The steps are listed below it." />}
      {record.nodes.length > 0 && (
        <div>
          <p className="mb-1 text-sm font-medium">The steps, in order</p>
          <ol className="flex list-decimal flex-col gap-0.5 ps-5 text-sm marker:text-muted-foreground">
            {record.nodes.map((n) => (
              <li key={n.id}>{n.label}</li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function CheckReceipt({ record }: { record: Extract<UiRecord, { kind: "check" }> }) {
  const outcome = !record.answered ? "Not answered" : record.correct === true ? "Right" : record.correct === false ? "Not right" : "Answered";
  const Icon = !record.answered ? CircleHelpIcon : record.correct === true ? CheckIcon : record.correct === false ? XIcon : CheckIcon;
  return (
    <div className="ph-block flex items-start gap-2.5 rounded-lg border bg-muted/30 px-3 py-2 text-sm" data-record="check">
      <Icon
        aria-hidden
        className={cn("mt-0.5 size-4 shrink-0", record.correct === true ? "text-success" : record.correct === false ? "text-destructive" : "text-muted-foreground")}
      />
      <div className="min-w-0">
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">{outcome}</span>
          {record.confidence !== undefined && ` · you were ${record.confidence}% sure (${confidenceWords(record.confidence).toLowerCase()})`}
        </p>
        <p className="text-foreground">{record.question}</p>
      </div>
    </div>
  );
}

/** A record that stays in a reply: an answer you gave, a read in another space, a stop, a lesson step. */
export function RecordLine({ record }: { record: Exclude<UiRecord, { kind: "tool" }> }) {
  switch (record.kind) {
    case "approval":
      return (
        <Receipt kind="approval" ok={record.allowed} icon={record.allowed ? <CheckIcon /> : <XIcon />}>
          <span>
            {record.allowed ? "Allowed" : "Not allowed"}: {record.action}
          </span>
          {record.allowed ? <WrittenFile path={record.path} /> : <span className="font-mono text-[0.8125rem] text-foreground wrap-anywhere">{record.path}</span>}
        </Receipt>
      );
    case "access":
      return (
        <Receipt kind="access" ok={record.answer !== "deny"} icon={record.answer === "deny" ? <XIcon /> : <CheckIcon />}>
          <span>{accessVerb[record.answer]}:</span>
          {record.path.replace(/\/+$/, "") ? (
            <SpacePath space={record.space} path={record.path} />
          ) : (
            <span>
              all of <SpacePath space={record.space} path="" />
            </span>
          )}
        </Receipt>
      );
    case "read": {
      const verb = record.tool === "search" ? "Searched" : record.tool === "list" ? "Listed" : "Read";
      const Icon = record.tool === "search" ? SearchIcon : record.tool === "list" ? FolderIcon : FileTextIcon;
      return (
        <Receipt kind="read" icon={<Icon />}>
          <span>{verb}</span>
          <SpacePath space={record.space} path={record.path} />
          {record.tool === "search" && record.query && <span className="wrap-anywhere">for “{record.query}”</span>}
        </Receipt>
      );
    }
    case "stopped":
      return (
        <p className="ph-block flex items-center gap-1.5 text-sm text-muted-foreground" data-record="stopped">
          <SquareIcon aria-hidden className="size-3 fill-current" />
          Reply stopped
        </p>
      );
    case "lessonPlan":
      return <LessonPlanCard record={record} />;
    case "check":
      return <CheckReceipt record={record} />;
  }
}
