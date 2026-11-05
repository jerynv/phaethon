import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { lmsConnections } from "@/lib/lms";
import { inTauri } from "@/lib/tauri";
import { supportsEducation } from "@/lib/spaces";
import { Icon } from "@/icons";

import { openCourseImport, useRun, useSitesVersion } from "./import-store";

/**
 * Under an empty conversation, while no course site is connected yet (they
 * belong to the whole vault): one quiet line offering to bring courses in.
 * Nothing while the sites load, or once one is connected.
 */
export function CoursesSuggestion({ spaceId }: { spaceId: string }) {
  const education = supportsEducation(spaceId);
  const [none, setNone] = useState(false);
  // Looked at again when an import ends (a site may have been connected).
  const ended = useRun()?.status !== "running";
  const changed = useSitesVersion();
  useEffect(() => {
    if (!inTauri() || !education) return;
    let live = true;
    lmsConnections().then(
      (cs) => live && setNone(cs.length === 0),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [spaceId, ended, changed, education]);
  if (!none || !education) return null;
  return (
    <div data-courses-suggestion="">
      <Button type="button" variant="ghost" size="sm" onClick={() => openCourseImport({ space: spaceId })}>
        <Icon name="book" />Import courses
      </Button>
    </div>
  );
}
