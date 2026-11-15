import { CircleHalf, GraduationCap, Info, SlidersHorizontal, Sparkle, Stack, TerminalWindow } from "@phosphor-icons/react";
import { ArrowLeftIcon } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { motion } from "motion/react";
import { Header } from "@/app/Header";
import { type SettingsSection, useNav } from "@/app/store";
import { Kbd } from "@/components/ui/kbd";
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
 * Settings is a page inside the shell: the sidebar stays, the title bar says
 * "Settings / section", a narrow section list sits left of a 42 rem content
 * column. Esc, Back, ⌘, (Ctrl+, elsewhere), any view tab and any sidebar row
 * leave it.
 */

type IconC = (p: { className?: string }) => ReactNode;

export const SECTIONS: { id: SettingsSection; label: string; icon: IconC }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "providers", label: "Providers", icon: Sparkle },
  { id: "agents", label: "Coding agents", icon: TerminalWindow },
  { id: "spaces", label: "Spaces", icon: Stack },
  { id: "courses", label: "Courses", icon: GraduationCap },
  { id: "appearance", label: "Appearance", icon: CircleHalf },
  { id: "about", label: "About", icon: Info },
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
    <nav aria-label="Settings" className="flex w-48 shrink-0 flex-col gap-px overflow-y-auto border-r px-2 py-3 ">
      <button
        type="button"
        onClick={close}
        className="group mb-3 flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        Back
        <Kbd className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">Esc</Kbd>
      </button>
      {SECTIONS.map((s) => {
        const active = s.id === section;
        return (
          <button
            key={s.id}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => open(s.id)}
            className={cn(
              "relative flex h-7 items-center gap-2 rounded-md px-2 text-sm transition-colors",
              active ? "text-foreground" : "text-foreground/80 hover:bg-accent hover:text-foreground",
            )}
          >
            {active ? <motion.span layoutId="settings-nav" transition={{ type: "spring", duration: 0.25, bounce: 0.1 }} className="absolute inset-0 -z-10 rounded-md bg-row-selected" /> : null}
            <s.icon className={cn("size-4 shrink-0", active ? "text-foreground" : "text-muted-foreground")} />
            {s.label}
          </button>
        );
      })}
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
  const title = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-muted-foreground">Settings</span>
      <span className="text-subtle-foreground">/</span>
      {crumb ? (
        <>
          <button type="button" onClick={crumb.onBack} className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
            {meta.label}
          </button>
          <span className="text-subtle-foreground">/</span>
          <span className="min-w-0 truncate font-medium">{crumb.label}</span>
        </>
      ) : (
        <h1 className="font-medium">{meta.label}</h1>
      )}
    </span>
  );
  return (
    <div className="flex min-h-0 flex-1 border-t">
      <Header title={title} />
      <Nav section={section} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-(--settings-max-width) flex-col gap-6 px-4 pt-8 pb-16" key={section}>
          <CrumbContext value={setCrumb}>
            <Body section={section} />
          </CrumbContext>
        </div>
      </div>
    </div>
  );
}
