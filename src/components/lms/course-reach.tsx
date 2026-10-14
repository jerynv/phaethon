import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { courseAccessGet, type CoursePart } from "@/lib/lms";
import { openSettings } from "@/lib/open-settings";
import { inTauri } from "@/lib/tauri";

import { useSitesVersion } from "./import-store";

/** What a space can see of the vault's courses. */
export type CourseReach = {
  /** Courses imported in the vault, whoever can see them. */
  imported: number;
  /** Courses this space can see, and which parts. */
  seen: Record<string, CoursePart[]>;
};

/**
 * What `space` can see of the vault's courses (null while loading, or outside
 * the app). Read again when course sites or who sees them change.
 */
export function useCourseReach(space: string): CourseReach | null {
  const [reach, setReach] = useState<CourseReach | null>(null);
  const changed = useSitesVersion();
  useEffect(() => {
    if (!inTauri()) return;
    let live = true;
    courseAccessGet(space).then(
      (v) => {
        if (!live) return;
        const known = new Set(v.courses.map((c) => c.key));
        const seen = Object.fromEntries(Object.entries(v.access[space] ?? {}).filter(([k, p]) => known.has(k) && p.length > 0));
        setReach({ imported: v.courses.length, seen });
      },
      () => live && setReach(null),
    );
    return () => {
      live = false;
    };
  }, [space, changed]);
  return reach;
}

/** Whether a view's empty state should say the space isn't allowed to see courses, and which words. */
export function hiddenCourses(reach: CourseReach | null, part?: CoursePart | CoursePart[]): "none" | "part" | null {
  if (!reach || reach.imported === 0) return null;
  const seen = Object.values(reach.seen);
  if (seen.length === 0) return "none";
  const want = part ? [part].flat() : null;
  if (want && !seen.some((p) => want.some((w) => p.includes(w)))) return "part";
  return null;
}

const PART_WORDS: Partial<Record<CoursePart, string>> = { grades: "the grades of", assignments: "what’s due in" };

/**
 * An empty state for a space that may not see the vault's courses (or the
 * part a view needs): says so, and opens Settings › Course sites to choose.
 */
export function NoCourseAccess({ why, part }: { why: "none" | "part"; part?: CoursePart }) {
  const text =
    why === "none"
      ? `This space can’t see any courses. Choose which ones in Settings › Course sites.`
      : `This space can’t see ${PART_WORDS[part ?? "files"] ?? "this part of"} its courses. Choose what it can see in Settings › Course sites.`;
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface px-5 py-4" data-no-course-access={why}>
      <p className="flex items-start gap-2 text-md font-medium text-ink">
        <Icon name="lock" className="mt-0.5 shrink-0 text-ink-secondary" />
        <span className="min-w-0">{text}</span>
      </p>
      <Button type="button" variant="outline" onClick={() => openSettings("courses")} data-open-course-access="">
        Choose in Settings…
      </Button>
    </div>
  );
}
