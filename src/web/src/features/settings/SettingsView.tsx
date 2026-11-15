import { lazy, Suspense, useEffect, useState } from "react";
import { motion } from "motion/react";
import { api } from "@/app/api";
import { Header } from "@/app/Header";
import { type SettingsSection, useNav } from "@/app/store";
import { DotMatrix } from "@/components/art";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { AboutSection } from "./AboutSection";
import { cliStatuses } from "./agents/api";
import { AgentsSection } from "./agents/AgentsSection";
import { AppearanceSection } from "./AppearanceSection";
import { GeneralSection } from "./GeneralSection";
import { getSettings } from "./providers/api";
import { addedProviders, providerNeed } from "./providers/logic";
import { ProvidersSection } from "./providers/ProvidersSection";
import { SpacesSection } from "./spaces/SpacesSection";
import { type Crumb, CrumbContext } from "./ui";

const CourseSettings = lazy(() => import("@/features/courses/CourseSettings").then((m) => ({ default: m.CourseSettings })));

/**
 * Settings is a page inside the shell (docs/UI-REBUILD.md › Settings, after
 * e0fb): the sidebar stays, the title bar says "Settings / section", a
 * grouped section list with status dots sits left of a centred column of
 * cards on a soft grey well. Esc, Back, ⌘, (Ctrl+, elsewhere), any view tab
 * and any sidebar row leave it.
 */

export const SECTIONS: { id: SettingsSection; label: string; icon: IconData; group: string }[] = [
  { id: "general", label: "General", icon: icons.mode, group: "Preferences" },
  { id: "appearance", label: "Appearance", icon: icons.appearance, group: "Preferences" },
  { id: "providers", label: "Providers", icon: icons.model, group: "Models" },
  { id: "agents", label: "Coding agents", icon: icons.terminal, group: "Models" },
  { id: "spaces", label: "Spaces", icon: icons.deck, group: "Workspace" },
  { id: "courses", label: "Courses", icon: icons.courses, group: "Workspace" },
  { id: "about", label: "About", icon: icons.info, group: "Phaethon" },
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

type Marker = { kind: "dot"; tone: "success" | "warning" | "info"; label: string } | { kind: "count"; text: string };

/**
 * The right-hand markers of the section list, like e0fb's channel dots:
 * whether a provider can answer, whether a coding agent is signed in, how many
 * spaces there are, whether an update is waiting. Read again whenever the
 * section changes, so a key saved a moment ago turns its dot green.
 */
function useMarkers(section: SettingsSection): Partial<Record<SettingsSection, Marker>> {
  const spaces = useNav((s) => s.spaces.data);
  const [markers, setMarkers] = useState<Partial<Record<SettingsSection, Marker>>>({});
  useEffect(() => {
    let live = true;
    const put = (id: SettingsSection, m: Marker | undefined) => live && setMarkers((ms) => ({ ...ms, [id]: m }));
    getSettings().then(
      (s) => {
        const ready = s.providerReady || addedProviders(s).some((p) => !providerNeed(p, s));
        put("providers", ready ? { kind: "dot", tone: "success", label: "A provider is ready" } : { kind: "dot", tone: "warning", label: "No provider is ready" });
      },
      () => put("providers", undefined),
    );
    cliStatuses().then(
      (c) => put("agents", c.some((x) => x.installed && x.loggedIn === true) ? { kind: "dot", tone: "success", label: "A coding agent is signed in" } : undefined),
      () => put("agents", undefined),
    );
    api.updateState().then(
      (u) => put("about", u.status.state === "available" ? { kind: "dot", tone: "info", label: "An update is available" } : undefined),
      () => put("about", undefined),
    );
    return () => {
      live = false;
    };
  }, [section]);
  return { ...markers, spaces: spaces?.length ? { kind: "count", text: String(spaces.length) } : undefined };
}

function MarkerView({ m }: { m: Marker | undefined }) {
  if (!m) return null;
  if (m.kind === "count") return <span className="ml-auto text-2xs text-subtle-foreground tabular-nums">{m.text}</span>;
  return (
    <span
      role="img"
      aria-label={m.label}
      className={cn("ml-auto size-1.5 shrink-0 rounded-full", m.tone === "success" ? "bg-success" : m.tone === "warning" ? "bg-warning" : "bg-primary")}
    />
  );
}

function Nav({ section, onReset }: { section: SettingsSection; onReset: () => void }) {
  const close = useNav((s) => s.closeSettings);
  const open = useNav((s) => s.openSettings);
  const markers = useMarkers(section);
  const groups = [...new Set(SECTIONS.map((s) => s.group))];
  return (
    <nav aria-label="Settings" className="flex w-64 shrink-0 flex-col overflow-y-auto border-r px-3 py-3 max-[1180px]:w-52">
      <button
        type="button"
        onClick={close}
        className="group flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground"
      >
        <Icon icon={icons.arrowLeft} className="size-4" />
        Back
        <Kbd className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">Esc</Kbd>
      </button>
      {groups.map((g) => (
        <div key={g} className="mt-4 flex flex-col gap-px">
          <h2 className="flex h-7 items-center px-2 text-subtle-foreground text-xs">{g}</h2>
          {SECTIONS.filter((s) => s.group === g).map((s) => {
            const active = s.id === section;
            return (
              <button
                key={s.id}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => (active ? onReset() : open(s.id))}
                className={cn(
                  "relative isolate flex h-7 items-center gap-2 rounded-md px-2 text-sm transition-colors",
                  active ? "text-foreground" : "text-foreground hover:bg-accent",
                )}
              >
                {active ? <motion.span layoutId="settings-nav" transition={{ type: "spring", stiffness: 480, damping: 38 }} className="absolute inset-0 -z-10 rounded-md bg-row-selected" /> : null}
                <Icon icon={s.icon} className={cn("size-4", active ? "text-foreground" : "text-muted-foreground")} />
                {s.label}
                <MarkerView m={markers[s.id]} />
              </button>
            );
          })}
        </div>
      ))}
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
  // Clicking the section you are in brings back its root view (a space's detail closes).
  const [reset, setReset] = useState(0);
  useEscToClose(close);
  const meta = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  const title = (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
      <span className="min-w-0 truncate text-muted-foreground">Settings</span>
      <span className="text-subtle-foreground">/</span>
      {crumb ? (
        <>
          <button type="button" onClick={crumb.onBack} className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
            {meta.label}
          </button>
          <span className="text-subtle-foreground">/</span>
          <span className="max-w-48 shrink-0 truncate font-medium">{crumb.label}</span>
        </>
      ) : (
        <h1 className="shrink-0 truncate font-medium">{meta.label}</h1>
      )}
    </span>
  );
  return (
    <div className="flex min-h-0 flex-1">
      <Header title={title} />
      <Nav section={section} onReset={() => setReset((n) => n + 1)} />
      <div className="relative min-h-0 flex-1 overflow-y-auto bg-well dark:bg-background">
        <DotMatrix seed="settings" />
        <motion.div
          key={`${section}-${reset}`}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="relative mx-auto flex w-full max-w-(--settings-max-width) flex-col gap-4 px-8 pt-12 pb-16"
        >
          <CrumbContext value={setCrumb}>
            <Body section={section} />
          </CrumbContext>
        </motion.div>
      </div>
    </div>
  );
}
