import { motion } from "motion/react";
import { useState } from "react";
import { SurfaceError } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { type CourseRun, endText, type Run, stepText } from "../lib/import-run";
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

export function CourseProgress({ run, className, decorative = false }: { run: Run; className?: string; decorative?: boolean }) {
  const running = run.status === "running";
  const overall = run.courses.reduce((n, c) => n + fraction(c), 0) / Math.max(run.courses.length, 1);
  return (
    <span
      className={cn("block h-0.5 bg-muted", className)}
      aria-hidden={decorative || undefined}
      role={running && !decorative ? "progressbar" : undefined}
      aria-label={running && !decorative ? (run.update ? "Course update progress" : "Course import progress") : undefined}
      aria-valuenow={running && !decorative ? Math.floor(overall * 100) : undefined}
    >
      <span
        className={cn("block h-full transition-[width] duration-300 ease-out", run.status === "failed" ? "bg-error" : run.status === "running" ? "bg-primary" : "bg-success")}
        style={{ width: `${(running ? overall : 1) * 100}%` }}
      />
    </span>
  );
}

/** The running (or just finished) import or update: one row per course. */
export function ImportRun({ run, onSignInAgain }: { run: Run; onSignInAgain: () => void }) {
  const cancel = useCourses((s) => s.cancelImport);
  const dismiss = useCourses((s) => s.dismissRun);
  const running = run.status === "running";
  const finished = run.courses.filter((c) => c.result || c.failed).length;
  const verb = run.update ? "Updating" : "Importing";
  const progressTitle = run.school ? `${verb} from ${run.school}` : `${verb} courses…`;
  return (
    <div className="relative overflow-hidden rounded-card border bg-card" data-testid="import-run">
      <CourseProgress run={run} className="absolute inset-x-0 top-0" />
      <div className="flex h-12 items-center gap-2 px-5 pt-0.5">
        <div className="min-w-0 flex-1 text-sm">
          {running ? (
            <Truncate className="font-medium">{run.cancelling ? `Stopping the ${run.update ? "update" : "import"}…` : progressTitle}</Truncate>
          ) : (
            <Truncate className="font-medium">{run.signInConnection && !run.update ? "Signed out partway through" : endText(run)}</Truncate>
          )}
        </div>
        {running ? (
          <>
            <span className="shrink-0 text-muted-foreground text-xs type-live">
              {finished}/{run.courses.length}
            </span>
            <Button size="sm" variant="outline" onClick={() => void cancel()} disabled={run.cancelling} className="min-w-16">
              {run.cancelling ? <Spinner size="sm" /> : <Icon icon={icons.stop} />}
              {run.cancelling ? "Stopping…" : "Stop"}
            </Button>
          </>
        ) : (
          <Button size="icon-xs" variant="ghost-muted" aria-label="Dismiss" onClick={dismiss}>
            <Icon icon={icons.close} />
          </Button>
        )}
      </div>
      {run.cancelError ? <p className="px-5 pb-2 text-destructive-foreground text-xs">Couldn’t stop the {run.update ? "update" : "import"}: {run.cancelError}</p> : null}
      {run.status === "failed" && run.error ? (
        <div className="px-4 pb-4">
          {run.signInConnection ? (
            <SurfaceError tone="warning" title="Sign in again to finish" actions={[{ label: "Sign in again", primary: true, onClick: onSignInAgain }]} />
          ) : (
            <SurfaceError title={run.update ? "Some courses couldn’t be updated" : "The import stopped"} message={run.error} />
          )}
        </div>
      ) : null}
      <ul className="border-t py-1.5">
        {run.courses.map((c) => (
          <CourseRow key={c.id} c={c} update={run.update} />
        ))}
      </ul>
      {run.notes?.length ? (
        <div className="space-y-0.5 border-t px-5 py-2.5">
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

function CourseRow({ c, update }: { c: CourseRun; update?: boolean }) {
  const [open, setOpen] = useState(false);
  const active = !c.result && !c.failed && !!c.step;
  const counts = c.result ? [plural(c.result.files, "file"), c.result.readings ? plural(c.result.readings, "reading") : null, c.result.links ? plural(c.result.links, "link") : null].filter(Boolean).join(" · ") : null;
  return (
    <motion.li layout="position" className="flex min-h-9 flex-wrap items-center gap-x-3 px-5 py-1.5">
      <span className="flex size-4 shrink-0 items-center justify-center">
        {c.result ? (
          <motion.span initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 520, damping: 28 }}>
            <Icon icon={icons.done} className="size-4 text-success" />
          </motion.span>
        ) : c.failed ? (
          <Icon icon={icons.error} className={cn("size-4", c.failed === "Stopped" ? "text-muted-foreground" : "text-destructive")} />
        ) : active ? (
          <Spinner size="xs" tone="muted" />
        ) : (
          <Icon icon={icons.pending} className="size-4 text-subtle-foreground" />
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
            <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="text-warning-foreground underline-offset-2 hover:underline">
              · {plural(c.result.skipped.length, "item")} {update ? "skipped" : "not imported"}
            </button>
          ) : null}
        </span>
      ) : c.failed === "Stopped" ? (
        <span className="shrink-0 text-muted-foreground text-xs">Stopped</span>
      ) : !c.failed ? (
        <span className="shrink-0 text-muted-foreground text-xs">Waiting</span>
      ) : null}
      {open && c.result?.skipped.length ? (
        <motion.ul initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="basis-full space-y-0.5 overflow-hidden pt-1 pl-6.5">
          {c.result.skipped.map((n, i) => (
            <li key={i} className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
              {n}
            </li>
          ))}
        </motion.ul>
      ) : null}
    </motion.li>
  );
}
