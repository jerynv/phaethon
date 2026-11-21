import { useEffect, useState } from "react";
import { cleanMessage, FieldError } from "@/components/errors";
import { toast } from "@/components/toast";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { lmsCourseCanTrash, lmsCourseDelete } from "../api";
import { shortCourseName } from "../lib/course-name";
import type { CourseInfo } from "../lib/types";
import { useCourses } from "../store";

export function DeleteCourseDialog({ course, onClose }: { course: CourseInfo; onClose: () => void }) {
  const [canTrash, setCanTrash] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = shortCourseName(course.name);
  const label = canTrash === undefined ? "Delete course" : canTrash ? "Move to Trash" : "Delete for good";

  useEffect(() => {
    void lmsCourseCanTrash().then(setCanTrash, (e) => setError(cleanMessage(e)));
  }, []);

  async function remove() {
    if (busy || canTrash === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await lmsCourseDelete(course.connection, course.courseId);
      await useCourses.getState().load();
      toast.success("Course deleted");
      onClose();
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogPopup className="max-w-sm rounded-panel">
        <AlertDialogHeader>
          <AlertDialogTitle className="[overflow-wrap:anywhere]">Delete “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the imported course and its grades from all spaces in Phaethon. {canTrash === true ? "Its local files move to the Trash. " : canTrash === false ? "Its local files are permanently deleted. " : ""}
            The course remains on your course site.
          </AlertDialogDescription>
          <FieldError>{error}</FieldError>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</AlertDialogClose>
          <Button variant="destructive" shape="pill" pending={busy} disabled={canTrash === undefined} onClick={() => void remove()}>
            {label}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
