/** A course's imported content, searchable and by kind, 50 rows a page; each row opens in the file viewer. */
import { BookMarkedIcon, ChevronLeftIcon, ChevronRightIcon, ClipboardListIcon, FileIcon, FileTextIcon, LayoutListIcon, RotateCwIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorText } from "@/lib/core";

import { lmsCourseContent } from "./api";
import { formatBytes, typeLabel } from "./lib/sites";
import type { CourseContent, CourseContentEntry, CourseInfo } from "./lib/types";
import { EmptyState, ErrorState, LiveText, LoadingRows } from "./shared/kit";

const PAGE = 50;
const KIND_LABEL: Record<CourseContentEntry["kind"], string> = { overview: "Overview", module: "Modules", file: "Files", page: "Pages", assignment: "Assignments" };
const KIND_ICON: Record<CourseContentEntry["kind"], React.ReactNode> = {
  overview: <BookMarkedIcon aria-hidden />,
  module: <LayoutListIcon aria-hidden />,
  file: <FileIcon aria-hidden />,
  page: <FileTextIcon aria-hidden />,
  assignment: <ClipboardListIcon aria-hidden />,
};

export function ContentBrowser({ course, space, viewingAs }: { course: CourseInfo; space: string; viewingAs?: string }) {
  const openFile = useNav((s) => s.openFile);
  const [content, setContent] = useState<CourseContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<string>("all");
  const [page, setPage] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    setQuery("");
    setKind("all");
    setPage(0);
  }, [course.key, space]);
  useEffect(() => {
    setContent(null);
    setError(null);
    lmsCourseContent(space, course.key).then(setContent, (e) => setError(errorText(e)));
  }, [course.key, space, rev]);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = useMemo(
    () => (content?.entries ?? []).filter((e) => (kind === "all" || e.kind === kind) && words.every((w) => `${e.title} ${e.path}`.toLowerCase().includes(w))),
    [content, kind, words.join(" ")],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of content?.entries ?? []) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [content]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const at = Math.min(page, pages - 1);
  const shown = filtered.slice(at * PAGE, at * PAGE + PAGE);
  useEffect(() => listRef.current?.scrollTo?.({ top: 0 }), [at, query, kind]);
  const kindItems = [{ value: "all", label: `All (${content?.entries.length ?? 0})` }, ...(Object.keys(KIND_LABEL) as CourseContentEntry["kind"][]).filter((k) => counts[k]).map((k) => ({ value: k, label: `${KIND_LABEL[k]} (${counts[k]})` }))];

  if (error) return <ErrorState title="The course’s content couldn’t be listed." message={error} onRetry={() => setRev((r) => r + 1)} />;
  return (
    <div className="flex flex-col gap-3" data-content-browser={course.key}>
      {viewingAs && <p className="text-sm text-muted-foreground">Showing what {viewingAs} can see.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="max-w-sm flex-1 basis-56">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput type="search" aria-label="Search content" placeholder="Search content" value={query} onChange={(e) => (setQuery(e.target.value), setPage(0))} />
        </InputGroup>
        <Select items={kindItems} value={kind} onValueChange={(v) => (setKind(String(v ?? "all")), setPage(0))}>
          <SelectTrigger aria-label="Kind" className="w-auto min-w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {kindItems.map((k) => (
              <SelectItem key={k.value} value={k.value}>
                {k.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button variant="ghost" size="icon" aria-label="Refresh the list" onClick={() => setRev((r) => r + 1)}>
          <RotateCwIcon aria-hidden />
        </Button>
      </div>
      <LiveText>{content ? (filtered.length ? `${filtered.length} items` : "No matching content") : ""}</LiveText>
      {!content ? (
        <LoadingRows rows={4} label="Loading the course’s content" />
      ) : filtered.length === 0 ? (
        query.trim() ? (
          <EmptyState title="No matching content">
            <Button variant="outline" onClick={() => setQuery("")}>
              Clear search
            </Button>
          </EmptyState>
        ) : (
          <EmptyState title="Nothing here" description="This space can’t see any content of this kind in the course." />
        )
      ) : (
        <>
          <ul ref={listRef} className="divide-y overflow-hidden rounded-xl border bg-card">
            {shown.map((e, i) => (
              <li key={`${e.path}#${e.anchor ?? ""}${i}`}>
                <button
                  type="button"
                  onClick={() => openFile(e.anchor ? `${e.path}#${e.anchor}` : e.path, space)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-start outline-none hover:bg-accent/50 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <span className="text-muted-foreground [&_svg]:size-4">{KIND_ICON[e.kind]}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{e.title}</span>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {e.kind === "file" ? [typeLabel(e.path), e.bytes != null ? formatBytes(e.bytes) : ""].filter(Boolean).join(" · ") : KIND_LABEL[e.kind].replace(/s$/, "")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span role="status">
              {at * PAGE + 1}–{at * PAGE + shown.length} of {filtered.length}
              {content.truncated ? " · listing limit reached" : ""}
            </span>
            {pages > 1 && (
              <span className="flex gap-1">
                <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={at === 0} onClick={() => setPage(at - 1)}>
                  <ChevronLeftIcon aria-hidden />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>
                  <ChevronRightIcon aria-hidden />
                </Button>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
