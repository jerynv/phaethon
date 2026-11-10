/** The import running now (or just finished): one row per course with its step and progress, then what came in. */
import { CheckCircle2Icon, CircleDashedIcon, CircleXIcon, LoaderIcon, CircleStopIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useImportRun } from "./import-store";
import { endText, stepText, type CourseRun } from "./lib/import-run";
import { plural } from "./lib/sites";
import { Progress } from "./shared/kit";

export function ImportProgress({ spaceNames }: { spaceNames: (id: string) => string }) {
  const run = useImportRun((s) => s.run);
  const { cancel, clear } = useImportRun.getState();
  if (!run) return null;
  const finished = run.courses.filter((c) => c.result || c.failed).length;
  const running = run.status === "running";
  return (
    <section aria-labelledby="import-h" className="flex flex-col gap-4 rounded-2xl border bg-card p-5 sm:p-6" data-import-run={run.status} aria-busy={running}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="import-h" className="text-base font-semibold">
            {running ? "Importing courses" : run.status === "cancelled" ? "Import stopped" : run.status === "failed" ? "The import stopped" : "Import finished"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {running ? `${finished} of ${plural(run.courses.length, "course")} · ${run.school}` : endText(run).replace(/\.$/, "")} · seen by {run.spaces.map(spaceNames).join(", ")}
          </p>
        </div>
        {running ? (
          <Button size="sm" variant="outline" disabled={run.cancelling} onClick={() => void cancel()}>
            <CircleStopIcon aria-hidden />
            {run.cancelling ? "Stopping…" : "Stop import"}
          </Button>
        ) : (
          <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={clear}>
            <XIcon aria-hidden />
          </Button>
        )}
      </div>
      {run.cancelError && <p className="text-sm text-warning-foreground">{run.cancelError}</p>}
      {run.status === "failed" && run.error && <p className="text-sm text-destructive-foreground">{run.error}</p>}
      <ul className="flex flex-col gap-3">
        {run.courses.map((c) => (
          <CourseRow key={c.id} c={c} />
        ))}
      </ul>
      {run.notes?.map((n, i) => (
        <p key={i} className="text-sm text-muted-foreground">
          {n}
        </p>
      ))}
    </section>
  );
}

function CourseRow({ c }: { c: CourseRun }) {
  const icon = c.result ? (
    <CheckCircle2Icon aria-hidden className="size-4.5 text-success-foreground" />
  ) : c.failed ? (
    <CircleXIcon aria-hidden className="size-4.5 text-destructive-foreground" />
  ) : c.step ? (
    <LoaderIcon aria-hidden className="size-4.5 text-primary motion-safe:animate-spin" />
  ) : (
    <CircleDashedIcon aria-hidden className="size-4.5 text-muted-foreground" />
  );
  return (
    <li className="flex gap-3" data-import-course={c.id}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="text-sm font-medium text-foreground">{c.name}</span>
          <span className={cn("text-sm", c.failed ? "text-destructive-foreground" : "text-muted-foreground")}>{c.result ? "Imported" : c.failed ?? stepText(c)}</span>
        </div>
        {c.step && <Progress value={c.total > 1 ? c.done / c.total : null} label={`Importing ${c.name}`} valueText={stepText(c)} />}
        {c.result && (
          <p className="text-sm text-muted-foreground">
            {plural(c.result.files, "file")}, {plural(c.result.readings, "reading")}, {plural(c.result.links, "link")} to web pages
            {c.result.material?.flagged.length ? ` · ${plural(c.result.material.flagged.length, "file")} read from handwriting or scans` : ""}
          </p>
        )}
        {c.result?.skipped.map((s, i) => (
          <p key={i} className="text-sm text-warning-foreground">
            {s}
          </p>
        ))}
      </div>
    </li>
  );
}
