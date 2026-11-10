import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { BotIcon, InfoIcon, LayersIcon, LibraryBigIcon, PaletteIcon, TerminalIcon, XIcon, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { useNav, type SettingsSection } from "@/app/nav";
import { useCurrentSpace } from "@/app/spaces";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBackdrop, DialogPortal } from "@/components/ui/dialog";
import { flushAppearance } from "@/lib/appearance";
import { cn } from "@/lib/utils";
import { AboutSettings } from "./AboutSettings";
import { AgentsSettings } from "./AgentsSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { AssistantSettings } from "./AssistantSettings";
import { CoursesSettings } from "./CoursesSettings";
import { SpacesSettings } from "./SpacesSettings";

const SECTIONS: readonly { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: "appearance", label: "Appearance & accessibility", icon: PaletteIcon },
  { id: "assistant", label: "Assistant", icon: BotIcon },
  { id: "agents", label: "Coding agents", icon: TerminalIcon },
  { id: "spaces", label: "Spaces", icon: LayersIcon },
  { id: "courses", label: "Courses", icon: LibraryBigIcon },
  { id: "about", label: "About", icon: InfoIcon },
];

export function sectionLabel(id: SettingsSection): string {
  return SECTIONS.find((s) => s.id === id)?.label ?? "Settings";
}

/**
 * Settings: a bounded dialog with its sections on the left and the chosen
 * section scrolling on its own; a full-screen sheet at phone width, with the
 * sections as a scrolling row. F6 moves between the section list and the
 * content.
 */
export function SettingsDialog() {
  const section = useNav((s) => s.settings);
  const openSettings = useNav((s) => s.openSettings);
  const closeSettings = useNav((s) => s.closeSettings);
  const space = useCurrentSpace();
  const open = section !== null;
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          void flushAppearance();
          closeSettings();
        }
      }}
    >
      <DialogPortal>
        <DialogBackdrop />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4 max-sm:p-0">
          <DialogPrimitive.Popup
            data-app-modal=""
            data-slot="dialog-popup"
            className={cn(
              "dialog-glass relative flex h-[min(46rem,calc(100svh-2rem))] w-[min(68rem,calc(100vw-2rem))] min-h-0 overflow-hidden rounded-2xl border text-popover-foreground outline-none",
              "transition-[scale,opacity] duration-200 ease-out data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0",
              "max-sm:h-svh max-sm:w-screen max-sm:flex-col max-sm:rounded-none max-sm:border-0",
            )}
          >
            {section ? (
              <>
                <nav
                  aria-label="Settings sections"
                  data-workspace-area="settings-nav"
                  data-workspace-order={0}
                  tabIndex={-1}
                  className="flex w-60 shrink-0 flex-col gap-1 border-e border-border bg-sidebar/70 p-2 outline-none max-sm:w-full max-sm:border-e-0 max-sm:border-b max-sm:p-0"
                >
                  <div className="flex h-11 items-center justify-between px-2.5 max-sm:h-12 max-sm:ps-4 max-sm:pe-2">
                    <DialogPrimitive.Title className="font-semibold text-base">Settings</DialogPrimitive.Title>
                    <DialogPrimitive.Close aria-label="Close settings" render={<Button size="icon-sm" variant="ghost" className="sm:hidden" />}>
                      <XIcon />
                    </DialogPrimitive.Close>
                  </div>
                  <ul className="flex flex-col gap-0.5 max-sm:flex-row max-sm:gap-1 max-sm:overflow-x-auto max-sm:px-3 max-sm:pb-2.5">
                    {SECTIONS.map((s) => {
                      const Icon = s.icon;
                      const current = s.id === section;
                      return (
                        <li key={s.id} className="max-sm:shrink-0">
                          <button
                            type="button"
                            data-target=""
                            data-workspace-focus-default={current ? "" : undefined}
                            aria-current={current ? "page" : undefined}
                            onClick={() => openSettings(s.id)}
                            className={cn(
                              "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-[var(--control-radius)] px-2.5 text-start text-sm text-muted-foreground outline-none sm:h-8",
                              "hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                              "aria-[current=page]:bg-sidebar-row-selected aria-[current=page]:font-medium aria-[current=page]:text-foreground",
                              "max-sm:rounded-full max-sm:border max-sm:border-border max-sm:px-3 max-sm:aria-[current=page]:border-transparent",
                            )}
                          >
                            <Icon aria-hidden="true" className="size-4 shrink-0 max-sm:hidden" />
                            <span className="truncate max-sm:whitespace-nowrap">{s.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </nav>
                <div
                  data-workspace-area="settings-content"
                  data-workspace-order={1}
                  role="region"
                  aria-labelledby="settings-section-title"
                  tabIndex={-1}
                  className="flex min-h-0 min-w-0 flex-1 flex-col bg-background/60 outline-none"
                >
                  <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border ps-5 pe-2 max-sm:hidden sm:ps-8">
                    <h2 id="settings-section-title" className="min-w-0 flex-1 truncate font-semibold text-sm">
                      {sectionLabel(section)}
                    </h2>
                    <DialogPrimitive.Close aria-label="Close settings" render={<Button size="icon-sm" variant="ghost" />}>
                      <XIcon />
                    </DialogPrimitive.Close>
                  </header>
                  <h2 id="settings-section-title-phone" className="sr-only sm:hidden">
                    {sectionLabel(section)}
                  </h2>
                  <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {section === "appearance" ? <AppearanceSettings /> : null}
                    {section === "assistant" ? (
                      <div className="mx-auto w-full max-w-3xl px-5 py-6 sm:px-8 sm:py-8">
                        <AssistantSettings spaceId={space?.id} />
                      </div>
                    ) : null}
                    {section === "agents" ? (
                      <div className="mx-auto w-full max-w-3xl px-5 py-6 sm:px-8 sm:py-8">
                        <AgentsSettings spaceId={space?.id} />
                      </div>
                    ) : null}
                    {section === "spaces" ? <SpacesSettings /> : null}
                    {section === "courses" ? <CoursesSettings /> : null}
                    {section === "about" ? <AboutSettings /> : null}
                  </div>
                </div>
              </>
            ) : null}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPortal>
    </Dialog>
  );
}
