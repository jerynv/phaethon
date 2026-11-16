import { useEffect } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { shortCourseName } from "../lib/space-access";
import { COURSE_PARTS } from "../lib/types";
import { useCourses } from "../store";
import { AccessPicker, type PickerItem } from "./AccessPicker";

const ALL_PARTS = COURSE_PARTS.map((p) => p.part);

/**
 * The inverse of Settings › Courses' access list, for one space: which
 * courses it sees, in the same picker. Nothing shows until a course is
 * imported.
 */
export function SpaceCourses({ space, name }: { space: string; name: string }) {
  const view = useCourses((s) => s.access.data);
  const setParts = useCourses((s) => s.setParts);

  useEffect(() => {
    const { access, loadAccess } = useCourses.getState();
    if (!access.data) void loadAccess();
  }, []);

  if (!view?.courses.length) return null;
  const mine = view.access[space] ?? {};
  const items: PickerItem[] = view.courses
    .map((c) => ({ id: c.key, label: shortCourseName(c.name), title: c.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const all = items.filter((i) => (mine[i.id]?.length ?? 0) >= ALL_PARTS.length).map((i) => i.id);
  const some = items.filter((i) => (mine[i.id]?.length ?? 0) > 0 && !all.includes(i.id)).map((i) => i.id);
  const count = all.length + some.length;

  return (
    <div data-slot="settings-row" className="flex min-h-10 items-center gap-4 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-foreground text-sm">Courses</div>
        <div className="text-muted-foreground text-xs tabular-nums">
          {count ? `Sees ${count} of ${view.courses.length}` : "Sees none yet"}
        </div>
      </div>
      <AccessPicker
        items={items}
        all={all}
        some={some}
        search="Search courses"
        empty="No course matches."
        onToggle={(id, on) => void setParts(space, id, on ? ALL_PARTS : [])}
        trigger={
          <Button variant="outline" size="sm" aria-label={`Courses ${name} sees`}>
            Choose
            <Icon icon={icons.chevronsUpDown} />
          </Button>
        }
      />
    </div>
  );
}
