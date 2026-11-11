import { BookOpenIcon, CheckIcon, ClipboardListIcon, FileTextIcon, LayersIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useNav } from "@/app/store";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { SkeletonRows } from "@/components/skeletons";
import { Truncate } from "@/components/truncate";
import { Input } from "@/components/ui/input";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { Toggle, ToggleGroup } from "@/components/ui/toggle-group";
import { FileIcon } from "@/features/viewer/FileIcon";
import { useDelayed } from "@/hooks/use-delayed";
import { lmsCourseContent } from "../api";
import { formatBytes, plural, whenText } from "../lib/sites";
import { COURSE_PARTS, type CourseContent, type CourseContentEntry, type CourseInfo } from "../lib/types";
import { partsOf, useCourses } from "../store";

const SECTIONS: { kind: CourseContentEntry["kind"][]; label: string; icon: ReactNode }[] = [
  { kind: ["overview", "page"], label: "Pages", icon: <BookOpenIcon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} /> },
  { kind: ["module"], label: "Modules", icon: <LayersIcon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} /> },
  { kind: ["assignment"], label: "Assignments", icon: <ClipboardListIcon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} /> },
  { kind: ["file"], label: "Files", icon: null },
];

/** The parts a space may see of one course, as compact toggles. */
export function PartToggles({ space, course }: { space: string; course: string }) {
  const parts = useCourses((s) => partsOf(s.access.data, space, course));
  const setParts = useCourses((s) => s.setParts);
  return (
    <ToggleGroup
      multiple
      variant="outline"
      size="xs"
      value={parts}
      onValueChange={(v) => void setParts(space, course, COURSE_PARTS.map((p) => p.part).filter((p) => (v as string[]).includes(p)))}
      className="flex-wrap gap-1.5"
      aria-label="Parts this space can see"
    >
      {COURSE_PARTS.map((p) => (
        <Toggle key={p.part} value={p.part} className="group/part h-6 gap-1 rounded-md px-2 font-normal text-muted-foreground text-xs data-pressed:border-primary/40 data-pressed:bg-primary/8 data-pressed:text-foreground dark:data-pressed:bg-primary/16">
          <CheckIcon className="hidden size-3 text-primary group-data-pressed/part:block" strokeWidth={2.5} />
          {p.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/** One course: what this space sees of it, and its content to open in the viewer. */
export function CourseDetail({ space, course }: { space: string; course: CourseInfo }) {
  const parts = useCourses((s) => partsOf(s.access.data, space, course.key));
  const openFile = useNav((s) => s.openFile);
  const viewing = useNav((s) => s.viewer);
  const [content, setContent] = useState<CourseContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState("");
  const partsKey = parts.join(",");
  const showSkeleton = useDelayed(!content && !error && parts.length > 0);

  useEffect(() => {
    if (!partsKey) return;
    let live = true;
    setError(null);
    const t = setTimeout(() => {
      lmsCourseContent(space, course.key).then(
        (c) => live && setContent(c),
        (e) => live && setError(cleanMessage(e)),
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [space, course.key, partsKey, tick]);

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = content?.entries ?? [];
    return q ? all.filter((e) => e.title.toLowerCase().includes(q) || e.path.toLowerCase().includes(q)) : all;
  }, [content, query]);

  const meta = [course.code, course.term, content?.updated ? `Updated ${whenText(content.updated)}` : null].filter(Boolean).join(" · ");

  return (
    <div className="mx-auto flex w-full max-w-(--chat-max-width) flex-col gap-6 px-4 py-6">
      <div className="min-w-0 space-y-0.5">
        <h2 className="min-w-0 font-semibold text-lg tracking-[-0.01em]">
          <Truncate>{course.name}</Truncate>
        </h2>
        {meta ? <p className="truncate text-muted-foreground text-xs">{meta}</p> : null}
      </div>

      <section className="space-y-2">
        <h3 className="font-medium text-2xs text-muted-foreground">This space can see</h3>
        <PartToggles space={space} course={course.key} />
      </section>

      <section className="space-y-2">
        <div className="flex h-7 items-center gap-2">
          <h3 className="flex-1 font-medium text-2xs text-muted-foreground">
            Content{content && parts.length ? <span className="ml-1.5 tabular-nums">{content.entries.length}</span> : null}
          </h3>
          {content && content.entries.length > 12 && parts.length ? (
            <div className="relative w-48">
              <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2 size-3.5 text-muted-foreground" strokeWidth={2} />
              <Input size="compact" value={query} placeholder="Filter" className="*:data-[slot=input]:ps-7" onChange={(e) => setQuery(e.target.value)} />
            </div>
          ) : null}
        </div>

        {parts.length === 0 ? (
          <div className="rounded-xl border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">This space can’t see this course. Turn on a part above to browse it here.</div>
        ) : error ? (
          <SurfaceError title="Couldn’t load this course" message={error} onRetry={() => setTick((n) => n + 1)} />
        ) : !content ? (
          showSkeleton ? (
            <div className="rounded-xl border p-1">
              <SkeletonRows count={6} withIcon />
            </div>
          ) : null
        ) : content.entries.length === 0 ? (
          <div className="rounded-xl border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">Nothing was imported for the parts this space can see.</div>
        ) : entries.length === 0 ? (
          <p className="px-1 py-3 text-muted-foreground text-sm">Nothing matches “{query.trim()}”.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {SECTIONS.map((s) => {
              const list = entries.filter((e) => s.kind.includes(e.kind));
              if (!list.length) return null;
              return (
                <div key={s.label} className="space-y-1">
                  <p className="px-1 text-2xs text-muted-foreground">
                    {s.label} <span className="tabular-nums">{list.length}</span>
                  </p>
                  <div className="flex flex-col gap-0.5 rounded-xl border p-1">
                    {list.map((e, i) => {
                      const selected = viewing?.space === space && viewing.path === e.path && (e.kind === "file" || e.kind === "overview" || e.kind === "page");
                      return (
                        <button
                          key={`${e.path}#${e.anchor ?? ""}#${i}`}
                          type="button"
                          onClick={() => openFile(space, e.path)}
                          className={`flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-accent ${selected ? "bg-row-selected" : ""}`}
                        >
                          {e.kind === "file" ? <FileIcon name={e.title} /> : (s.icon ?? <FileTextIcon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />)}
                          {e.kind === "file" ? <MiddleTruncate value={e.title} className="min-w-0 flex-1 [&>span]:whitespace-pre" /> : <Truncate className="min-w-0 flex-1">{e.title}</Truncate>}
                          {e.kind === "file" && e.bytes != null ? <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{formatBytes(e.bytes)}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {content.truncated ? <p className="px-1 text-muted-foreground text-xs">Showing the first {plural(content.entries.length, "item")}.</p> : null}
          </div>
        )}
      </section>
    </div>
  );
}
