import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { getAppearance, setAppearance, subscribe, useAppearance, type Appearance } from "@/theme";

import { SectionHeader } from "./controls";
import { useStatus } from "./status";

type Prefs = { resetTheme?: boolean; resetAccess?: boolean };

/**
 * A page heading with "Reset <page>" on the right. After a reset the button
 * becomes "Undo reset" until anything else changes, so a slip costs nothing.
 */
export function SectionReset({
  headingId,
  title,
  description,
  what,
  tokens,
  resetTheme,
  resetAccess,
}: {
  headingId: string;
  title: string;
  description: ReactNode;
  what: string;
  tokens: readonly string[];
} & Prefs) {
  const a = useAppearance();
  const { say } = useStatus();
  const [undo, setUndo] = useState<Appearance | null>(null);
  const afterReset = useRef<Appearance | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Any change after the reset retires the undo.
  useEffect(
    () =>
      subscribe(() => {
        if (afterReset.current && getAppearance() !== afterReset.current) {
          afterReset.current = null;
          setUndo(null);
        }
      }),
    [],
  );

  const changed =
    tokens.some((t) => t in a.tokens) ||
    (resetTheme && a.theme !== "system") ||
    (resetAccess && (a.increaseContrast !== "system" || a.reduceMotion !== "system" || a.readingFont !== "atkinson"));

  function reset() {
    const before = getAppearance();
    setAppearance((p) => {
      const t = { ...p.tokens };
      for (const n of tokens) delete t[n];
      return {
        ...p,
        tokens: t,
        ...(resetTheme ? { theme: "system" as const } : {}),
        ...(resetAccess ? { increaseContrast: "system" as const, reduceMotion: "system" as const, readingFont: "atkinson" as const } : {}),
      };
    });
    afterReset.current = getAppearance();
    setUndo(before);
    say(`${title} reset to defaults. Choose Undo reset to bring your settings back.`);
    buttonRef.current?.focus();
  }

  function undoReset() {
    if (!undo) return;
    afterReset.current = null;
    setAppearance(undo);
    setUndo(null);
    say(`${title} settings restored.`);
  }

  return (
    <SectionHeader
      id={headingId}
      title={title}
      description={description}
      action={
        undo ? (
          <Button ref={buttonRef} type="button" variant="outline" size="sm" onClick={undoReset}>
            <Icon name="retry" />
            Undo reset
          </Button>
        ) : changed ? (
          <Button ref={buttonRef} type="button" variant="outline" size="sm" onClick={reset} aria-label={`Reset ${what} to defaults`}>
            <Icon name="retry" />
            Reset {what}
          </Button>
        ) : (
          // Not a disabled button: its reason would sit in a tooltip nobody can reach.
          <p className="flex items-center gap-1.5 text-sm text-ink-secondary">
            <Icon name="check" className="size-(--ph-icon-size-sm) shrink-0" />
            Everything here is at its default.
          </p>
        )
      }
    />
  );
}
