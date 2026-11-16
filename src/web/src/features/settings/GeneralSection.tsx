import { api } from "@/app/api";
import { keysFor, spaceKeys, viewKeys } from "@/app/shortcuts";
import { SkeletonRows } from "@/components/skeletons";
import { StartTruncate } from "@/components/truncate";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { LETTER_ORDER, pointsOf } from "@/features/grades/lib/gpa";
import { usePrefs } from "./prefs";
import { CopyButton, Loader, Row, SettingsGroup, SwitchRow, useLoad } from "./ui";

/** Settings › General: where the vault is, how replies read, and the keyboard shortcuts. */

function Keys({ keys }: { keys: string[] }) {
  return (
    <KbdGroup>
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </KbdGroup>
  );
}

function shortcuts(): { label: string; keys: string[] }[] {
  const lastView = viewKeys(5).keys;
  const firstView = viewKeys(0).keys;
  return [
    { label: "New chat", keys: keysFor("newChat").keys },
    { label: "Search conversations", keys: keysFor("search").keys },
    { label: "Show or hide the sidebar", keys: keysFor("sidebar").keys },
    { label: "Open or close settings", keys: keysFor("settings").keys },
    { label: "Go to space 1–9", keys: [...spaceKeys(0).keys.slice(0, -1), "1–9"] },
    { label: "Switch view (Chat, Files, Study, Grades, Plan, Courses)", keys: [...firstView.slice(0, -1), `${firstView.at(-1)}–${lastView.at(-1)}`] },
    { label: "Move between sidebar, page and composer", keys: ["F6"] },
    { label: "Close settings, dialogs and menus", keys: ["Esc"] },
  ];
}

export function GeneralSection() {
  const settings = useLoad(() => api.settings(), [], "settings:vault");
  const technical = usePrefs((s) => s.technicalDetails);
  const setTechnical = usePrefs((s) => s.setTechnicalDetails);
  return (
    <>
      <SettingsGroup>
        <Loader state={settings} errorTitle="Couldn’t read your settings" skeleton={<SkeletonRows count={1} className="px-3 py-2" />}>
          {(s) => (
            <Row label="Phaethon folder">
              {s.vaultPath ? (
                <>
                  <StartTruncate value={s.vaultPath} className="max-w-80 font-mono text-muted-foreground text-xs" />
                  <CopyButton text={s.vaultPath} label="Copy path" />
                </>
              ) : (
                <span className="text-muted-foreground text-xs">Not chosen yet</span>
              )}
            </Row>
          )}
        </Loader>
        <SwitchRow label="Show technical details" description="Tool names, paths and output under each step." checked={technical} onCheckedChange={setTechnical} />
        <GradeScaleRow />
      </SettingsGroup>

      <SettingsGroup label="Keyboard shortcuts">
        {shortcuts().map((s) => (
          <div key={s.label} className="flex h-8 min-w-0 items-center justify-between gap-4 px-3 text-sm">
            <span className="min-w-0 truncate">{s.label}</span>
            <Keys keys={s.keys} />
          </div>
        ))}
      </SettingsGroup>
    </>
  );
}

/** How letters count towards the GPA on the Grades page: the standard 4.0 scale, or points per letter. */
function GradeScaleRow() {
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
    <Row
      label="Grade points"
      description={scale.kind === "custom" ? undefined : "A = 4.0, A− = 3.7, B+ = 3.3…"}
      below={
        scale.kind === "custom" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-x-3 gap-y-1.5 pb-1" aria-label="Points per letter">
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
        ) : undefined
      }
    >
      <Tabs value={scale.kind} onValueChange={(v) => setScale(v === "custom" ? { kind: "custom", points: {} } : { kind: "standard" })}>
        <TabsList size="sm" aria-label="Grade scale">
          <TabsTab value="standard">4.0</TabsTab>
          <TabsTab value="custom">Custom</TabsTab>
        </TabsList>
      </Tabs>
    </Row>
  );
}
