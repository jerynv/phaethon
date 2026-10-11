import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { lmsConnections } from "@/lib/lms";
import { inTauri } from "@/lib/tauri";

import { openCourseImport, useRun, useSitesVersion } from "./import-store";

/**
 * Under an empty conversation, in a space with no course site yet: one quiet
 * line offering to bring courses in. Nothing while the space's sites load, or
 * once one is connected.
 */
export function CoursesSuggestion({ spaceId }: { spaceId: string }) {
  const [none, setNone] = useState(false);
  // Looked at again when an import ends (a site may have been connected).
  const ended = useRun()?.status !== "running";
  const changed = useSitesVersion();
  useEffect(() => {
    if (!inTauri()) return;
    let live = true;
    lmsConnections(spaceId).then(
      (cs) => live && setNone(cs.length === 0),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [spaceId, ended, changed]);
  if (!none) return null;
  return (
    <p className="max-w-md text-base text-ink-secondary" data-courses-suggestion="">
      Taking classes? Phaethon can bring in your courses from Canvas, Brightspace, Moodle or Blackboard.{" "}
      <Button type="button" variant="link" className="inline-flex align-baseline" onClick={() => openCourseImport({ space: spaceId })}>
        Import courses…
      </Button>
    </p>
  );
}
