/** The course context control shared by Study, Grades and Plan: all courses, or one. */
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";

import { folderKey } from "../lib/selection";

export type CourseOption = { folder: string; name: string; key?: string };

const ALL = "\u0000all";

export function CourseFilter({
  options,
  value,
  onChange,
  label = "Course",
}: {
  options: CourseOption[];
  /** The selected course's folder (with or without the prefix), or null for all. */
  value: string | null;
  onChange: (option: CourseOption | null) => void;
  label?: string;
}) {
  if (options.length < 2) return null;
  const selected = value ? options.find((o) => folderKey(o.folder).toLowerCase() === folderKey(value).toLowerCase()) : undefined;
  const items = [{ value: ALL, label: "All courses" }, ...options.map((o) => ({ value: o.folder, label: o.name }))];
  return (
    <Select
      items={items}
      value={selected?.folder ?? ALL}
      onValueChange={(v) => onChange(v === ALL || v == null ? null : (options.find((o) => o.folder === v) ?? null))}
    >
      <SelectTrigger aria-label={label} className="w-auto max-w-72 min-w-44" data-course-filter="">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
