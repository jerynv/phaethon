import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, XIcon } from "lucide-react";
import { SurfaceError } from "@/components/errors";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { type CourseRun, endText, type Run, SIGNED_OUT_DURING_IMPORT, stepText } from "../lib/import-run";
import { plural } from "../lib/sites";
import { useCourses } from "../store";

/** How far a course is, 0–1: steps weigh reading 10 %, files 60 %, readings 20 %, writing 10 %. */
function fraction(c: CourseRun): number {
  if (c.result || c.failed) return 1;
  if (!c.step) return 0;
  const at = c.total > 0 ? Math.min(c.done / c.total, 1) : 0;
  const base = { reading: 0, files: 0.1, readings: 0.7, writing: 0.9 }[c.step];
  const span = { reading: 0.1, files: 0.6, readings: 0.2, writing: 0.1 }[c.step];
  return base + span * at;
}

/** The running (or just finished) import: a 2 px bar on top, one row per course. */
export function ImportRun({ run, onSignInAgain }: { run: Run; onSignInAgain: () => void }) {
  const cancel = useCourses((s) => s.cancelImport);
  const dismiss = useCourses((s) => s.dismissRun);
  const running = run.status === "running";
  const finished = run.courses.filter((c) => c.result || c.failed).length;
  const overall = run.courses.reduce((n, c) => n + fraction(c), 0) / Math.max(run.courses.length, 1);

  return (
    <div className="relative overflow-hidden rounded-xl border bg-card">
      <div className="absolute inset-x-0 top-0 h-0.5 bg-muted">
        <div
          className={cn("h-full transition-[width] duration-300 ease-out", run.status === "failed" ? "bg-error" : run.status === "running" ? "bg-primary" : "bg-success")}
          style={{ width: `${(running ? overall : 1) * 100}%` }}
        />
      </div>
      <div className="flex h-11 items-center gap-2 px-3.5 pt-0.5">
        <div className="min-w-0 flex-1 text-sm">
          {running ? (
            <Truncate className="font-medium">{run.cancelling ? "Stopping the import…" : `Importing from ${run.school}`}</Truncate>
          ) : (
            <Truncate className="font-medium">{run.status === "failed" && run.error === SIGNED_OUT_DURING_IMPORT ? "Signed out partway through" : endText(run)}</Truncate>
          )}
        </div>
        {running ? (
          <>
            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
              {finished}/{run.courses.length}
            </span>
            <Button size="xs" variant="outline" onClick={() => void cancel()} disabled={run.cancelling} className="min-w-16">
              {run.cancelling ? <Spinner size="xs" /> : null}
              {run.cancelling ? "Stopping…" : "Stop"}
            </Button>
          </>
        ) : (
          <Button size="icon-xs" variant="ghost-muted" aria-label="Dismiss" onClick={dismiss}>
            <XIcon />
          </Button>
        )}
      </div>
      {run.cancelError ? <p className="px-3.5 pb-2 text-destructive-foreground text-xs">Couldn’t stop the import: {run.cancelError}</p> : null}
      {run.status === "failed" && run.error ? (
        <div className="px-3 pb-3">
          {run.error === SIGNED_OUT_DURING_IMPORT ? (
            <SurfaceError tone="warning" title="Sign in again to finish" message="What’s already here stays; only what changed is downloaded." actions={[{ label: "Sign in again", primary: true, onClick: onSignInAgain }]} />
          ) : (
            <SurfaceError title="The import stopped" message={run.error} />
          )}
        </div>
      ) : null}
      <ul className="border-t py-1">
        {run.courses.map((c) => (
          <CourseRow key={c.id} c={c} />
        ))}
      </ul>
      {run.notes?.length ? (
        <div className="space-y-0.5 border-t px-3.5 py-2">
          {run.notes.map((n, i) => (
            <p key={i} className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
              {n}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CourseRow({ c }: { c: CourseRun }) {
  const active = !c.result && !c.failed && !!c.step;
  const counts = c.result ? [plural(c.result.files, "file"), c.result.readings ? plural(c.result.readings, "reading") : null, c.result.links ? plural(c.result.links, "link") : null].filter(Boolean).join(" · ") : null;
  return (
    <li className="flex min-h-8 items-center gap-2.5 px-3.5 py-1.5">
      <span className="flex size-4 shrink-0 items-center justify-center">
        {c.result ? (
          <CircleCheckIcon className="size-3.5 text-success" strokeWidth={2} />
        ) : c.failed ? (
          <CircleAlertIcon className={cn("size-3.5", c.failed === "Stopped" ? "text-muted-foreground" : "text-error")} strokeWidth={2} />
        ) : active ? (
          <Spinner size="xs" tone="muted" />
        ) : (
          <CircleDashedIcon className="size-3.5 text-subtle-foreground" strokeWidth={2} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <Truncate className={cn("text-sm", !c.result && !active && !c.failed && "text-muted-foreground")}>{c.name}</Truncate>
        {c.failed && c.failed !== "Stopped" ? <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{c.failed}</p> : null}
      </div>
      {active ? (
        <>
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{stepText(c)}</span>
          <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${fraction(c) * 100}%` }} />
          </span>
        </>
      ) : counts ? (
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs tabular-nums">
          {counts}
          {c.result?.skipped.length ? (
            <Tooltip>
              <TooltipTrigger render={<span className="cursor-default text-warning-foreground" />}>· {plural(c.result.skipped.length, "part")} skipped</TooltipTrigger>
              <TooltipPopup className="max-w-72">{c.result.skipped.join("\n")}</TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      ) : c.failed === "Stopped" ? (
        <span className="shrink-0 text-muted-foreground text-xs">Stopped</span>
      ) : !c.failed ? (
        <span className="shrink-0 text-muted-foreground text-xs">Waiting</span>
      ) : null}
    </li>
  );
}
