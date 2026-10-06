import { Dialog, Tabs } from "radix-ui";
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/icons";
import { getSettings, type Settings } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { flushAppearance, useSaveState } from "@/theme";

import { AboutSection } from "./about-section";
import { AccessibilitySection } from "./accessibility-section";
import { AgentSection } from "./agent-section";
import { AppearanceSection } from "./appearance-section";
import { SpacesSection } from "./spaces-section";
import { StatusContext, type SettingsStatus } from "./status";

type SectionId = "agent" | "appearance" | "accessibility" | "spaces" | "about";

const SECTIONS: { id: SectionId; label: string; icon: IconName }[] = [
  { id: "agent", label: "Agent", icon: "agent" },
  { id: "appearance", label: "Appearance", icon: "appearance" },
  { id: "accessibility", label: "Accessibility", icon: "accessibility" },
  { id: "spaces", label: "Spaces", icon: "space" },
  { id: "about", label: "About", icon: "info" },
];

/** The section shown when Settings opens: the last one used in this session. */
let lastSection: SectionId = "agent";

/**
 * The settings window: a list of sections on the left, the chosen section on
 * the right (the macOS System Settings pattern). A modal Radix dialog: Escape
 * closes it and focus returns to the trigger. Sections are a vertical tab
 * list: Up/Down move between them, Tab moves into the page.
 *
 * Appearance and accessibility changes apply as they are made and save to the
 * vault after a short pause (src/theme). Agent changes save at once.
 */
export function SettingsDialog({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SectionId>(lastSection);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const descId = useId();
  const ids = useMemo(() => Object.fromEntries(SECTIONS.map((s) => [s.id, `settings-${s.id}-heading`])) as Record<SectionId, string>, []);
  const save = useSaveState();

  useEffect(() => {
    if (!open) return;
    setStatus("");
    setError("");
    getSettings().then(setSettings, (e: unknown) => setError(`Could not load your settings: ${String(e)}`));
  }, [open]);

  // An appearance save that failed is an error the person must hear about.
  useEffect(() => {
    if (save.status === "error") setError(`Your appearance changes are showing but were not saved: ${save.error}`);
  }, [save]);

  const statusApi: SettingsStatus = useMemo(
    () => ({
      say: (m) => {
        setError("");
        // Clear first so the same message twice is announced twice.
        setStatus("");
        requestAnimationFrame(() => setStatus(m));
      },
      fail: (m) => setError(m),
    }),
    [],
  );

  const act = useCallback(
    async (work: () => Promise<void>, done: string) => {
      setError("");
      setStatus("");
      try {
        await work();
        setSettings(await getSettings());
        statusApi.say(done);
        onChanged();
        return true;
      } catch (e) {
        setError(String(e));
        return false;
      }
    },
    [onChanged, statusApi],
  );

  function onOpenChange(next: boolean) {
    if (!next) void flushAppearance();
    setOpen(next);
  }

  function choose(id: string) {
    lastSection = id as SectionId;
    setSection(id as SectionId);
    setError("");
  }

  const pages: Record<SectionId, ReactNode> = {
    agent: <AgentSection headingId={ids.agent} settings={settings} act={act} />,
    appearance: <AppearanceSection headingId={ids.appearance} />,
    accessibility: <AccessibilitySection headingId={ids.accessibility} />,
    spaces: <SpacesSection headingId={ids.spaces} />,
    about: <AboutSection headingId={ids.about} settings={settings} />,
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>
        <Button
          variant="ghost"
          data-testid="open-settings"
          className="h-auto min-h-(--ph-control-height-lg) w-full justify-start gap-2.5 px-2.5 text-base font-normal text-ink-secondary hover:text-ink data-[state=open]:bg-selected data-[state=open]:text-ink"
        >
          <Icon name="settings" />
          Settings
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-(--ph-overlay) duration-(--ph-duration) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={descId}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex h-(--ph-settings-height) w-(--ph-settings-width) -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-line bg-bg text-ink shadow-lg outline-none",
            "duration-(--ph-duration) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]",
          )}
        >
          <StatusContext.Provider value={statusApi}>
            <Tabs.Root
              value={section}
              onValueChange={choose}
              orientation="vertical"
              className="flex min-w-0 flex-1 max-sm:flex-col"
            >
              <div className="flex w-(--ph-settings-nav-width) shrink-0 flex-col border-r border-line bg-surface max-sm:w-full max-sm:border-r-0 max-sm:border-b">
                <Dialog.Title className="px-5 pt-5 pb-3 text-lg font-semibold text-ink max-sm:pb-2">Settings</Dialog.Title>
                <Tabs.List aria-label="Settings sections" className="flex flex-col gap-0.5 px-2.5 max-sm:flex-row max-sm:overflow-x-auto max-sm:pb-2">
                  {SECTIONS.map((s) => (
                    <Tabs.Trigger
                      key={s.id}
                      value={s.id}
                      data-testid={`settings-tab-${s.id}`}
                      // Radix activates on mousedown; click also covers pointer tools that send only clicks.
                      onClick={() => choose(s.id)}
                      className={cn(
                        "flex min-h-(--ph-control-height-lg) shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left text-base text-ink-secondary transition-colors duration-(--ph-duration-fast)",
                        "hover:bg-hover hover:text-ink",
                        "data-[state=active]:bg-selected data-[state=active]:font-medium data-[state=active]:text-ink data-[state=active]:[&_svg]:text-accent-ink",
                      )}
                    >
                      <Icon name={s.icon} />
                      {s.label}
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>
                <div className="mt-auto flex flex-col gap-1.5 px-5 pt-4 pb-5 text-sm text-ink-secondary max-sm:hidden">
                  <Dialog.Description id={descId}>Changes apply as you make them and are saved in this vault.</Dialog.Description>
                  <SaveIndicator />
                </div>
              </div>

              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                {error && (
                  <div role="alert" className="mx-8 mt-5 flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger-ink">
                    <Icon name="error" className="mt-0.5" />
                    <span className="min-w-0 flex-1">{error}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Dismiss error"
                      onClick={() => setError("")}
                      className="-my-0.5 min-h-(--ph-target-min) min-w-(--ph-target-min) text-danger-ink"
                    >
                      <Icon name="close" />
                    </Button>
                  </div>
                )}
                {SECTIONS.map((s) => (
                  <Tabs.Content
                    key={s.id}
                    value={s.id}
                    aria-labelledby={ids[s.id]}
                    className="min-h-0 flex-1 overflow-y-auto outline-none data-[state=inactive]:hidden"
                  >
                    <div className="mx-auto flex max-w-(--ph-settings-content-width) flex-col gap-7 px-8 pt-6 pb-10">{pages[s.id]}</div>
                  </Tabs.Content>
                ))}
              </div>
            </Tabs.Root>

            <p role="status" className="sr-only">
              {status}
            </p>

            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close settings" className="absolute top-3 right-3 min-h-(--ph-target-min) min-w-(--ph-target-min) text-ink-secondary hover:text-ink">
                <Icon name="close" />
              </Button>
            </Dialog.Close>
          </StatusContext.Provider>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Quiet, visible save state. Not a live region: sliders already speak their values. */
function SaveIndicator() {
  const save = useSaveState();
  const text =
    save.status === "saving" ? "Saving…" : save.status === "saved" ? "All changes saved." : save.status === "error" ? "Not saved. See the message on the right." : "";
  if (!text) return null;
  return (
    <p className={cn("flex items-center gap-1.5", save.status === "error" && "text-danger-ink")}>
      <Icon name={save.status === "error" ? "warning" : "check"} className="size-(--ph-icon-size-sm)" />
      {text}
    </p>
  );
}
