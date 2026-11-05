import { useEffect, useMemo, useState } from "react";
import { Skeleton } from "vic-ui";
import { Input } from "@/components/ui/input";
import { useFileViewer } from "@/components/viewer/file-viewer";
import { Icon } from "@/icons";
import { lmsCourseContent, type CourseContent, type CourseContentEntry, type CourseInfo } from "@/lib/lms";
import { useActiveSpaceId, useSpaces } from "@/lib/spaces";
import { cn } from "@/lib/utils";

const GROUPS = [{ id: "all", label: "All" }, { id: "module", label: "Modules" }, { id: "file", label: "Files" }, { id: "page", label: "Pages" }, { id: "assignment", label: "Assignments" }] as const;

/** T3-style file navigator over the permission-filtered imported course tree. */
export function CourseContentBrowser({ course, space }: { course: CourseInfo; space: string }) {
  const [content, setContent] = useState<CourseContent | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const file = useFileViewer();
  const active = useActiveSpaceId();
  const { spaces } = useSpaces();
  const context = active && active !== space ? spaces.find(s => s.id === space)?.name ?? space : null;
  useEffect(() => {
    let live = true;
    setContent(null); setError(""); setQuery(""); setGroup("all");
    lmsCourseContent(space, course.key).then(result => live && setContent(result), e => live && setError(String(e)));
    return () => { live = false; };
  }, [course.key, space]);
  const filtered = useMemo(() => content?.entries.filter(entry => (group === "all" || entry.kind === group) && `${entry.title} ${entry.path}`.toLowerCase().includes(query.toLowerCase())) ?? [], [content, query, group]);
  const open = (entry: CourseContentEntry) => file.open({ kind: "space", space, path: entry.path, anchor: entry.anchor, headingIndex: entry.headingIndex });
  return <div className="flex min-h-0 flex-col gap-3" data-course-content={course.key}>
    {context && <p className="flex items-center gap-1.5 text-xs text-ink-secondary" data-course-view-context={space}><Icon name="folder" className="size-3.5 shrink-0" />Viewing as <span className="font-medium text-ink">{context}</span></p>}
    <Input aria-label="Search course content" placeholder="Search files, modules and pages…" value={query} onChange={e => setQuery(e.target.value)} />
    <div className="flex flex-wrap gap-1" role="group" aria-label="Course content type">
      {GROUPS.map(item => <button key={item.id} type="button" onClick={() => setGroup(item.id)} aria-pressed={group === item.id} className={cn("rounded-md px-2 py-1 text-xs transition-colors", group === item.id ? "bg-selected text-ink" : "text-ink-secondary hover:bg-hover")}>{item.label}</button>)}
    </div>
    {error ? <p role="alert" className="text-sm text-danger-ink">{error}</p> : !content ? <div role="status" aria-label="Loading course content" className="flex flex-col gap-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9 w-full" />)}</div> : <ul className="max-h-64 overflow-y-auto overscroll-contain divide-y divide-line" aria-label="Course content">
      {filtered.map(entry => <li key={`${entry.path}#${entry.anchor ?? ""}`}><button type="button" onClick={() => open(entry)} data-course-content-open={entry.anchor ? `${entry.path}#${entry.anchor}` : entry.path} className="flex w-full items-center gap-2 rounded-md px-1 py-2 text-start hover:bg-hover">
        <Icon name={entry.kind === "module" ? "folder" : "file-text"} className="shrink-0 text-ink-tertiary" />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm text-ink">{entry.title}</span><span className="block truncate text-xs text-ink-tertiary">{entry.path}</span></span>
        <Icon name="chevron-right" className="size-3 shrink-0 text-ink-tertiary" />
      </button></li>)}
      {!filtered.length && <li className="py-6 text-center text-sm text-ink-secondary">{query ? "No matching content" : "No content in this category"}</li>}
    </ul>}
    {content?.truncated && <p role="status" className="text-xs text-warning-ink" data-course-content-truncated="">Listing limit reached</p>}
    {file.viewer}
  </div>;
}
