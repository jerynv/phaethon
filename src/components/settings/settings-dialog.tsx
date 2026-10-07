import { Dialog, Tabs } from "radix-ui";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

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
import { NavContext, StatusContext, type SectionId, type SettingsNav, type SettingsStatus } from "./status";

/** Opens Settings from anywhere: `window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section } }))`. */
export const OPEN_SETTINGS_EVENT = "phaethon:open-settings";
export type OpenSettingsDetail = { section?: SectionId };

const SECTIONS: { id: SectionId; label: string; icon: IconName }[] = [
  { id: "agent", label: "Agent", icon: "agent" },
  { id: "appearance", label: "Appearance", icon: "appearance" },
  { id: "accessibility", label: "Accessibility", icon: "accessibility" },
  { id: "spaces", label: "Spaces", icon: "space" },
  { id: "about", label: "About", icon: "info" },
];

/** The section shown when Settings opens: the last one used in this session. */
let lastSection: SectionId = "agent";

const isSection = (v: unknown): v is SectionId => SECTIONS.some((s) => s.id === v);

/** Somewhere focus can usefully go back to: still in the page, shown, and not disabled. */
function canTakeFocus(el: HTMLElement | null): el is HTMLElement {
  return (
    !!el &&
    el.isConnected &&
    el.getClientRects().length > 0 &&
    !el.closest("[hidden], [inert]") &&
    !(el as HTMLButtonElement).disabled
  );
}

/**
 * The settings window: a list of sections on the left, the chosen section on
 * the right (the macOS System Settings pattern). A modal Radix dialog: Escape
 * closes it and focus returns to the trigger. Sections are a vertical tab
 * list: Up/Down move between them, Tab moves into the page.
 *
 * Other parts of the app open it on a section with the OPEN_SETTINGS_EVENT
 * window event; closing it then returns focus to whatever had focus before
 * (or the composer, if that is gone or hidden).
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
  // Kept apart from `error`: choosing a section or dismissing a banner must not
  // hide that the settings never loaded (the Agent page shows it, with Try again).
  const [loadError, setLoadError] = useState("");
  const descId = useId();
  const ids = useMemo(() => Object.fromEntries(SECTIONS.map((s) => [s.id, `settings-${s.id}-heading`])) as Record<SectionId, string>, []);
  const save = useSaveState();
  const isOpen = useRef(false);
  isOpen.current = open;
  /** Where focus goes on close when the window was opened by the event. */
  const returnTo = useRef<HTMLElement | null | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setSettings(await getSettings());
      setLoadError("");
      return true;
    } catch (e) {
      // The core's own text; the Agent page puts it in plain words (LoadProblem).
      setLoadError(String(e));
      return false;
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setStatus("");
    setError("");
    setLoadError("");
    void load();
  }, [open, load]);

  useEffect(() => {
    function onOpenRequest(e: Event) {
      const wanted = (e as CustomEvent<OpenSettingsDetail | undefined>).detail?.section;
      if (!isOpen.current) {
        const active = document.activeElement;
        returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null;
      }
      if (isSection(wanted)) {
        lastSection = wanted;
        setSection(wanted);
      }
      setOpen(true);
    }
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpenRequest);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenRequest);
  }, []);

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
    async (work: () => Promise<void>, done: string, onError?: (message: string) => void, reloadThread = false) => {
      setError("");
      setStatus("");
      try {
        await work();
      } catch (e) {
        // A field that can show its own error (the API key) gets it there.
        if (onError) onError(String(e));
        else setError(String(e));
        return false;
      }
      statusApi.say(done);
      // Only a backend switch changes which conversation a space shows. Saving a
      // key must not reload the thread: a message that just failed for want of a
      // key, and its Send again, have to survive so the user can resend it.
      if (reloadThread) onChanged();
      // The change is made; a failed reload is a load problem, not a failed change.
      await load();
      return true;
    },
    [onChanged, statusApi, load],
  );

  function onOpenChange(next: boolean) {
    if (!next) void flushAppearance();
    setOpen(next);
  }

  const choose = useCallback((id: string) => {
    if (!isSection(id)) return;
    lastSection = id;
    setSection(id);
    setError("");
  }, []);

  const nav: SettingsNav = useMemo(
    () => ({
      go: (id, focus) => {
        choose(id);
        // The new page mounts on the next render; focus once it has painted.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const heading = document.getElementById(ids[id]);
            const panel = heading?.closest<HTMLElement>('[role="tabpanel"]');
            const target = (focus && panel?.querySelector<HTMLElement>(focus)) || heading;
            target?.scrollIntoView({ block: "center" });
            target?.focus();
          }),
        );
      },
    }),
    [choose, ids],
  );

  function onCloseAutoFocus(e: Event) {
    const target = returnTo.current;
    if (target === undefined) return; // opened by its own button: Radix returns focus there
    returnTo.current = undefined;
    e.preventDefault();
    // The composer of the space on screen (other spaces stay mounted, hidden).
    const fallback =
      document.querySelector<HTMLElement>("[data-space-pane][data-shown] [data-composer-input]") ??
      document.querySelector<HTMLElement>("[data-composer-input]");
    (canTakeFocus(target) ? target : fallback)?.focus();
  }

  const pages: Record<SectionId, ReactNode> = {
    agent: <AgentSection headingId={ids.agent} settings={settings} loadError={loadError} retryLoad={load} act={act} />,
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
          onCloseAutoFocus={onCloseAutoFocus}
          // Escape in a field with unsaved text (Settings > Spaces) undoes that edit instead of closing.
          onEscapeKeyDown={(e) => {
            if (document.activeElement instanceof HTMLElement && document.activeElement.dataset.dirty !== undefined) e.preventDefault();
          }}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex h-(--ph-settings-height) w-(--ph-settings-width) -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-line bg-bg text-ink shadow-lg outline-none",
            "duration-(--ph-duration) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]",
          )}
        >
          <StatusContext.Provider value={statusApi}>
            <NavContext.Provider value={nav}>
              <Tabs.Root
                value={section}
                onValueChange={choose}
                orientation="vertical"
                className="flex min-w-0 flex-1 max-md:flex-col"
              >
                {/* Below 768 px the section list sits above the page and wraps, so no section hides off-screen. */}
                <div className="flex w-(--ph-settings-nav-width) shrink-0 flex-col border-r border-line bg-surface max-md:w-full max-md:border-r-0 max-md:border-b">
                  <Dialog.Title className="px-5 pt-5 pb-3 text-lg font-semibold text-ink max-md:pe-(--ph-settings-close-room) max-md:pb-2">Settings</Dialog.Title>
                  <Tabs.List aria-label="Settings sections" className="flex flex-col gap-0.5 px-2.5 max-md:flex-row max-md:flex-wrap max-md:pb-2">
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
                  <div className="mt-auto flex flex-col gap-1.5 px-5 pt-4 pb-5 text-sm text-ink-secondary max-md:hidden">
                    <Dialog.Description id={descId}>Changes apply as you make them and are saved in this vault.</Dialog.Description>
                    <SaveIndicator />
                  </div>
                </div>

                <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                  {error && (
                    <div role="alert" className="ms-8 me-(--ph-settings-close-room) mt-5 flex max-md:me-8 items-start gap-2 rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger-ink">
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
                      // A tab stop (Radix), so the page scrolls by keyboard. Its ring is drawn inside
                      // the panel: outside, the nav border and the window's rounded edge clip it.
                      className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:[outline-offset:calc(-1*(var(--ph-focus-width)+var(--ph-focus-offset)))]! data-[state=inactive]:hidden"
                    >
                      {/* Starts below the Close button, so a page's Reset never sits under it. */}
                      <div className="mx-auto flex max-w-(--ph-settings-content-width) flex-col gap-7 px-8 pt-(--ph-settings-close-room) pb-10 max-md:pt-6">
                        {pages[s.id]}
                      </div>
                    </Tabs.Content>
                  ))}
                </div>
              </Tabs.Root>

              <p role="status" className="sr-only">
                {status}
              </p>
            </NavContext.Provider>

            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close settings" className="absolute top-(--ph-settings-close-inset) right-(--ph-settings-close-inset) min-h-(--ph-target-min) min-w-(--ph-target-min) text-ink-secondary hover:text-ink">
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
