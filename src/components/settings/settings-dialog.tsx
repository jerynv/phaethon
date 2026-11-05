import { Dialog, Tabs } from "radix-ui";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { DialogSurface, SettingsLayout } from "vic-ui";

import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/icons";
import { getSettings, type Settings } from "@/lib/backend";
import { commitPendingRevokes } from "@/lib/grants";
import { cn } from "@/lib/utils";
import { flushAppearance, useSaveState } from "@/theme";

import { AboutSection } from "./about-section";
import { AccessibilitySection } from "./accessibility-section";
import { AgentSection, type AgentFocusRequest } from "./agent-section";
import { AppearanceSection } from "./appearance-section";
import { CoursesSection } from "./courses-section";
import { SpacesSection } from "./spaces-section";
import { UsageDialog } from "./usage-dialog";
import { NavContext, StatusContext, type SectionId, type SettingsNav, type SettingsStatus } from "./status";

/** Opens Settings from anywhere: `window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section } }))`. */
export const OPEN_SETTINGS_EVENT = "phaethon:open-settings";
/** `focus`: a field to land on ("key" is the default when opening on the Assistant page, since that comes from a key error). */
/** `space`: on the Spaces page, open that space's details and focus its name. */
export type OpenSettingsDetail = { section?: SectionId; focus?: FocusTarget; space?: string };
type FocusTarget = "key" | "model" | "heading";
const FOCUS_SELECTOR: Record<Exclude<FocusTarget, "heading">, string> = { key: "[data-key-input]", model: "[data-model-select]" };

const SECTIONS: { id: SectionId; label: string; icon: IconName }[] = [
  { id: "agent", label: "Providers", icon: "agent" },
  { id: "appearance", label: "Appearance", icon: "appearance" },
  { id: "accessibility", label: "Accessibility", icon: "accessibility" },
  { id: "spaces", label: "Spaces", icon: "space" },
  { id: "courses", label: "Course sites", icon: "book" },
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

/** A transient sidebar/title-bar control; the event listener remains in the app shell. */
export function SettingsButton(props: ComponentProps<typeof Button>) {
  return <Button variant="ghost" size="icon-sm" aria-label="Settings" title="Settings" data-testid="open-settings"
    className="text-ink-secondary hover:text-ink data-[state=open]:bg-selected data-[state=open]:text-ink"
    onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT))} {...props}>
    <Icon name="settings" /><span className="sr-only">Settings</span>
  </Button>;
}

/**
 * The settings window: a list of sections on the left, the chosen section on
 * the right, bounded above the workspace. A modal Radix dialog: Escape
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
export function SettingsDialog({ onChanged, showTrigger = true }: { onChanged: () => void; showTrigger?: boolean }) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SectionId>(lastSection);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [providerBusy, setProviderBusy] = useState(false);
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
  /** A field to focus once the page has it (the key field after a key error). */
  const pendingFocus = useRef<string | null>(null);
  const [agentFocusRequest, setAgentFocusRequest] = useState<AgentFocusRequest | null>(null);
  const agentFocusSequence = useRef(0);
  /** A space whose details Settings › Spaces opens (the sidebar's Edit name and colour…); `n` makes a repeat a new request. */
  const [editSpace, setEditSpace] = useState<{ id: string; n: number } | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  /** Background elements this window made inert, to restore on close. */
  const madeInert = useRef<HTMLElement[]>([]);

  /**
   * On mount of the window: make everything behind it inert (no focus, no
   * pointer, hidden from screen readers' virtual cursor; Radix only sets
   * aria-hidden, which VoiceOver's cursor and live regions ignore). On unmount,
   * restore those elements.
   */
  const contentRef = useCallback((node: HTMLDivElement | null) => {
    content.current = node;
    if (node) {
      for (const el of Array.from(document.body.children)) {
        if (!(el instanceof HTMLElement) || el.contains(node) || el.tagName === "SCRIPT" || el.inert) continue;
        el.inert = true;
        madeInert.current.push(el);
      }
    } else {
      for (const el of madeInert.current) el.inert = false;
      madeInert.current = [];
    }
  }, []);

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
    // A request to open a space's details is for that opening only.
    if (!open) {
      setEditSpace(null);
      setAgentFocusRequest(null);
    }
    if (!open) return;
    setStatus("");
    setError("");
    setLoadError("");
    void load();
  }, [open, load]);

  /** Focus the field asked for, once its page has rendered it (the key field needs the settings loaded). */
  function focusPending() {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const sel = pendingFocus.current;
        const el = sel ? content.current?.querySelector<HTMLElement>(sel) : null;
        if (!el) return; // not there yet: the settings effect below tries again
        pendingFocus.current = null;
        el.scrollIntoView({ block: "center" });
        el.focus();
      }),
    );
  }

  useEffect(() => {
    if (open && settings && pendingFocus.current) focusPending();
  }, [open, settings]);

  function onOpenAutoFocus(e: Event) {
    if (agentFocusRequest && section === "agent") {
      e.preventDefault();
      if (!settings) document.getElementById(ids.agent)?.focus();
      return;
    }
    if (!pendingFocus.current) return; // Radix focuses the first control
    // Until the field exists, the page heading holds focus (inside the window, never behind it).
    e.preventDefault();
    document.getElementById(ids[section])?.focus();
    focusPending();
  }

  useEffect(() => {
    function onOpenRequest(e: Event) {
      const detail = (e as CustomEvent<OpenSettingsDetail | undefined>).detail;
      const wanted = detail?.section;
      if (!isOpen.current) {
        const active = document.activeElement;
        returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null;
      }
      if (isSection(wanted)) {
        lastSection = wanted;
        setSection(wanted);
      }
      // Opened on the Assistant page by a key error: land on the key field itself.
      const focus = detail?.focus ?? (wanted === "agent" ? "key" : undefined);
      if ((wanted === "agent" || wanted === undefined) && focus && focus !== "heading") {
        if (wanted === undefined) {
          lastSection = "agent";
          setSection("agent");
        }
        setAgentFocusRequest({ target: focus, n: ++agentFocusSequence.current, closeSettingsOnClose: !isOpen.current });
        pendingFocus.current = null;
      } else {
        setAgentFocusRequest(null);
        pendingFocus.current = focus && focus !== "heading" ? FOCUS_SELECTOR[focus] : null;
      }
      // A space's Edit name and colour…: its details open and its name field takes focus.
      const space = detail?.space;
      if (wanted === "spaces" && space) {
        setEditSpace((e) => ({ id: space, n: (e?.n ?? 0) + 1 }));
        pendingFocus.current = `[data-space-row="${CSS.escape(space)}"] [data-space-field="name"]`;
      }
      if (isOpen.current) focusPending();
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
    if (!next && providerBusy) return;
    if (!next) {
      void flushAppearance();
      // A Remove in Settings › Spaces offers Undo until the window closes.
      commitPendingRevokes();
    }
    setOpen(next);
  }

  const choose = useCallback((id: string) => {
    if (providerBusy || !isSection(id)) return;
    setAgentFocusRequest(null);
    lastSection = id;
    setSection(id);
    setError("");
  }, [providerBusy]);

  const nav: SettingsNav = useMemo(
    () => ({
      go: (id, focus) => {
        choose(id);
        if (id === "agent" && (focus === FOCUS_SELECTOR.key || focus === FOCUS_SELECTOR.model)) {
          setAgentFocusRequest({ target: focus === FOCUS_SELECTOR.key ? "key" : "model", n: ++agentFocusSequence.current, closeSettingsOnClose: false });
          return;
        }
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

  function onRequestedProviderClose(n: number) {
    if (agentFocusRequest?.n !== n) return;
    setAgentFocusRequest(null);
    if (agentFocusRequest.closeSettingsOnClose) onOpenChange(false);
  }

  const pages: Record<SectionId, ReactNode> = {
    agent: <AgentSection headingId={ids.agent} settings={settings} loadError={loadError} retryLoad={load} act={act} focusRequest={agentFocusRequest} onRequestedProviderClose={onRequestedProviderClose} onBusyChange={setProviderBusy} />,
    appearance: <AppearanceSection headingId={ids.appearance} />,
    accessibility: <AccessibilitySection headingId={ids.accessibility} />,
    spaces: <SpacesSection headingId={ids.spaces} editSpace={editSpace} />,
    courses: <CoursesSection headingId={ids.courses} />,
    about: <AboutSection headingId={ids.about} settings={settings} />,
  };

  return (
    <>
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {showTrigger && <Dialog.Trigger asChild><SettingsButton /></Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-(--ph-overlay) duration-(--ph-duration) data-[state=closed]:pointer-events-none! data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogSurface asChild><Dialog.Content
          ref={contentRef}
          aria-describedby={descId}
          // Radix hides the background with aria-hidden only; say it is modal too.
          aria-modal="true"
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          // Only Escape and Close close it: a click just outside (a tremor, a missed target) does nothing.
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          // Escape in a field with unsaved text (Settings > Spaces) undoes that edit instead of closing.
          onEscapeKeyDown={(e) => {
            if (providerBusy || (document.activeElement instanceof HTMLElement && document.activeElement.dataset.dirty !== undefined)) e.preventDefault();
          }}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 m-0! flex flex-col h-[min(var(--ph-settings-height),calc(100dvh-48px))] max-h-none! w-[min(var(--ph-settings-width),calc(100%-48px))] -translate-x-1/2 -translate-y-1/2 overflow-clip p-0! text-ink outline-none max-sm:h-[min(var(--ph-settings-height),calc(100dvh-32px))] max-sm:w-[calc(100%-32px)]",
            "duration-(--ph-duration) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
          )}
        >
          <StatusContext.Provider value={statusApi}>
            <NavContext.Provider value={nav}>
              {/* T3 Code's settings route keeps its header and Close outside the scrollable page. */}
              <header data-settings-header="" className="flex h-12 shrink-0 items-center gap-3 border-b border-line ps-5 pe-2">
                <Dialog.Title className="text-base font-semibold text-ink">Settings</Dialog.Title>
                <span aria-hidden="true" className="text-ink-tertiary">/</span>
                <span className="min-w-0 truncate text-sm text-ink-secondary">{SECTIONS.find((s) => s.id === section)?.label}</span>
                <div className="ms-auto flex shrink-0 items-center gap-3 text-xs text-ink-secondary">
                  <span className="max-sm:hidden"><SaveIndicator /></span>
                  <Dialog.Close asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="Close settings" disabled={providerBusy} title="Close settings (Escape)" className="text-ink-secondary hover:text-ink"><Icon name="close" /></Button>
                  </Dialog.Close>
                </div>
              </header>
              <Dialog.Description id={descId} className="sr-only">Application preferences and workspace settings.</Dialog.Description>
              <Tabs.Root
                value={section}
                onValueChange={choose}
                orientation="vertical"
                className="flex min-h-0 min-w-0 flex-1 max-md:flex-col"
              >
                {/* Below 768 px the section list sits above the page and wraps, so no section hides off-screen.
                    It is kept compact there (title beside the tabs, no icons, shorter tabs), so at a large
                    text size the page keeps most of the height. */}
                <SettingsLayout className="ph-settings-layout" navigationLabel="Settings sections" navigation={
                  <Tabs.List aria-label="Settings sections" className="flex flex-col gap-0.5 px-2">
                    {SECTIONS.map((s) => (
                      <Tabs.Trigger
                        key={s.id}
                        disabled={providerBusy}
                        value={s.id}
                        data-testid={`settings-tab-${s.id}`}
                        // Radix activates on mousedown; click also covers pointer tools that send only clicks.
                        onClick={() => choose(s.id)}
                        className={cn(
                          "flex min-h-(--ph-control-height) shrink-0 items-center gap-2.5 rounded-md px-2 text-start text-sm font-normal text-ink-secondary transition-colors duration-(--ph-duration-fast)",
                          "hover:bg-hover hover:text-ink",
                          "data-[state=active]:bg-selected data-[state=active]:font-medium data-[state=active]:text-ink",
                        )}
                      >
                        <Icon name={s.icon} className="size-(--ph-icon-size-sm)" />
                        {s.label}
                      </Tabs.Trigger>
                    ))}
                  </Tabs.List>
                }>


                <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                  {error && (
                    <div role="alert" className="mx-5 mt-4 flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger-ink">
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
                      // A tab stop (Radix), so the page scrolls by keyboard. Keep its ring inside the panel.
                      className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] outline-none focus-visible:[outline-offset:calc(-1*(var(--ph-focus-width)+var(--ph-focus-offset)))]! data-[state=inactive]:hidden"
                    >
                      <div className="flex w-full max-w-(--ph-settings-content-width) flex-col gap-5 px-6 pt-6 pb-6 max-sm:px-4 max-sm:pt-4">
                        {pages[s.id]}
                      </div>
                    </Tabs.Content>
                  ))}
                </div>
                </SettingsLayout>
              </Tabs.Root>

              <p role="status" className="sr-only">
                {status}
              </p>
            </NavContext.Provider>

          </StatusContext.Provider>
        </Dialog.Content></DialogSurface>
      </Dialog.Portal>
    </Dialog.Root>
    <UsageDialog />
    </>
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
