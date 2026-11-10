import { useEffect, useState, type ReactNode } from "react";
import { ChatView } from "@/features/chat/ChatView";
import { CoursesView } from "@/features/courses/CoursesView";
import { GradesView } from "@/features/grades/GradesView";
import { PlanView } from "@/features/plan/PlanView";
import { StudyView } from "@/features/study/StudyView";
import { FileViewer } from "@/features/viewer/FileViewer";
import { useNav } from "./nav";
import { useCurrentSpace } from "./spaces";
import type { ViewKind } from "./views";

function render(kind: ViewKind, spaceId: string): ReactNode {
  switch (kind) {
    case "chat":
      return <ChatView spaceId={spaceId} />;
    case "study":
      return <StudyView spaceId={spaceId} />;
    case "grades":
      return <GradesView spaceId={spaceId} />;
    case "plan":
      return <PlanView spaceId={spaceId} />;
    case "courses":
      return <CoursesView spaceId={spaceId} />;
  }
}

/**
 * The feature mount points (features/README.md). A view stays mounted once
 * visited in the current space, hidden while another is shown, so it keeps
 * its scroll and state. An open file shows beside the view (over it at
 * phone width).
 */
export function MainArea() {
  const spaceId = useNav((s) => s.spaceId);
  const view = useNav((s) => s.view);
  const file = useNav((s) => s.file);
  const closeFile = useNav((s) => s.closeFile);
  const space = useCurrentSpace();
  const [visited, setVisited] = useState<{ spaceId: string; kinds: ViewKind[] }>({ spaceId, kinds: [view.kind] });

  const kinds = visited.spaceId === spaceId ? visited.kinds : [];
  if (!kinds.includes(view.kind)) setVisited({ spaceId, kinds: [...kinds, view.kind] });

  // A space without education shows only Chat.
  const education = space?.educationEnabled ?? true;
  const go = useNav((s) => s.go);
  useEffect(() => {
    if (space && !education && view.kind !== "chat") go({ kind: "chat" });
  }, [space, education, view.kind, go]);

  return (
    <div className="flex min-h-0 flex-1">
      <div
        id="main-content"
        data-workspace-area="main"
        data-workspace-order={2}
        tabIndex={-1}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col outline-none"
      >
        {(kinds.includes(view.kind) ? kinds : [...kinds, view.kind]).map((kind) => (
          <div
            key={`${spaceId}:${kind}`}
            hidden={kind !== view.kind}
            className="flex min-h-0 flex-1 flex-col"
            data-view={kind}
          >
            {render(kind, spaceId)}
          </div>
        ))}
      </div>
      {file ? (
        <aside
          aria-label="File"
          className="flex min-h-0 w-[min(48%,44rem)] shrink-0 flex-col border-s border-border bg-background max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full max-md:border-0"
        >
          <FileViewer spaceId={file.spaceId} path={file.path} onClose={closeFile} />
        </aside>
      ) : null}
    </div>
  );
}
