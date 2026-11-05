import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";

export type CourseTile = { id: string; name: string; detail: string; metric?: string; progress?: number };

/** T3's project → workspace hierarchy, applied to Moodle's course → activity navigation. */
export function CourseGrid({ courses, onOpen, label = "Courses" }: { courses: CourseTile[]; onOpen: (id: string) => void; label?: string }) {
  return (
    <ul aria-label={label} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 items-stretch" data-course-grid="">
      {courses.map((course) => (
        <li key={course.id} className="min-w-0">
          <Button type="button" variant="outline" data-open-course={course.id} onClick={() => onOpen(course.id)} className="h-full w-full text-start [&>.ui-button-face]:h-full [&>.ui-button-face]:w-full [&>.ui-button-face]:items-stretch [&>.ui-button-face]:p-4">
            <span className="flex min-w-0 w-full flex-col gap-4">
              <span className="flex items-start justify-between gap-3"><span className="min-w-0 min-h-[2lh] line-clamp-2 text-base font-medium text-ink wrap-break-word">{course.name}</span><Icon name="chevron-right" className="shrink-0 text-ink-tertiary" /></span>
              <span className="flex items-end justify-between gap-3"><span className="min-h-[2lh] text-sm font-normal text-ink-secondary">{course.detail}</span>{course.metric && <span className="shrink-0 text-lg font-semibold tabular-nums text-ink">{course.metric}</span>}</span>
              {course.progress != null && <span className="h-1 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true"><span className="block h-full rounded-full bg-accent-fill" style={{ width: `${Math.max(0, Math.min(100, course.progress))}%` }} /></span>}
            </span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function CourseBack({ onBack }: { onBack: () => void }) {
  return <Button type="button" variant="ghost" size="sm" onClick={onBack} data-course-back="" className="self-start"><Icon name="chevron-left" />Courses</Button>;
}

export const courseMatches = (saved: string | undefined, folder: string, name: string): boolean => {
  if (folder === "uncategorized") return !saved;
  const key = (s: string) => s.replace(/^courses\//, "").trim().toLocaleLowerCase();
  return !!saved && [folder, name].some((value) => key(value) === key(saved));
};
