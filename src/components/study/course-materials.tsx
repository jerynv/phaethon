import { useEffect, useState } from "react";
import { Skeleton } from "vic-ui";

import { CourseContentBrowser } from "@/components/lms/course-content";
import { courseAccessGet, type CourseInfo } from "@/lib/lms";

/** The same authorized source navigator is available where learning happens. */
export function CourseMaterials({ space, folder }: { space: string; folder: string }) {
  const [course, setCourse] = useState<CourseInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true); setCourse(null); setError("");
    void courseAccessGet(space).then((result) => {
      if (!active) return;
      setCourse(result.courses.find((item) => item.folder === folder && (result.access[space]?.[item.key]?.length ?? 0) > 0) ?? null);
    }, (reason) => { if (active) setError(String(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [space, folder]);
  if (loading) return <div role="status" aria-label="Loading course materials" className="flex flex-col gap-3"><Skeleton className="h-9" /><Skeleton className="h-32" /></div>;
  if (error) return <p role="alert" className="text-sm text-danger-ink">{error}</p>;
  return course ? <CourseContentBrowser course={course} space={space} /> : <p className="text-sm text-ink-secondary">No imported materials available for this course.</p>;
}
