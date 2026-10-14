import { useEffect, useState } from "react";

import { useSitesVersion } from "@/components/lms/import-store";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { COURSE_PARTS, courseAccessGet, type CourseAccessView } from "@/lib/lms";
import type { Space } from "@/lib/spaces";

import { useSettingsNav } from "./status";

/**
 * In Settings › Spaces, under a space: the courses it can see and which parts,
 * in words, with a way to Settings › Course sites to change it. Nothing when
 * no course is imported in the vault.
 */
export function SpaceCourses({ space }: { space: Space }) {
  const [view, setView] = useState<CourseAccessView | null>(null);
  const changed = useSitesVersion();
  const { go } = useSettingsNav();
  useEffect(() => {
    let live = true;
    courseAccessGet(space.id).then(
      (v) => live && setView(v),
      () => live && setView(null),
    );
    return () => {
      live = false;
    };
  }, [space.id, changed]);
  if (!view || view.courses.length === 0) return null;
  const mine = view.access[space.id] ?? {};
  const seen = view.courses.filter((c) => (mine[c.key] ?? []).length > 0);
  const words = (key: string) => {
    const parts = mine[key] ?? [];
    if (parts.length === COURSE_PARTS.length) return "all of it";
    return COURSE_PARTS.filter((p) => parts.includes(p.part))
      .map((p) => p.label.toLowerCase())
      .join(", ");
  };
  return (
    <div className="flex flex-col items-start gap-1" data-space-courses={space.id}>
      {seen.length === 0 ? (
        <p className="flex items-center gap-1.5 text-sm text-ink-secondary">
          <Icon name="lock" className="size-(--ph-icon-size-sm) shrink-0" />
          Can’t see any courses.
        </p>
      ) : (
        <>
          <p className="text-sm text-ink-secondary">Courses {space.name} can see:</p>
          <ul aria-label={`Courses ${space.name} can see`} className="flex w-full flex-col rounded-md bg-surface-sunken">
            {seen.map((c) => (
              <li key={c.key} className="flex flex-col py-2 ps-3 pe-1.5 not-first:border-t not-first:border-line" data-space-course={c.key}>
                <span className="text-base wrap-anywhere text-ink">{c.name}</span>
                <span className="text-sm text-ink-secondary">{words(c.key)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <Button type="button" variant="link" className="px-0" onClick={() => go("courses", `[data-access-row="${CSS.escape(space.id)}"] [data-cell]`)} data-space-courses-change="">
        Choose which courses {space.name} can see…
      </Button>
    </div>
  );
}
