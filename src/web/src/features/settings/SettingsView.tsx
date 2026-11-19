import { lazy, Suspense, useEffect, useState } from "react";
import { motion } from "motion/react";
import { api } from "@/app/api";
import { HeaderTitle } from "@/app/Header";
import { type SettingsSection, useNav } from "@/app/store";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { RowHighlightGroup } from "@/components/ui/row-highlight";
import { cn } from "@/lib/utils";
import { PrivacySection } from "@/features/telemetry/Privacy";
import { AboutSection } from "./AboutSection";
import { cliStatuses } from "./agents/api";
import { AppearanceSection } from "./AppearanceSection";
import { GeneralSection } from "./GeneralSection";
import { ModelsSection } from "./models/ModelsSection";
import { getSettings, SETTINGS_CHANGED_EVENT } from "./providers/api";
import { addedProviders, providerNeed } from "./providers/logic";
import { SpacesSection } from "./spaces/SpacesSection";
import { type Crumb, CrumbContext } from "./ui";

const CourseSettings = lazy(() => import("@/features/courses/CourseSettings").then((m) => ({ default: m.CourseSettings })));
const NotificationsSection = lazy(() => import("./NotificationsSection").then((m) => ({ default: m.NotificationsSection })));
const MemorySection = lazy(() => import("./life/MemorySection").then((m) => ({ default: m.MemorySection })));
const PeopleSection = lazy(() => import("./life/PeopleSection").then((m) => ({ default: m.PeopleSection })));
const MailSection = lazy(() => import("./life/MailSection").then((m) => ({ default: m.MailSection })));
const AutomationsSection = lazy(() => import("./life/AutomationsSection").then((m) => ({ default: m.AutomationsSection })));

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
  { id: "notifications", label: "Notifications", icon: icons.notifications, group: "Preferences" },
  { id: "models", label: "AI & Models", icon: icons.model, group: "Models" },
  { id: "spaces", label: "Spaces", icon: icons.deck, group: "Workspace" },
  { id: "courses", label: "Courses", icon: icons.courses, group: "Workspace" },
  { id: "memory", label: "Memory", icon: icons.memory, group: "You" },
  { id: "people", label: "People", icon: icons.people, group: "You" },
  { id: "mail", label: "Mail & connectors", icon: icons.mail, group: "You" },
  { id: "automations", label: "Automations", icon: icons.automation, group: "You" },
  { id: "privacy", label: "Privacy", icon: icons.locked, group: "Phaethon" },
  { id: "about", label: "About", icon: icons.info, group: "Phaethon" },
];

type Marker = { kind: "dot"; tone: "success" | "warning" | "info"; label: string } | { kind: "count"; text: string };

/**
 * The right-hand markers of the section list, like e0fb's channel dots:
 * whether any AI model (provider or subscription) is ready, how many spaces
 * there are, whether an update is waiting. Read again whenever the section
 * or model settings change, so a key saved or sign-in completed turns its dot green.
 */
function useMarkers(section: SettingsSection): Partial<Record<SettingsSection, Marker>> {
  const spaces = useNav((s) => s.spaces.data);
  const [markers, setMarkers] = useState<Partial<Record<SettingsSection, Marker>>>({});
  const [rev, setRev] = useState(0);
  useEffect(() => {
    const onChanged = () => setRev((n) => n + 1);
    window.addEventListener(SETTINGS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onChanged);
  }, []);
  useEffect(() => {
    let live = true;
    const put = (id: SettingsSection, m: Marker | undefined) => live && setMarkers((ms) => ({ ...ms, [id]: m }));
    Promise.all([getSettings().catch(() => null), cliStatuses().catch(() => null)]).then(([s, c]) => {
      if (!s && !c) return put("models", undefined);
      const providerReady = !!s && (s.providerReady || addedProviders(s).some((p) => !providerNeed(p, s)));
      const agentReady = !!c && c.some((x) => x.installed && x.loggedIn === true);
      put(
        "models",
        providerReady || agentReady
          ? { kind: "dot", tone: "success", label: "An AI model is ready" }
          : { kind: "dot", tone: "warning", label: "Set up an AI model" },
      );
    });
    api.updateState().then(
      (u) => put("about", u.status.state === "available" ? { kind: "dot", tone: "info", label: "An update is available" } : undefined),
      () => put("about", undefined),
    );
    return () => {
      live = false;
    };
  }, [section, rev]);
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
    <nav aria-label="Settings" className="hidden w-52 shrink-0 flex-col overflow-y-auto border-r px-3 pt-(--pane-top) pb-3 @2xl/settings:flex @5xl/settings:w-64">
      <button
        type="button"
        onClick={close}
        className="group flex h-(--pane-row-height) shrink-0 items-center gap-2 rounded-md px-2 text-muted-foreground text-sm outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon icon={icons.arrowLeft} className="size-4" />
        Back
        <Kbd aria-hidden="true" className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          Esc
        </Kbd>
      </button>
      <RowHighlightGroup className="flex flex-col">
        {groups.map((g) => {
          const groupId = `settings-group-${g.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
          return (
            <div key={g} role="group" aria-labelledby={groupId} className="mt-4 flex flex-col gap-px">
              <h2 id={groupId} className="flex h-7 items-center px-2 type-label">
                {g}
              </h2>
              {SECTIONS.filter((s) => s.group === g).map((s) => {
                const active = s.id === section;
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-current={active ? "page" : undefined}
                    data-glide=""
                    data-active={active || undefined}
                    onClick={() => (active ? onReset() : open(s.id))}
                    className={cn(
                      "flex h-7 items-center gap-2 rounded-md px-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      active ? "text-foreground" : "text-foreground hover:bg-accent",
                    )}
                  >
                    <Icon icon={s.icon} className={cn("size-4", active ? "text-foreground" : "text-muted-foreground")} />
                    {s.label}
                    <MarkerView m={markers[s.id]} />
                  </button>
                );
              })}
            </div>
          );
        })}
      </RowHighlightGroup>
    </nav>
  );
}

/**
 * Settings too narrow for its nav column: Back, and the section on show as a
 * menu of every section, in the nav's groups, above the section.
 */
function SectionBar({ section, onReset }: { section: SettingsSection; onReset: () => void }) {
  const close = useNav((s) => s.closeSettings);
  const open = useNav((s) => s.openSettings);
  const markers = useMarkers(section);
  const groups = [...new Set(SECTIONS.map((s) => s.group))];
  const meta = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  return (
    <nav aria-label="Settings" className="flex items-center gap-1 @2xl/settings:hidden">
      <Button size="icon-sm" variant="ghost-muted" aria-label="Back" onClick={close}>
        <Icon icon={icons.arrowLeft} />
      </Button>
      <Menu>
        <MenuTrigger render={<Button size="sm" variant="ghost" className="min-w-0 gap-2 px-2" />}>
          <Icon icon={meta.icon} className="text-muted-foreground" />
          <span className="truncate">{meta.label}</span>
          <Icon icon={icons.chevronsUpDown} className="text-muted-foreground" />
        </MenuTrigger>
        <MenuPopup align="start" className="w-56">
          {groups.map((g, i) => (
            <div key={g}>
              {i > 0 ? <MenuSeparator /> : null}
              <MenuGroup>
                <MenuGroupLabel>{g}</MenuGroupLabel>
                {SECTIONS.filter((s) => s.group === g).map((s) => (
                  <MenuItem key={s.id} aria-current={s.id === section ? "page" : undefined} onClick={() => (s.id === section ? onReset() : open(s.id))}>
                    <Icon icon={s.icon} />
                    <span className={cn("flex-1", s.id === section && "font-medium")}>{s.label}</span>
                    <MarkerView m={markers[s.id]} />
                  </MenuItem>
                ))}
              </MenuGroup>
            </div>
          ))}
        </MenuPopup>
      </Menu>
    </nav>
  );
}

function Body({ section }: { section: SettingsSection }) {
  switch (section) {
    case "privacy":
      return <PrivacySection />;
    case "general":
      return <GeneralSection />;
    case "models":
    case "providers":
    case "agents":
      return <ModelsSection />;
    case "spaces":
      return <SpacesSection />;
    case "courses":
      return (
        <Suspense fallback={null}>
          <CourseSettings />
        </Suspense>
      );
    case "notifications":
      return (
        <Suspense fallback={null}>
          <NotificationsSection />
        </Suspense>
      );
    case "memory":
    case "people":
    case "mail":
    case "automations": {
      const S = { memory: MemorySection, people: PeopleSection, mail: MailSection, automations: AutomationsSection }[section];
      return (
        <Suspense fallback={null}>
          <S />
        </Suspense>
      );
    }
    case "appearance":
      return <AppearanceSection />;
    case "about":
      return <AboutSection />;
  }
}

export function SettingsView() {
  const rawSection = useNav((s) => s.settings) ?? "general";
  const section: SettingsSection = rawSection === "providers" || rawSection === "agents" ? "models" : rawSection;
  const [crumb, setCrumb] = useState<Crumb>(null);
  // Clicking the section you are in brings back its root view (a space's detail closes).
  const [reset, setReset] = useState(0);
  const meta = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  const title = (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center">
      <ol className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
        <li className="flex min-w-0 items-center gap-1.5">
          <Icon icon={icons.settings} className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-muted-foreground">Settings</span>
        </li>
        <li aria-hidden="true" className="select-none text-subtle-foreground">
          /
        </li>
        {crumb ? (
          <>
            <li className="flex shrink-0 items-center">
              <button
                type="button"
                onClick={crumb.onBack}
                className="rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {meta.label}
              </button>
            </li>
            <li aria-hidden="true" className="select-none text-subtle-foreground">
              /
            </li>
            <li aria-current="page" className="min-w-0 max-w-48">
              <h1 className="truncate font-medium">{crumb.label}</h1>
            </li>
          </>
        ) : (
          <li aria-current="page" className="min-w-0">
            <h1 className="truncate font-medium">{meta.label}</h1>
          </li>
        )}
      </ol>
    </nav>
  );
  return (
    <div className="@container/settings flex min-h-0 flex-1">
      <HeaderTitle>{title}</HeaderTitle>
      <Nav section={section} onReset={() => setReset((n) => n + 1)} />
      <div className="page-scroll relative min-h-0 flex-1">
        <motion.div
          key={`${section}-${reset}`}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="relative mx-auto flex w-full max-w-(--settings-max-width) flex-col gap-6 px-4 pt-3 pb-12 @2xl/settings:px-8 @2xl/settings:pt-8"
        >
          <SectionBar section={section} onReset={() => setReset((n) => n + 1)} />
          <CrumbContext value={setCrumb}>
            <Body section={section} />
          </CrumbContext>
        </motion.div>
      </div>
    </div>
  );
}
