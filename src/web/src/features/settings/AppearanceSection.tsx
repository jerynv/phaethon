import { useState } from "react";
import { FieldError, cleanMessage } from "@/components/errors";
import { type ThemeChoice, useTheme } from "@/app/theme";
import { cn } from "@/lib/utils";
import { Card, Group } from "./ui";

/** Settings › Appearance: System, Light or Dark, each with a small wireframe of the app. */

const CHOICES: { id: ThemeChoice; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** A tiny app: sidebar with rows, a header line, a few prose lines and a composer. */
function Wire({ dark }: { dark: boolean }) {
  return (
    <div className={cn("flex h-full w-full", dark ? "bg-[#0c0c0d]" : "bg-white")}>
      <div className={cn("flex w-[30%] flex-col gap-1 border-r p-1.5 pt-3", dark ? "border-white/8 bg-[#111112]" : "border-zinc-200 bg-zinc-50")}>
        {[70, 55, 80, 45].map((w, i) => (
          <span key={w} className={cn("h-1 rounded-full", i === 0 ? (dark ? "bg-white/30" : "bg-zinc-400") : dark ? "bg-white/12" : "bg-zinc-200")} style={{ width: `${w}%` }} />
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-1.5 pt-3">
        <span className={cn("ml-auto h-2 w-[40%] rounded-[3px]", dark ? "bg-[#1c1c1f]" : "bg-zinc-100")} />
        {[90, 75, 60].map((w) => (
          <span key={w} className={cn("h-1 rounded-full", dark ? "bg-white/16" : "bg-zinc-200")} style={{ width: `${w}%` }} />
        ))}
        <span className={cn("mt-auto h-2.5 rounded-[3px] border", dark ? "border-white/11 bg-[#161618]" : "border-zinc-300 bg-white")} />
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
    <Group label="Theme">
      <Card className="p-3.5">
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-0.5 rounded-lg bg-input/40 p-0.5">
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
                  "flex flex-col gap-2 rounded-md p-1.5 pb-2 text-xs transition-colors",
                  on ? "bg-background text-foreground shadow-xs/10 dark:bg-input/72" : "text-muted-foreground hover:bg-background/55 hover:text-foreground dark:hover:bg-input/32",
                )}
              >
                <span className={cn("block aspect-[16/10] w-full overflow-hidden rounded-[5px] border", on ? "border-primary/60 ring-1 ring-primary/40" : "border-border")}>
                  <Preview choice={c.id} />
                </span>
                <span className="font-medium">{c.label}</span>
              </button>
            );
          })}
        </div>
        <FieldError className="mt-2">{error}</FieldError>
      </Card>
    </Group>
  );
}
