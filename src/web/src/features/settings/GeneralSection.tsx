import { api } from "@/app/api";
import { keysFor, spaceKeys, viewKeys } from "@/app/shortcuts";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { SkeletonCard } from "@/components/skeletons";
import { StartTruncate } from "@/components/truncate";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { ToggleRow } from "@/components/ui/toggle-row";
import { usePrefs } from "./prefs";
import { CopyButton, Loader, SettingsCard, useLoad } from "./ui";

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
