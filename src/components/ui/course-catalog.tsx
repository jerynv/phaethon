import { Card } from "vic-ui";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/icons";
import type { CourseInfo } from "@/lib/lms";

export type CatalogCourse = {
  id: string;
  name: string;
  code?: string;
  term?: string;
  detail: string;
  metric?: string;
};

/** Imported identity is shared by Study and Grades; local study-only folders keep their name. */
export function courseCatalogIdentity(
  courses: readonly CourseInfo[],
  choice: { folder: string; name: string; connection?: string; courseId?: string },
): Pick<CatalogCourse, "name" | "code" | "term"> {
  const folder = (value: string) => value.replace(/^courses\//, "");
  const course = (choice.connection && choice.courseId
    ? courses.find(item => item.connection === choice.connection && item.courseId === choice.courseId)
    : undefined) ?? courses.find(item => folder(item.folder) === folder(choice.folder));
  return course ? { name: course.name, code: course.code, term: course.term } : { name: choice.name };
}

/** T3's compact, whole-row navigation applied consistently to each course workspace. */
export function CourseCatalog({ courses, onOpen, query, onQueryChange, summaryLabel }: {
  courses: CatalogCourse[];
  onOpen: (id: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  summaryLabel: "Practice" | "Grade";
}) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const shown = courses.filter(course => {
    const text = `${course.name} ${course.code ?? ""} ${course.term ?? ""}`.toLocaleLowerCase();
    return words.every(word => text.includes(word));
  }).sort((a, b) => (a.code || a.name).localeCompare(b.code || b.name, undefined, { numeric: true, sensitivity: "base" }));
  return <div className="flex min-w-0 flex-col gap-3" data-course-catalog="">
    {(courses.length > 6 || query) && <div className="flex items-center gap-3">
      <Input type="search" aria-label="Search courses" placeholder="Search courses…" value={query} onChange={event => onQueryChange(event.target.value)} className="min-w-0 flex-1 sm:max-w-sm" />
      <span className="shrink-0 text-sm text-ink-secondary tabular-nums" role="status" aria-live="polite">{words.length ? `${shown.length} of ${courses.length}` : courses.length}</span>
    </div>}
    {shown.length ? <Card flush className="min-w-0 overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 text-xs text-ink-secondary" aria-hidden="true">
        <span>Course</span><span className="pr-6">{summaryLabel}</span>
      </div>
      <ul aria-label="Courses" className="divide-y divide-line" data-course-grid="">
        {shown.map(course => <li key={course.id} className="min-w-0">
          <Button type="button" variant="ghost" data-open-course={course.id} onClick={() => onOpen(course.id)}
            className="w-full rounded-none! text-start [&>.ui-button-face]:w-full [&>.ui-button-face]:rounded-none [&>.ui-button-face]:px-3 [&>.ui-button-face]:py-2">
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="block truncate text-sm font-normal text-ink" title={course.name} data-course-catalog-name="">{course.name}</span>
                <span className="block min-h-[1lh] truncate text-xs font-normal text-ink-secondary" data-course-catalog-meta="">{[course.code, course.term].filter(Boolean).join(" · ") || course.detail}</span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-0.5 text-end">
                <span className="min-h-[1lh] text-sm font-medium text-ink tabular-nums" data-course-catalog-metric="">{course.metric ?? "—"}</span>
                {(course.code || course.term) && <span className="text-xs font-normal text-ink-secondary tabular-nums">{course.detail}</span>}
              </span>
              <Icon name="chevron-right" className="size-3.5 shrink-0 text-ink-tertiary" />
            </span>
          </Button>
        </li>)}
      </ul>
    </Card> : <div className="flex items-center justify-between gap-3 py-6" data-course-catalog-empty="">
      <p role="status" className="text-sm text-ink-secondary">No matching courses</p>
      <Button type="button" variant="ghost" size="sm" onClick={() => onQueryChange("")}>Clear search</Button>
    </div>}
  </div>;
}
