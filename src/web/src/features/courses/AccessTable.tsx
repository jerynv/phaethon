/**
 * Which spaces see which parts of one course: a table of spaces by parts,
 * each cell a checkbox saved at once (and put back if saving fails), with All
 * and None per space. One save per space at a time.
 */
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { errorText } from "@/lib/core";

import { courseAccessSet } from "./api";
import { COURSE_PARTS, type CourseInfo, type CoursePart, type SpaceSummary } from "./lib/types";
import { announce } from "./shared/announce";
import { sitesChanged } from "./shared/signals";

export function AccessTable({
  course,
  spaces,
  access,
  onChange,
}: {
  course: CourseInfo;
  spaces: SpaceSummary[];
  access: Record<string, Record<string, CoursePart[]>>;
  onChange: (space: string, parts: CoursePart[]) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(new Set<string>());

  const set = async (space: SpaceSummary, parts: CoursePart[], said: string) => {
    if (busy.current.has(space.id)) return;
    const before = access[space.id]?.[course.key] ?? [];
    const ordered = COURSE_PARTS.map((p) => p.part).filter((p) => parts.includes(p));
    busy.current.add(space.id);
    onChange(space.id, ordered);
    setProblem(null);
    try {
      await courseAccessSet(space.id, course.key, ordered);
      announce(said);
      sitesChanged();
    } catch (e) {
      onChange(space.id, before);
      setProblem(`That change couldn’t be saved: ${errorText(e)}`);
    } finally {
      busy.current.delete(space.id);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div role="region" tabIndex={0} aria-label={`Who can see ${course.name}`} className="overflow-x-auto rounded-xl border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">Parts of {course.name} each space can see</caption>
          <thead>
            <tr className="border-b">
              <th scope="col" className="px-4 py-2.5 text-start font-medium text-muted-foreground">
                Space
              </th>
              {COURSE_PARTS.map((p) => (
                <th key={p.part} scope="col" className="px-2 py-2.5 text-center font-medium text-muted-foreground">
                  {p.label}
                </th>
              ))}
              <th scope="col" className="px-4 py-2.5">
                <span className="sr-only">All or none</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {spaces.map((s) => {
              const parts = access[s.id]?.[course.key] ?? [];
              return (
                <tr key={s.id} className="border-b last:border-b-0" data-access-space={s.id}>
                  <th scope="row" className="px-4 py-2.5 text-start font-medium text-foreground">
                    {s.name}
                  </th>
                  {COURSE_PARTS.map((p) => {
                    const on = parts.includes(p.part);
                    return (
                      <td key={p.part} className="px-2 py-2.5 text-center">
                        <Checkbox
                          aria-label={`${s.name} sees ${p.label.toLowerCase()}`}
                          checked={on}
                          onCheckedChange={(v) =>
                            void set(s, v ? [...parts, p.part] : parts.filter((x) => x !== p.part), `${s.name} ${v ? "can now see" : "no longer sees"} the ${p.label.toLowerCase()} of ${course.name}.`)
                          }
                        />
                      </td>
                    );
                  })}
                  <td className="px-4 py-2 text-end whitespace-nowrap">
                    <Button size="xs" variant="ghost" disabled={parts.length === COURSE_PARTS.length} onClick={() => void set(s, COURSE_PARTS.map((p) => p.part), `${s.name} can now see all of ${course.name}.`)} aria-label={`${s.name} sees all of it`}>
                      All
                    </Button>
                    <Button size="xs" variant="ghost" disabled={parts.length === 0} onClick={() => void set(s, [], `${s.name} no longer sees ${course.name}.`)} aria-label={`${s.name} sees none of it`}>
                      None
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {problem}
        </p>
      )}
    </div>
  );
}
