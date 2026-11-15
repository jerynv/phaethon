import { api } from "@/app/api";
import { keysFor, spaceKeys, viewKeys } from "@/app/shortcuts";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { SkeletonCard } from "@/components/skeletons";
import { StartTruncate } from "@/components/truncate";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { ToggleRow } from "@/components/ui/toggle-row";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { LETTER_ORDER, pointsOf } from "@/features/grades/lib/gpa";
import { usePrefs } from "./prefs";
import { CopyButton, Loader, Row, SettingsCard, useLoad } from "./ui";

/** Settings › General: where the vault is, how replies read, and the keyboard shortcuts. */

function Keys({ keys }: { keys: string[] }) {
  return (
    <KbdGroup className="gap-1">
      {keys.map((k) => (
        <Kbd key={k} variant="keycap">
          {k}
        </Kbd>
      ))}
    </KbdGroup>
  );
}

function shortcuts(): { label: string; keys: string[] }[] {
  const lastView = viewKeys(4).keys;
  const firstView = viewKeys(0).keys;
  return [
    { label: "New chat", keys: keysFor("newChat").keys },
    { label: "Search conversations", keys: keysFor("search").keys },
    { label: "Show or hide the sidebar", keys: keysFor("sidebar").keys },
    { label: "Open or close settings", keys: keysFor("settings").keys },
    { label: "Go to space 1–9", keys: [...spaceKeys(0).keys.slice(0, -1), "1–9"] },
    { label: "Switch view (Chat, Study, Grades, Plan, Courses)", keys: [...firstView.slice(0, -1), `${firstView.at(-1)}–${lastView.at(-1)}`] },
    { label: "Move between sidebar, page and composer", keys: ["F6"] },
    { label: "Close settings, dialogs and menus", keys: ["Esc"] },
  ];
}

export function GeneralSection() {
  const settings = useLoad(() => api.settings());
  const technical = usePrefs((s) => s.technicalDetails);
  const setTechnical = usePrefs((s) => s.setTechnicalDetails);
  return (
    <>
      <Loader state={settings} errorTitle="Couldn’t read your settings" skeleton={<SkeletonCard rows={1} />}>
        {(s) => (
          <SettingsCard
            icon={<Icon icon={icons.folder} />}
            title="Phaethon folder"
            description={s.vaultPath ? <StartTruncate value={s.vaultPath} className="font-mono text-xs" /> : "Not chosen yet"}
            action={s.vaultPath ? <CopyButton text={s.vaultPath} label="Copy path" /> : null}
          />
        )}
      </Loader>

      <SettingsCard icon={<Icon icon={icons.chat} />} title="Chat">
        <div className="flex flex-col">
          <ToggleRow
            title="Show technical details"
            description="Tool names, paths and output under each step."
            checked={technical}
            onCheckedChange={setTechnical}
          />
        </div>
      </SettingsCard>

      <SettingsCard icon={<Icon icon={icons.grades} />} title="Grades">
        <GradeScaleRows />
      </SettingsCard>

      <SettingsCard icon={<Icon icon={icons.command} />} title="Keyboard shortcuts">
        <ul className="-mt-2 flex flex-col">
          {shortcuts().map((s) => (
            <li key={s.label} className="flex h-10 items-center justify-between gap-4 text-sm">
              <span className="min-w-0 truncate">{s.label}</span>
              <span className="shrink-0">
                <Keys keys={s.keys} />
              </span>
            </li>
          ))}
        </ul>
      </SettingsCard>
    </>
  );
}

/** How letters count towards the GPA on the Grades page: the standard 4.0 scale, or points per letter. */
function GradeScaleRows() {
  const scale = usePrefs((s) => s.gradeScale);
  const setScale = usePrefs((s) => s.setGradeScale);
  const points = pointsOf(scale);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const commit = (letter: string, text: string) => {
    const n = Number.parseFloat(text);
    const next = { ...(scale.kind === "custom" ? scale.points : {}) };
    if (Number.isFinite(n) && n >= 0 && n <= 20) next[letter] = Math.round(n * 100) / 100;
    setScale({ kind: "custom", points: next });
    setDrafts((d) => ({ ...d, [letter]: "" }));
  };
  return (
    <div className="flex flex-col gap-3">
      <Row label="Grade points" description={scale.kind === "custom" ? "Your own points per letter." : "A = 4.0, A− = 3.7, B+ = 3.3…"}>
        <Tabs value={scale.kind} onValueChange={(v) => setScale(v === "custom" ? { kind: "custom", points: {} } : { kind: "standard" })}>
          <TabsList size="sm" aria-label="Grade scale">
            <TabsTab value="standard">4.0</TabsTab>
            <TabsTab value="custom">Custom</TabsTab>
          </TabsList>
        </Tabs>
      </Row>
      {scale.kind === "custom" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2" aria-label="Points per letter">
          {LETTER_ORDER.map((letter) => (
            <label key={letter} className="flex items-center gap-2 text-sm">
              <span className="w-5 shrink-0 text-muted-foreground tabular-nums">{letter}</span>
              <Input
                size="sm"
                inputMode="decimal"
                aria-label={`Points for ${letter}`}
                value={drafts[letter] || String(points[letter] ?? "")}
                onChange={(e) => setDrafts((d) => ({ ...d, [letter]: e.target.value }))}
                onBlur={(e) => commit(letter, e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && commit(letter, (e.target as HTMLInputElement).value)}
                className="[&_input]:tabular-nums"
              />
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
