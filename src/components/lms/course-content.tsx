import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollArea, Select, Skeleton } from "vic-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFileViewer } from "@/components/viewer/file-viewer";
import { Icon, type IconName } from "@/icons";
import { lmsCourseContent, type CourseContent, type CourseContentEntry, type CourseInfo } from "@/lib/lms";
import { useActiveSpaceId, useSpaces } from "@/lib/spaces";
import { formatBytes, typeLabel } from "@/runtime/attachments";
import "./course-content.css";

const PAGE_SIZE = 50;
const GROUPS = [{ id: "all", label: "All content" }, { id: "overview", label: "Overview" }, { id: "module", label: "Modules" }, { id: "file", label: "Files" }, { id: "page", label: "Pages" }, { id: "assignment", label: "Assignments" }] as const;
const KIND: Record<CourseContentEntry["kind"], { label: string; icon: IconName }> = {
  overview: { label: "Overview", icon: "book" }, module: { label: "Module", icon: "folder" },
  file: { label: "File", icon: "file-text" }, page: { label: "Page", icon: "file-text" }, assignment: { label: "Assignment", icon: "file" },
};

/** Compact, bounded source navigation; the host still owns access and loading. */
export function CourseContentBrowser({ course, space }: { course: CourseInfo; space: string }) {
  const [content, setContent] = useState<CourseContent | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const file = useFileViewer();
  const active = useActiveSpaceId();
  const { spaces } = useSpaces();
  const context = active && active !== space ? spaces.find(s => s.id === space)?.name ?? space : null;
  useEffect(() => { setQuery(""); setGroup("all"); setPage(0); }, [course.key, space]);
  useEffect(() => {
    let live = true;
    setContent(null); setError("");
    lmsCourseContent(space, course.key).then(result => live && setContent(result), e => live && setError(String(e)));
    return () => { live = false; };
  }, [course.key, space, revision]);
  const filtered = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return content?.entries.filter(entry => (group === "all" || entry.kind === group) && words.every(word => `${entry.title} ${entry.path}`.toLocaleLowerCase().includes(word))) ?? [];
  }, [content, query, group]);
  const lastPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const start = currentPage * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);
  useEffect(() => { listRef.current?.scrollTo({ top: 0 }); }, [currentPage, query, group]);
  const open = (entry: CourseContentEntry) => file.open({ kind: "space", space, path: entry.path, anchor: entry.anchor, headingIndex: entry.headingIndex, textPath: entry.text });
  const groups = GROUPS.map(item => ({ value: item.id, label: `${item.label}${content ? ` (${item.id === "all" ? content.entries.length : content.entries.filter(entry => entry.kind === item.id).length})` : ""}` }));
  return <div className="course-content-browser" data-course-content={course.key}>
    {context && <p className="flex items-center gap-1.5 text-xs text-ink-secondary" data-course-view-context={space}><Icon name="folder" className="size-3.5 shrink-0" />Viewing as <span className="text-ink">{context}</span></p>}
    <div className="course-content-toolbar">
      <Input aria-label="Search course content" placeholder="Search course content…" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} />
      <Select aria-label="Course content type" value={group} onValueChange={value => { setGroup(value); setPage(0); }} items={groups} size="sm" />
    </div>
    {error ? <div className="course-content-empty"><p role="alert" className="text-sm text-danger-ink">{error}</p><Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Try again</Button></div> : !content ? <div role="status" aria-label="Loading course content" className="flex flex-col gap-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div> : <>
      <ScrollArea ref={listRef} className="course-content-list" data-course-content-list="">
        <ul aria-label="Course content">
          {visible.map(entry => <li key={`${entry.kind}:${entry.path}#${entry.headingIndex ?? entry.anchor ?? ""}`}>
            <Button type="button" variant="ghost" size="sm" onClick={() => open(entry)} title={entry.path} data-course-content-open={entry.anchor ? `${entry.path}#${entry.anchor}` : entry.path} className="course-content-row">
              <Icon name={KIND[entry.kind].icon} className="course-content-icon" />
              <span className="course-content-name">{entry.title}</span>
              <span className="course-content-kind">{entry.kind === "file" ? typeLabel(entry.path, undefined) : KIND[entry.kind].label}</span>
              <span className="course-content-size">{entry.bytes === undefined ? "" : formatBytes(entry.bytes)}</span>
              <Icon name="chevron-right" className="size-3 shrink-0 text-ink-tertiary" />
            </Button>
          </li>)}
        </ul>
        {!visible.length && <div className="course-content-empty"><p className="text-sm text-ink-secondary">{query ? "No matching content" : "No content in this category"}</p>{query && <Button variant="ghost" size="sm" onClick={() => { setQuery(""); setPage(0); }}>Clear search</Button>}</div>}
      </ScrollArea>
      <div className="course-content-footer">
        <span role="status" className="text-xs text-ink-tertiary" data-course-content-count="">{filtered.length ? `${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length}` : "0 items"}</span>
        <div className="flex items-center gap-1">
          {lastPage > 0 && <>
            <Button variant="ghost" size="icon-xs" aria-label="Previous content page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><Icon name="chevron-left" /></Button>
            <Button variant="ghost" size="icon-xs" aria-label="Next content page" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}><Icon name="chevron-right" /></Button>
          </>}
          <Button variant="ghost" size="icon-xs" aria-label="Refresh course content" title="Refresh course content" onClick={() => setRevision(value => value + 1)}><Icon name="retry" /></Button>
        </div>
      </div>
    </>}
    {content?.truncated && <p role="status" className="text-xs text-warning-ink" data-course-content-truncated="">Listing limit reached</p>}
    {file.viewer}
  </div>;
}
