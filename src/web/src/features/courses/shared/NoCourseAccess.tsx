/** An empty state for a space not allowed to see the vault's courses (or the part a view needs). */
import { LockIcon } from "lucide-react";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";

import type { CoursePart } from "../lib/types";

const PART_WORDS: Partial<Record<CoursePart, string>> = { grades: "the grades of", assignments: "what’s due in", files: "the files of" };

export function NoCourseAccess({ why, part }: { why: "none" | "part"; part?: CoursePart }) {
  const go = useNav((s) => s.go);
  const text = why === "none" ? "This space can’t see any of your courses." : `This space can’t see ${PART_WORDS[part ?? "files"] ?? "this part of"} its courses.`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3.5" data-no-course-access={why}>
      <p className="flex min-w-0 items-start gap-2 text-sm text-foreground">
        <LockIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span>{text}</span>
      </p>
      <Button size="sm" variant="outline" onClick={() => go({ kind: "courses" })}>
        Choose what it sees
      </Button>
    </div>
  );
}
