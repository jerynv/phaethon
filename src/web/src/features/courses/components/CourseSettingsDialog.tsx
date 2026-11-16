import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { ToggleRow } from "@/components/ui/toggle-row";
import { COURSE_PARTS, type CourseInfo, type CoursePart } from "../lib/types";
import { partsOf, useCourses } from "../store";

const PART_HINTS: Record<CoursePart, string> = {
  overview: "The course’s home page",
  syllabus: "The syllabus and course policies",
  assignments: "Assignments, instructions and due dates",
  announcements: "Announcements and the files they attach",
  files: "Lecture notes, readings and other files",
  grades: "Scores and the grade book",
};

/** What this space sees of a course: all of it at once, or part by part. Opened from the course's `…` menu. */
export function CourseSettingsDialog({ space, course, open, onOpenChange }: { space: string; course: CourseInfo; open: boolean; onOpenChange: (open: boolean) => void }) {
  const parts = useCourses((s) => partsOf(s.access.data, space, course.key));
  const setParts = useCourses((s) => s.setParts);
  const all = COURSE_PARTS.map((p) => p.part);
  const set = (part: CoursePart, on: boolean) => void setParts(space, course.key, all.filter((p) => (p === part ? on : parts.includes(p))));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Course settings</DialogTitle>
          <DialogDescription className="truncate">{course.name}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Card>
            <CardContent className="gap-0">
              <ToggleRow
                title="Show in this space"
                description={parts.length === 0 ? "Hidden here" : parts.length === all.length ? "Every part" : `${parts.length} of ${all.length} parts`}
                checked={parts.length > 0}
                onCheckedChange={(v) => void setParts(space, course.key, v ? all : [])}
                className="border-b pt-0"
              />
              <h4 className="mt-5 mb-1 text-subtle-foreground text-xs">Parts</h4>
              <div className="flex flex-col divide-y" aria-label="Parts this space can see">
                {COURSE_PARTS.map((p) => (
                  <ToggleRow key={p.part} title={p.label} description={PART_HINTS[p.part]} checked={parts.includes(p.part)} onCheckedChange={(v) => set(p.part, v)} />
                ))}
              </div>
            </CardContent>
          </Card>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
