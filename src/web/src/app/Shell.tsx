import { lazy, Suspense, useEffect } from "react";
import { toast } from "@/components/toast";
import { ChatView } from "@/features/chat/ChatView";
import { errorText } from "@/lib/core";
import { SidebarProvider } from "@/components/ui/sidebar";
import { CommandPalette } from "./CommandPalette";
import { Header } from "./Header";
import { matchShortcut } from "./shortcuts";
import { Sidebar } from "./Sidebar";
import { useActiveSpace, useNav } from "./store";
import { VIEWS } from "./views";
import { EmptySpaces } from "./EmptySpaces";

const StudyView = lazy(() => import("@/features/study/StudyView").then((m) => ({ default: m.StudyView })));
const GradesView = lazy(() => import("@/features/grades/GradesView").then((m) => ({ default: m.GradesView })));
const PlanView = lazy(() => import("@/features/plan/PlanView").then((m) => ({ default: m.PlanView })));
const CoursesView = lazy(() => import("@/features/courses/CoursesView").then((m) => ({ default: m.CoursesView })));
const SettingsView = lazy(() => import("@/features/settings/SettingsView").then((m) => ({ default: m.SettingsView })));
const FileViewer = lazy(() => import("@/features/viewer/FileViewer").then((m) => ({ default: m.FileViewer })));

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

function PageFallback() {
  return <div className="flex-1" />;
}

function Main() {
  const view = useNav((s) => s.view);
  const space = useActiveSpace();
  const spaces = useNav((s) => s.spaces);
  if (spaces.data && spaces.data.length === 0) return <EmptySpaces />;
  if (!space) return <div className="flex flex-1 flex-col"><Header /></div>;
  const v = space.educationEnabled ? view : "chat";
  return (
    <Suspense fallback={<PageFallback />}>
      {v === "chat" ? <ChatView key={space.id} space={space} /> : null}
      {v === "study" ? <StudyView key={space.id} space={space} /> : null}
      {v === "grades" ? <GradesView key={space.id} space={space} /> : null}
      {v === "plan" ? <PlanView key={space.id} space={space} /> : null}
      {v === "courses" ? <CoursesView key={space.id} space={space} /> : null}
    </Suspense>
  );
}

export function Shell() {
  useShortcuts();
  const sidebarOpen = useNav((s) => s.sidebarOpen);
  const toggleSidebar = useNav((s) => s.toggleSidebar);
  const settings = useNav((s) => s.settings);
  const viewer = useNav((s) => s.viewer);
  if (settings) {
    return (
      <Suspense fallback={<PageFallback />}>
        <SettingsView />
        <CommandPalette />
      </Suspense>
    );
  }
  return (
    <SidebarProvider open={sidebarOpen} onToggle={toggleSidebar}>
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        <Main />
      </main>
      {viewer ? (
        <Suspense fallback={null}>
          <FileViewer />
        </Suspense>
      ) : null}
      <CommandPalette />
    </SidebarProvider>
  );
}
