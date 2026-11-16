import { animate } from "motion/react";
import { type ComponentType, lazy, type ReactNode, Suspense, useEffect, useLayoutEffect, useRef } from "react";
import { DotMatrix } from "@/components/art";
import { toast } from "@/components/toast";
import { ChatView } from "@/features/chat/ChatView";
import { Channel, errorText, invoke } from "@/lib/core";
import { cn } from "@/lib/utils";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { SpaceView } from "./api";
import { CommandPalette } from "./CommandPalette";
import { AppHeader, HeaderSlots, ViewActive } from "./Header";
import { matchShortcut } from "./shortcuts";
import { Sidebar } from "./Sidebar";
import { type SettingsSection, useNav, type View } from "./store";
import { VIEWS } from "./views";
import type { AppTarget } from "#shared/host.ts";

type AppEvent = { kind: "open"; target: AppTarget } | { kind: "notification" };
import { EmptySpaces } from "./EmptySpaces";

const StudyView = lazy(() => import("@/features/study/StudyView").then((m) => ({ default: m.StudyView })));
const GradesView = lazy(() => import("@/features/grades/GradesView").then((m) => ({ default: m.GradesView })));
const PlanView = lazy(() => import("@/features/plan/PlanView").then((m) => ({ default: m.PlanView })));
const CoursesView = lazy(() => import("@/features/courses/CoursesView").then((m) => ({ default: m.CoursesView })));
const SettingsView = lazy(() => import("@/features/settings/SettingsView").then((m) => ({ default: m.SettingsView })));
const FileViewer = lazy(() => import("@/features/viewer/FileViewer").then((m) => ({ default: m.FileViewer })));

const FilesView = lazy(() => import("@/features/files/FilesView").then((m) => ({ default: m.FilesView })));

const PAGES: Record<Exclude<View, "chat">, ComponentType<{ space: SpaceView }>> = {
  files: FilesView,
  study: StudyView,
  grades: GradesView,
  plan: PlanView,
  courses: CoursesView,
};

/** True when something layered and on screen (dialog, popover, menu, listbox) should take Esc itself. Pages kept alive behind hold hidden ones. */
function layerOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')].some(
    (el) => !el.closest("[data-inactive]") && el.checkVisibility({ visibilityProperty: true }),
  );
}

/**
 * Esc leaves Settings, from the moment it opens (Settings itself loads on
 * demand, so the shell listens for it). A field takes Esc first (it loses
 * focus), and so does any open menu or dialog.
 */
function useEscLeavesSettings() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || useNav.getState().settings === null || layerOpen()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        t.blur();
        return;
      }
      e.preventDefault();
      useNav.getState().closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * The core's app-wide events for this window: a notification or a menu-bar
 * item that opens something lands here (a conversation, a page, Settings).
 */
function useAppEvents() {
  useEffect(() => {
    const ch = new Channel<AppEvent>((e) => {
      if (e.kind !== "open") return;
      const nav = useNav.getState();
      const t = e.target;
      if (t.kind === "thread") void nav.openThread(t.space, t.thread).catch(() => {});
      else if (t.kind === "settings") nav.openSettings(t.section as SettingsSection);
      else if (t.kind === "space") nav.selectSpace(t.space, t.view as View | undefined);
    });
    void invoke("app_events", { onEvent: ch }).catch(() => {});
    return () => ch.close();
  }, []);
}

/** App-wide keys (app/shortcuts.ts). */
function useShortcuts() {
  useEscLeavesSettings();
  useAppEvents();
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
        case "closeTab":
          if (nav.activeTab) nav.closeTab(nav.activeTab);
          break;
        case "reopenTab":
          nav.reopenTab();
          break;
        case "cycleTab":
          nav.cycleTab(m.direction);
          break;
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
 * running replies survive) but out of the title bar. A hidden page keeps its
 * size, out of the flow and behind the shown one, with `content-visibility:
 * hidden`: the browser skips it (no paint, focus, find or accessibility) but
 * keeps its layout and styles, so showing it again (a long conversation) costs
 * no relayout and its scroll position is where it was. Nothing inherited is
 * toggled on it (`inert`, `visibility`, `pointer-events`), which would restyle
 * the whole page. The page that becomes visible fades in, briefly, in place: nothing slides.
 */
function Pane({ active, children, name }: { active: boolean; children: ReactNode; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!active || !ref.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const a = animate(ref.current, { opacity: [0, 1] }, { duration: 0.14, ease: "easeOut" });
    return () => a.stop();
  }, [active]);
  return (
    <div
      ref={ref}
      data-page={name}
      data-inactive={active ? undefined : ""}
      className={cn("flex min-h-0 flex-col", active ? "relative flex-1" : "absolute inset-0 -z-10 [content-visibility:hidden]")}
    >
      <ViewActive active={active}>{children}</ViewActive>
    </div>
  );
}

/** The open tabs' pages. Every open tab stays mounted (its state, scroll and running replies survive); only the active one is shown. */
function Main() {
  const tabs = useNav((s) => s.tabs);
  const active = useNav((s) => s.activeTab);
  const spaces = useNav((s) => s.spaces);
  const settings = useNav((s) => s.settings !== null);
  if (spaces.data && spaces.data.length === 0 && !settings) return <EmptySpaces />;
  const current = tabs.find((t) => t.id === active);
  // One chat pane per space with a chat tab: it shows whichever of the space's conversations the active tab names.
  const chatSpaces = [...new Set(tabs.filter((t) => t.kind === "chat").map((t) => (t as { space: string }).space))];
  return (
    <>
      {chatSpaces.map((id) => {
        const space = spaces.data?.find((x) => x.id === id);
        if (!space) return null;
        return (
          <Pane key={`chat:${id}`} name="chat" active={!settings && current?.kind === "chat" && current.space === id}>
            <ChatView space={space} />
          </Pane>
        );
      })}
      {tabs.map((t) => {
        if (t.kind !== "view") return null;
        const space = spaces.data?.find((x) => x.id === t.space);
        if (!space) return null;
        const Page = PAGES[t.view];
        return (
          <Pane key={t.id} name={t.view} active={!settings && t.id === active}>
            <Suspense fallback={<div className="flex-1" />}>
              <Page space={space} />
            </Suspense>
          </Pane>
        );
      })}
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
 * The app frame (docs/UI-REBUILD.md › App frame): the app fills the window.
 * The title bar runs across the top; below it the sidebar and the page sit
 * side by side, split by a hairline, and a faint dot field fades in at the
 * top of every page. In a window too narrow for both (`compact`), the sidebar
 * floats over the page when asked for instead.
 */
export function Shell() {
  useShortcuts();
  const sidebarOpen = useNav((s) => s.sidebarOpen);
  const compact = useNav((s) => s.compact);
  const peek = useNav((s) => s.peek);
  const toggleSidebar = useNav((s) => s.toggleSidebar);
  const setCompact = useNav((s) => s.setCompact);
  const viewer = useNav((s) => s.viewer);
  return (
    <div className="h-full bg-background">
      <SidebarProvider
        open={compact ? peek : sidebarOpen}
        floating={compact}
        onCompactChange={setCompact}
        onToggle={toggleSidebar}
        className="flex-col overflow-hidden bg-background"
      >
        <HeaderSlots>
          {(bind) => (
            <>
              <AppHeader bind={bind} />
              <div data-slot="app-body" className="relative flex min-h-0 flex-1">
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
