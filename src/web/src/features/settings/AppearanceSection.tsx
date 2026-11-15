import { useState } from "react";
import { FieldError, cleanMessage } from "@/components/errors";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { type ThemeChoice, useTheme } from "@/app/theme";
import { cn } from "@/lib/utils";
import { SettingsCard } from "./ui";

/** Settings › Appearance: System, Light or Dark as three cards, each with a small wireframe of the app. */

const CHOICES: { id: ThemeChoice; label: string; icon: IconData }[] = [
  { id: "system", label: "System", icon: icons.mode },
  { id: "light", label: "Light", icon: icons.light },
  { id: "dark", label: "Dark", icon: icons.dark },
];

/** A tiny app drawn with the real tokens (`.light` / `.dark` scope them): sidebar rows, a message, prose lines, a composer. */
function Wire({ dark }: { dark: boolean }) {
  return (
    <div className={cn("flex h-full w-full bg-canvas p-1.5", dark ? "dark" : "light")}>
      <div className="flex flex-1 overflow-hidden rounded-md border bg-background">
      <div className="flex w-1/3 flex-col gap-1 border-r p-1.5 pt-3">
        {["w-3/4", "w-1/2", "w-4/5", "w-2/5"].map((w, i) => (
          <span key={w} className={cn("h-1 rounded-full", w, i === 0 ? "bg-subtle-foreground" : "bg-row-selected")} />
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-1.5 pt-3">
        <span className="ml-auto h-2 w-2/5 rounded-xs bg-message" />
        {["w-11/12", "w-3/4", "w-3/5"].map((w) => (
          <span key={w} className={cn("h-1 rounded-full bg-row-selected", w)} />
        ))}
        <span className="mt-auto h-2.5 rounded-xs border border-input bg-card" />
      </div>
      </div>
    </div>
  );
}

function Preview({ choice }: { choice: ThemeChoice }) {
  if (choice !== "system") return <Wire dark={choice === "dark"} />;
  return (
    <div className="relative h-full w-full">
      <Wire dark={false} />
      <div className="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
        <Wire dark />
      </div>
    </div>
  );
}

export function AppearanceSection() {
  const choice = useTheme((s) => s.choice);
  const set = useTheme((s) => s.set);
  const [error, setError] = useState<string | null>(null);
  const pick = (c: ThemeChoice) => {
    setError(null);
    void set(c).catch((e) => setError(`Couldn’t save the theme: ${cleanMessage(e)}`));
  };
  return (
    <SettingsCard icon={<Icon icon={icons.theme} />} title="Theme" description="Light, dark, or whatever your computer uses.">
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-3">
        {CHOICES.map((c) => {
          const on = c.id === choice;
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => pick(c.id)}
              className={cn(
                "group flex flex-col overflow-hidden rounded-xl border bg-card text-left outline-none transition-[border-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                on ? "border-primary ring-1 ring-primary" : "hover:border-border-strong",
              )}
            >
              <span className="block aspect-[16/10] w-full overflow-hidden">
                <Preview choice={c.id} />
              </span>
              <span className="flex h-9 items-center gap-2 border-t bg-well px-3 text-sm">
                <Icon icon={c.icon} className={cn("size-4", on ? "text-primary" : "text-muted-foreground")} />
                <span className="flex-1">{c.label}</span>
                <span
                  aria-hidden
                  className={cn("flex size-4 items-center justify-center rounded-full border transition-colors", on ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card")}
                >
                  {on ? <Icon icon={icons.check} className="size-3" /> : null}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <FieldError>{error}</FieldError>
    </SettingsCard>
  );
}
