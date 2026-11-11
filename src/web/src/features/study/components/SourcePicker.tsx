import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { cleanMessage, RowError } from "@/components/errors";
import { Truncate } from "@/components/truncate";
import { Checkbox } from "@/components/ui/checkbox";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { Skeleton } from "@/components/ui/skeleton";
import { courseAccessGet, lmsCourseContent } from "@/features/courses/api";
import type { CourseContentEntry } from "@/features/courses/lib/types";
import { cn } from "@/lib/utils";
import { partPath } from "../lib/kinds";
import type { CourseSource } from "../lib/types";
import { useLoad } from "../use-load";

type Part = "syllabus" | "assignments" | "files" | "readings";
const PARTS: { part: Part; label: string }[] = [
  { part: "syllabus", label: "Syllabus" },
  { part: "assignments", label: "Assignments" },
  { part: "files", label: "Course files" },
  { part: "readings", label: "Readings" },
];

/**
 * What to make cards or questions from: each course the space sees, its
 * parts (syllabus, assignments, files, readings), and the course's files one
 * by one when "Course files" is opened. `chosen` holds the paths study_make_*
 * takes.
 */
export function SourcePicker({ space, sources, chosen, onChange }: { space: string; sources: CourseSource[]; chosen: Set<string>; onChange: (next: Set<string>) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => (sources.length === 1 ? { [sources[0]!.folder]: true } : {}));
  const access = useLoad(() => courseAccessGet(space), [space]);
  const keyOf = (folder: string) => access.data?.courses.find((c) => c.folder === folder)?.key;

  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border">
      {sources.map((c) => {
        const parts = PARTS.filter((p) => c[p.part]);
        const paths = parts.map((p) => partPath(c.folder, p.part));
        const all = paths.length > 0 && paths.every((p) => chosen.has(p));
        const some = [...chosen].some((p) => p.startsWith(`${c.folder}/`));
        const expanded = !!open[c.folder];
        const toggleAll = () => {
          const next = new Set([...chosen].filter((p) => !p.startsWith(`${c.folder}/`)));
          if (!all) for (const p of paths) next.add(p);
          onChange(next);
        };
        return (
          <div key={c.folder} className="border-b last:border-b-0">
            <div className="flex h-8 items-center gap-2 px-2">
              <button
                type="button"
                aria-label={expanded ? "Hide parts" : "Show parts"}
                aria-expanded={expanded}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setOpen((o) => ({ ...o, [c.folder]: !expanded }))}
              >
                <ChevronRightIcon className={cn("size-3.5 transition-transform", expanded && "rotate-90")} strokeWidth={2} />
              </button>
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                <Checkbox checked={all} indeterminate={some && !all} onCheckedChange={toggleAll} disabled={!paths.length} />
                <Truncate className="min-w-0 flex-1 text-sm">{c.name}</Truncate>
              </label>
              {!paths.length ? <span className="shrink-0 text-2xs text-muted-foreground">Nothing to read</span> : null}
            </div>
            {expanded && paths.length ? (
              <div className="flex flex-col pb-1">
                {parts.map((p) =>
                  p.part === "files" ? (
                    <FilesPart key={p.part} space={space} folder={c.folder} courseKey={keyOf(c.folder)} chosen={chosen} onChange={onChange} />
                  ) : (
                    <PartRow key={p.part} label={p.label} checked={chosen.has(partPath(c.folder, p.part))} onToggle={() => onChange(toggle(chosen, partPath(c.folder, p.part)))} />
                  ),
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function toggle(set: Set<string>, path: string): Set<string> {
  const next = new Set(set);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

function PartRow({ label, checked, indeterminate, onToggle, trailing, depth = 1 }: { label: React.ReactNode; checked: boolean; indeterminate?: boolean; onToggle: () => void; trailing?: React.ReactNode; depth?: 1 | 2 }) {
  return (
    <div className={cn("flex h-7 items-center gap-2 pr-2", depth === 1 ? "pl-9" : "pl-16")}>
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
        <Checkbox checked={checked} indeterminate={indeterminate} onCheckedChange={onToggle} />
        {typeof label === "string" ? <span className="truncate">{label}</span> : label}
      </label>
      {trailing}
    </div>
  );
}

/** "Course files": all of them, or opened to pick files one by one (names cut in the middle, keeping the extension). */
function FilesPart({ space, folder, courseKey, chosen, onChange }: { space: string; folder: string; courseKey?: string; chosen: Set<string>; onChange: (s: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  const whole = partPath(folder, "files");
  const content = useLoad<CourseContentEntry[] | null>(() => (open && courseKey ? lmsCourseContent(space, courseKey).then((c) => c.entries.filter((e) => e.kind === "file")) : Promise.resolve(null)), [open, courseKey, space]);
  const files = content.data ?? [];
  const picked = files.filter((f) => chosen.has(f.path)).length;
  const checked = chosen.has(whole);
  const toggleWhole = () => {
    const next = new Set([...chosen].filter((p) => !p.startsWith(`${whole}/`)));
    if (checked) next.delete(whole);
    else next.add(whole);
    onChange(next);
  };
  const toggleFile = (path: string) => {
    const next = new Set(chosen);
    if (checked) {
      next.delete(whole);
      for (const f of files) if (f.path !== path) next.add(f.path);
    } else if (next.has(path)) next.delete(path);
    else next.add(path);
    // Every file picked one by one is the whole folder again.
    if (files.length && files.every((f) => next.has(f.path))) {
      for (const f of files) next.delete(f.path);
      next.add(whole);
    }
    onChange(next);
  };
  return (
    <>
      <PartRow
        label="Course files"
        checked={checked}
        indeterminate={!checked && picked > 0}
        onToggle={toggleWhole}
        trailing={
          courseKey ? (
            <button type="button" className="flex shrink-0 items-center gap-0.5 text-2xs text-muted-foreground tabular-nums hover:text-foreground" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {picked && !checked ? `${picked} chosen` : open ? "Hide files" : "Choose files"}
              <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} strokeWidth={2} />
            </button>
          ) : null
        }
      />
      {open ? (
        content.error ? (
          <div className="flex h-7 items-center pr-2 pl-16">
            <RowError message={`Couldn’t list the files: ${cleanMessage(content.error)}`} onRetry={content.reload} />
          </div>
        ) : content.loading && !content.data ? (
          <div className="flex flex-col motion-safe:animate-skeleton" aria-hidden>
            {["52%", "38%", "61%"].map((w) => (
              <div key={w} className="flex h-7 items-center gap-2 pl-16">
                <Skeleton className="size-3.5 animate-none rounded-[3px]" />
                <Skeleton className="h-2.5 animate-none" style={{ width: w }} />
              </div>
            ))}
          </div>
        ) : files.length ? (
          files.map((f) => (
            <PartRow
              key={f.path}
              depth={2}
              label={<MiddleTruncate value={f.path.slice(whole.length + 1) || f.title} className="min-w-0 flex-1 text-muted-foreground" />}
              checked={checked || chosen.has(f.path)}
              onToggle={() => toggleFile(f.path)}
            />
          ))
        ) : (
          <div className="flex h-7 items-center pl-16 text-muted-foreground text-xs">No files in this course.</div>
        )
      ) : null}
    </>
  );
}
