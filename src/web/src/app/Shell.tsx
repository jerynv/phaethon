import { animate } from "motion/react";
import { type ComponentType, lazy, type ReactNode, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DotMatrix } from "@/components/art";
import { toast } from "@/components/toast";
import { ChatView } from "@/features/chat/ChatView";
import { errorText } from "@/lib/core";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { SpaceView } from "./api";
import { CommandPalette } from "./CommandPalette";
import { AppHeader, HeaderSlots, ViewActive } from "./Header";
import { matchShortcut } from "./shortcuts";
import { Sidebar } from "./Sidebar";
import { useActiveSpace, useNav, type View } from "./store";
import { VIEWS } from "./views";
import { EmptySpaces } from "./EmptySpaces";

const StudyView = lazy(() => import("@/features/study/StudyView").then((m) => ({ default: m.StudyView })));
const GradesView = lazy(() => import("@/features/grades/GradesView").then((m) => ({ default: m.GradesView })));
const PlanView = lazy(() => import("@/features/plan/PlanView").then((m) => ({ default: m.PlanView })));
const CoursesView = lazy(() => import("@/features/courses/CoursesView").then((m) => ({ default: m.CoursesView })));
const SettingsView = lazy(() => import("@/features/settings/SettingsView").then((m) => ({ default: m.SettingsView })));
const FileViewer = lazy(() => import("@/features/viewer/FileViewer").then((m) => ({ default: m.FileViewer })));

const PAGES: Record<Exclude<View, "chat">, ComponentType<{ space: SpaceView }>> = {
  study: StudyView,
  grades: GradesView,
  plan: PlanView,
  courses: CoursesView,
};

/** App-wide keys (app/shortcuts.ts). */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = matchShortcut(e);
      if (!m) return;
      const nav = useNav.getState();
      e.preventDefault();
      switch (m.id) {
        case "newChat":
          if (nav.activeSpace) void nav.newChat(nav.activeSpace).catch((err) => toast.error("Couldn’t start a new chat", errorText(err)));
          break;
        case "search":
          nav.setPalette(!nav.paletteOpen);
          break;
        case "sidebar":
          nav.toggleSidebar();
          break;
        case "settings":
          if (nav.settings) nav.closeSettings();
          else nav.openSettings();
          break;
        case "space": {
          const s = nav.spaces.data?.[m.index];
          if (s) nav.selectSpace(s.id);
          break;
        }
        case "view": {
          const space = nav.spaces.data?.find((s) => s.id === nav.activeSpace);
          const views = VIEWS.filter((v) => !v.edu || space?.educationEnabled);
          const v = views[m.index];
          if (v) nav.setView(v.id);
          break;
        }
        case "landmark":
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * One page in the main area. Hidden pages stay mounted (state, scroll and
 * running replies survive) but out of layout and out of the title bar; the
 * page that becomes visible fades and lifts in, briefly.
 */
function Pane({ active, children, name }: { active: boolean; children: ReactNode; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!active || !ref.current) return;
    const a = animate(ref.current, { opacity: [0, 1], transform: ["translateY(4px)", "translateY(0px)"] }, { duration: 0.18, ease: "easeOut" });
    return () => a.stop();
  }, [active]);
  return (
    <div ref={ref} data-page={name} hidden={!active} className="relative flex min-h-0 flex-1 flex-col">
      <ViewActive active={active}>{children}</ViewActive>
    </div>
  );
}

function Main() {
  const view = useNav((s) => s.view);
  const settings = useNav((s) => s.settings);
  const space = useActiveSpace();
  const spaces = useNav((s) => s.spaces);
  const current: View = space?.educationEnabled ? view : "chat";
  // Views visited in this space; the keep-alive ones stay mounted after.
  const [visited, setVisited] = useState<{ space?: string; views: Set<View> }>({ views: new Set() });
  const seen = visited.space === space?.id ? visited.views : new Set<View>();
  if (space && !settings && !seen.has(current)) setVisited({ space: space.id, views: new Set([...seen, current]) });

  if (spaces.data && spaces.data.length === 0 && !settings) return <EmptySpaces />;
  return (
    <>
      {space ? (
        <>
          {/* Chat is always mounted, so a reply, draft or scroll position survives any page switch. */}
          <Pane name="chat" active={!settings && current === "chat"}>
            <ChatView key={space.id} space={space} />
          </Pane>
          {(Object.keys(PAGES) as Exclude<View, "chat">[]).map((id) => {
            const meta = VIEWS.find((v) => v.id === id)!;
            const active = !settings && current === id;
            if (!active && !(meta.keepAlive && seen.has(id) && space.educationEnabled)) return null;
            const Page = PAGES[id];
            return (
              <Pane key={`${space.id}:${id}`} name={id} active={active}>
                <Suspense fallback={<div className="flex-1" />}>
                  <Page space={space} />
                </Suspense>
              </Pane>
            );
          })}
        </>
      ) : null}
      {settings ? (
        <Pane name="settings" active>
          <Suspense fallback={<div className="flex-1" />}>
            <SettingsView />
          </Suspense>
        </Pane>
      ) : null}
    </>
  );
}

/**
 * The app frame (docs/UI-REBUILD.md › App frame): the window is a soft grey
 * canvas, and the whole app sits in one white panel inset from its edges,
 * with a large radius and a hairline. The title bar runs across the top of
 * the panel; below it the sidebar and the page sit side by side, split by a
 * hairline, and a faint dot matrix fades in at the top of every page.
 */
export function Shell() {
  useShortcuts();
  const sidebarOpen = useNav((s) => s.sidebarOpen);
  const toggleSidebar = useNav((s) => s.toggleSidebar);
  const viewer = useNav((s) => s.viewer);
  return (
    <div className="h-full bg-background">
      <SidebarProvider open={sidebarOpen} onToggle={toggleSidebar} className="flex-col overflow-hidden bg-background">
        <HeaderSlots>
          {(bind) => (
            <>
              <AppHeader bind={bind} />
              <div className="flex min-h-0 flex-1">
                <Sidebar />
                <main className="relative flex min-w-0 flex-1 flex-col bg-background">
                  <DotMatrix className="z-0" />
                  <Main />
                </main>
                {viewer ? (
                  <Suspense fallback={null}>
                    <FileViewer />
                  </Suspense>
                ) : null}
              </div>
            </>
          )}
        </HeaderSlots>
        <CommandPalette />
      </SidebarProvider>
    </div>
  );
}
