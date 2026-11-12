import { GraduationCap } from "@phosphor-icons/react";
import { ArrowLeftIcon, BoxesIcon, InfoIcon, Settings2Icon, SparklesIcon, SquareTerminalIcon, SunMoonIcon } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { type SettingsSection, useNav } from "@/app/store";
import { Kbd } from "@/components/ui/kbd";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { AboutSection } from "./AboutSection";
import { AgentsSection } from "./agents/AgentsSection";
import { AppearanceSection } from "./AppearanceSection";
import { GeneralSection } from "./GeneralSection";
import { ProvidersSection } from "./providers/ProvidersSection";
import { SpacesSection } from "./spaces/SpacesSection";
import { type Crumb, CrumbContext } from "./ui";

const CourseSettings = lazy(() => import("@/features/courses/CourseSettings").then((m) => ({ default: m.CourseSettings })));

/**
 * Settings, after T3 Code's: the left column takes the sidebar's place (same
 * width and tint) with "Back to app" and the sections; the right side has a
 * 40 px header with the section's title and a 42 rem content column.
 * Esc and ⌘, (Ctrl+, elsewhere; handled by the shell) close it.
 */

type IconC = (p: { className?: string }) => ReactNode;
const Cap: IconC = ({ className }) => <GraduationCap className={className} weight="regular" />;

export const SECTIONS: { id: SettingsSection; label: string; icon: IconC }[] = [
  { id: "general", label: "General", icon: (p) => <Settings2Icon {...p} strokeWidth={1.75} /> },
  { id: "providers", label: "Providers", icon: (p) => <SparklesIcon {...p} strokeWidth={1.75} /> },
  { id: "agents", label: "Coding agents", icon: (p) => <SquareTerminalIcon {...p} strokeWidth={1.75} /> },
  { id: "spaces", label: "Spaces", icon: (p) => <BoxesIcon {...p} strokeWidth={1.75} /> },
  { id: "courses", label: "Courses", icon: Cap },
  { id: "appearance", label: "Appearance", icon: (p) => <SunMoonIcon {...p} strokeWidth={1.75} /> },
  { id: "about", label: "About", icon: (p) => <InfoIcon {...p} strokeWidth={1.75} /> },
];

/** True when something layered (dialog, popover, menu, listbox) is open and should take Esc itself. */
function layerOpen(): boolean {
  return !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
}

function useEscToClose(close: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || layerOpen()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        t.blur();
        return;
      }
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
}

function Nav({ section }: { section: SettingsSection }) {
  const close = useNav((s) => s.closeSettings);
  const open = useNav((s) => s.openSettings);
  return (
    <nav aria-label="Settings" className="flex h-full w-(--sidebar-width) shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className={cn("app-drag flex h-(--titlebar-height) shrink-0 items-center pr-2", isMac() ? "pl-[76px]" : "pl-3")}>
        {!isMac() ? <span className="font-semibold text-sm tracking-[-0.01em]">Settings</span> : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-2">
        <button
          type="button"
          onClick={close}
          className="group flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" strokeWidth={1.75} />
          Back to app
          <Kbd className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">Esc</Kbd>
        </button>
        <div className="mt-3 flex h-6 items-center px-2">
          <span className="font-medium text-2xs text-muted-foreground">Settings</span>
        </div>
        {SECTIONS.map((s) => {
          const active = s.id === section;
          return (
            <button
              key={s.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => open(s.id)}
              className={cn(
                "flex h-7 items-center gap-2 rounded-md px-2 text-sm transition-colors",
                active ? "bg-row-selected text-foreground" : "text-sidebar-foreground/85 hover:bg-accent hover:text-foreground",
              )}
            >
              <s.icon className={cn("size-4 shrink-0", active ? "text-foreground" : "text-muted-foreground")} />
              {s.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function Body({ section }: { section: SettingsSection }) {
  switch (section) {
    case "general":
      return <GeneralSection />;
    case "providers":
      return <ProvidersSection />;
    case "agents":
      return <AgentsSection />;
    case "spaces":
      return <SpacesSection />;
    case "courses":
      return (
        <Suspense fallback={null}>
          <CourseSettings />
        </Suspense>
      );
    case "appearance":
      return <AppearanceSection />;
    case "about":
      return <AboutSection />;
  }
}

export function SettingsView() {
  const section = useNav((s) => s.settings) ?? "general";
  const close = useNav((s) => s.closeSettings);
  const [crumb, setCrumb] = useState<Crumb>(null);
  useEscToClose(close);
  const meta = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  return (
    <div className="flex h-full">
      <Nav section={section} />
      <main className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="app-drag flex h-(--titlebar-height) shrink-0 items-center gap-1.5 border-b px-4 text-sm">
          {crumb ? (
            <>
              <button type="button" onClick={crumb.onBack} className="app-no-drag shrink-0 text-muted-foreground transition-colors hover:text-foreground">
                {meta.label}
              </button>
              <span className="text-subtle-foreground">/</span>
              <span className="min-w-0 truncate font-medium">{crumb.label}</span>
            </>
          ) : (
            <h1 className="font-medium">{meta.label}</h1>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-6 px-4 pt-8 pb-16" key={section}>
            <CrumbContext value={setCrumb}>
              <Body section={section} />
            </CrumbContext>
          </div>
        </div>
      </main>
    </div>
  );
}
