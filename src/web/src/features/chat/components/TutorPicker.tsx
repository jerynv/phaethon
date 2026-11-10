import { ChevronDownIcon, GraduationCapIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Menu, MenuGroupLabel, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuRadioItemIndicator, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import { tutorModeSet, tutorModesList, type TutorMode } from "../api";

export const TUTOR_MODES: readonly { id: TutorMode; title: string; hint: string }[] = [
  { id: "normal", title: "Normal", hint: "Answers and helps as usual" },
  { id: "quiz", title: "Quiz me", hint: "One question at a time from your course, then marks and explains" },
  { id: "explain", title: "Explain it back", hint: "You explain a topic, it finds the gaps" },
  { id: "socratic", title: "Socratic", hint: "Questions and hints, not the answer straight away" },
  { id: "cram", title: "Exam cram", hint: "The most likely exam points, then practice" },
];

let modes: Record<string, TutorMode> = {};
let asked = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/**
 * How Phaethon tutors in this space, from the next message: a small button
 * in the composer's toolbar that names the mode when one is on.
 */
export function TutorPicker({ space, onChanged }: { space: string; onChanged: (text: string) => void }) {
  const all = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => modes,
  );
  useEffect(() => {
    if (asked) return;
    asked = true;
    tutorModesList().then((m) => ((modes = m), emit()), () => {});
  }, []);
  const mode = all[space] ?? "normal";
  const info = TUTOR_MODES.find((m) => m.id === mode) ?? TUTOR_MODES[0];
  const on = mode !== "normal";

  const choose = async (next: TutorMode) => {
    const before = modes;
    modes = { ...modes, [space]: next };
    emit();
    try {
      await tutorModeSet(space, next);
      const title = TUTOR_MODES.find((m) => m.id === next)?.title ?? next;
      onChanged(next === "normal" ? "Tutor mode off." : `Tutor mode: ${title}, from your next message.`);
    } catch (e) {
      modes = before;
      emit();
      onChanged(`The tutor mode couldn’t be changed. ${String(e)}`);
    }
  };

  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost-muted" size="xs" className={cn("min-w-0 gap-1.5", on && "text-foreground")} />}
        aria-label={on ? `Tutor mode: ${info.title}. Change tutor mode` : "Tutor mode: off. Change tutor mode"}
      >
        <GraduationCapIcon aria-hidden className={cn("size-3.5", on && "text-primary")} />
        <span className={cn("truncate", !on && "max-sm:sr-only")}>{on ? info.title : "Tutor"}</span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-80">
        <MenuRadioGroup value={mode} onValueChange={(v) => void choose(v as TutorMode)}>
          <MenuGroupLabel>How Phaethon tutors you here</MenuGroupLabel>
          {TUTOR_MODES.map((m) => (
            <MenuRadioItem key={m.id} value={m.id} className="py-1.5">
              <span className="flex items-start gap-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{m.title}</span>
                  <span className="text-xs text-muted-foreground">{m.hint}</span>
                </span>
                <MenuRadioItemIndicator className="mt-0.5" />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
