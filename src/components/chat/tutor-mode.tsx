import { invoke } from "@tauri-apps/api/core";
import { DropdownMenu } from "radix-ui";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { announce } from "@/components/shell/announcer";
import type { Command } from "@/components/shell/command-palette";
import { Button } from "@/components/ui/button";
import { IconTip } from "@/components/ui/tooltip";
import { Icon } from "@/icons";
import type { Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * How the agent tutors in a space: normal, or one of four study modes. Saved
 * in the space's space.json (src-tauri/src/tutor_mode.rs), so it syncs with
 * the space; it adds the mode's instructions to the agent's system prompt
 * (Phaethon's own agent and Claude Code alike) from the next message.
 */
export type TutorMode = "normal" | "quiz" | "explain" | "socratic" | "cram";

export const TUTOR_MODES: readonly { id: TutorMode; title: string; short: string; hint: string }[] = [
  { id: "normal", title: "Normal", short: "Normal", hint: "Answers and helps as usual" },
  { id: "quiz", title: "Quiz me", short: "Quiz me", hint: "One question at a time from your course, then marks and explains" },
  { id: "explain", title: "Explain it back", short: "Explain back", hint: "You explain a topic, it finds the gaps" },
  { id: "socratic", title: "Socratic", short: "Socratic", hint: "Only questions and hints, never the answer straight away" },
  { id: "cram", title: "Exam cram", short: "Exam cram", hint: "The most likely exam points, then practice" },
];

/** Extra words that find each mode in the palette. */
const KEYWORDS: Record<TutorMode, string> = {
  normal: "off normal plain usual",
  quiz: "quiz test questions practice",
  explain: "explain feynman teach back gaps",
  socratic: "socratic hints questions guide",
  cram: "exam cram revise summary review",
};

const modeInfo = (id: TutorMode) => TUTOR_MODES.find((m) => m.id === id) ?? TUTOR_MODES[0];

// ---- Store: every space's mode, read once and after each change ----

let modes: Readonly<Record<string, TutorMode>> = {};
let loaded = !inTauri();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

async function refresh() {
  if (!inTauri()) return;
  try {
    modes = await invoke<Record<string, TutorMode>>("space_tutor_modes_list");
  } catch {
    // Unreadable: every space shows normal until the next try.
  }
  loaded = true;
  emit();
}

export function tutorModeOf(spaceId: string): TutorMode {
  return modes[spaceId] ?? "normal";
}

/** Save `mode` for the space. Applies from the next message there. */
export async function setTutorMode(spaceId: string, mode: TutorMode): Promise<void> {
  if (inTauri()) await invoke<void>("space_tutor_mode_set", { space: spaceId, mode });
  const next = { ...modes };
  if (mode === "normal") delete next[spaceId];
  else next[spaceId] = mode;
  modes = next;
  emit();
}

/** What changed, in words, for the status region. */
export function tutorChangedText(spaceName: string, mode: TutorMode, running = false): string {
  const after = running ? " The reply now running isn’t changed." : "";
  if (mode === "normal") return `Tutor mode is off in ${spaceName}. Phaethon answers as usual from your next message.${after}`;
  return `${modeInfo(mode).title} is on in ${spaceName}: ${modeInfo(mode).hint.toLowerCase()}, from your next message.${after}`;
}

let watching = 0;
function useTutorModes() {
  useEffect(() => {
    if (!inTauri()) return;
    if (watching++ === 0) {
      void refresh();
      // A synced or hand-edited space.json may have changed a space's mode.
      window.addEventListener("focus", refresh);
    }
    return () => {
      if (--watching === 0) window.removeEventListener("focus", refresh);
    };
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (loaded ? modes : null),
  );
}

/**
 * The tutor mode, as a small button in the composer's toolbar beside the
 * model: just the icon in normal mode, the mode's short name otherwise (so
 * it's plain that a mode is on). Its menu lists the five modes with what each
 * does.
 */
export function TutorModePicker({ spaceId, spaceName, running }: { spaceId: string; spaceName: string; running: boolean }) {
  const all = useTutorModes();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      contentRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (!all) return null;
  const mode = all[spaceId] ?? "normal";
  const info = modeInfo(mode);
  const on = mode !== "normal";
  const label = `Tutor mode in ${spaceName}: ${info.title}`;

  async function choose(value: string) {
    const next = value as TutorMode;
    if (next === mode) return;
    setError("");
    try {
      await setTutorMode(spaceId, next);
      announce(tutorChangedText(spaceName, next, running));
    } catch (e) {
      const message = `The tutor mode couldn’t be changed. ${String(e)}`;
      setError(message);
      announce(message);
    }
  }

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
      <IconTip label={on ? label : "Tutor mode"} spoken="Change how Phaethon tutors you here">
        <DropdownMenu.Trigger asChild>
          <Button
            type="button"
            variant="ghost"
            size={on ? "sm" : "icon"}
            aria-label={label}
            data-tutor-mode={spaceId}
            data-mode={mode}
            className={cn("min-w-0 shrink", on ? "bg-accent-soft px-2 text-sm font-medium text-accent-soft-ink hover:text-accent-soft-ink forced-colors:border-[CanvasText]" : "rounded-full")}
          >
            <Icon name="book" className={on ? "size-(--ph-icon-size-sm)" : undefined} />
            {on && <span className="truncate">{info.short}</span>}
          </Button>
        </DropdownMenu.Trigger>
      </IconTip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={contentRef}
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label={`Tutor mode in ${spaceName}`}
          data-tutor-menu=""
          className="z-50 flex max-h-(--radix-dropdown-menu-content-available-height) w-[calc(22rem*var(--ph-ui-scale))] max-w-(--radix-dropdown-menu-content-available-width) flex-col overflow-y-auto overscroll-contain rounded-lg border border-line bg-raised p-1 text-ink shadow-lg outline-none origin-(--radix-dropdown-menu-content-transform-origin) animate-in duration-(--ph-duration-fast) fade-in-0 zoom-in-[0.97] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97]"
        >
          <DropdownMenu.Label className="px-2.5 pt-1.5 text-sm font-semibold text-ink-secondary">Tutor mode in {spaceName}</DropdownMenu.Label>
          <p className="px-2.5 pb-1.5 text-sm text-ink-secondary">
            {running ? "Applies from your next message. The reply now running isn’t changed." : "Applies from your next message."}
          </p>
          {error && (
            <p role="alert" className="flex items-start gap-2 px-2.5 pb-1.5 text-sm text-danger-ink">
              <Icon name="error" className="mt-0.5 shrink-0" />
              <span className="min-w-0 wrap-anywhere">{error}</span>
            </p>
          )}
          <DropdownMenu.RadioGroup value={mode} onValueChange={(v) => void choose(v)}>
            {TUTOR_MODES.map((m, i) => (
              <div key={m.id}>
                {i === 1 && <DropdownMenu.Separator className="mx-1 my-1 h-px shrink-0 bg-line forced-colors:bg-[CanvasText]" />}
                <DropdownMenu.RadioItem
                  value={m.id}
                  textValue={m.title}
                  data-tutor-option={m.id}
                  className="grid min-h-(--ph-control-height-lg) cursor-default grid-cols-[var(--ph-icon-size)_minmax(0,1fr)] items-start gap-x-2 rounded-md px-2.5 py-1.5 outline-none select-none data-highlighted:bg-hover"
                >
                  <span className="flex h-[1lh] items-center text-base">
                    <DropdownMenu.ItemIndicator>
                      <Icon name="check" className="text-accent-ink" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-base font-medium wrap-break-word">{m.title}</span>
                    <span className="text-sm text-ink-secondary">{m.hint}</span>
                  </span>
                </DropdownMenu.RadioItem>
              </div>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * The palette's tutor commands for the shown space: one per mode ("Tutor
 * mode: Quiz me"), the one on now marked so.
 */
export function useTutorModeCommands(space: Space | undefined): Command[] {
  const all = useTutorModes();
  return useMemo(() => {
    if (!space || !all) return [];
    const current = all[space.id] ?? "normal";
    return TUTOR_MODES.map<Command>((m) => ({
      id: `tutor-mode:${m.id}`,
      group: "Actions",
      label: m.id === "normal" ? "Tutor mode: off (normal)" : `Tutor mode: ${m.title}`,
      hint: m.id === current ? `on now in ${space.name}` : `in ${space.name}: ${m.hint.toLowerCase()}`,
      keywords: `tutor study learn mode ${KEYWORDS[m.id]}`,
      icon: "book",
      run: () => {
        if (m.id === current) {
          announce(m.id === "normal" ? `Tutor mode is already off in ${space.name}.` : `${m.title} is already on in ${space.name}.`);
          return;
        }
        void setTutorMode(space.id, m.id).then(
          () => announce(tutorChangedText(space.name, m.id)),
          (e: unknown) => announce(`The tutor mode couldn’t be changed. ${String(e)}`),
        );
      },
    }));
  }, [space, all]);
}
