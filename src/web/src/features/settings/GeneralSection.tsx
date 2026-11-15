import { ArrowRightIcon } from "lucide-react";
import { api } from "@/app/api";
import { keysFor, spaceKeys, viewKeys } from "@/app/shortcuts";
import { useNav } from "@/app/store";
import { SkeletonCard } from "@/components/skeletons";
import { StartTruncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Card, CopyButton, Group, Loader, Row, useLoad } from "./ui";

/** Settings › General: where the vault is, where models are chosen, and the keyboard shortcuts. */

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
  const openSettings = useNav((s) => s.openSettings);
  return (
    <>
      <Group label="Phaethon folder">
        <Loader state={settings} errorTitle="Couldn’t read your settings" skeleton={<SkeletonCard rows={1} />}>
          {(s) => (
            <Card>
              <Row
                label="Vault"
                description={s.vaultPath ? <StartTruncate value={s.vaultPath} className="font-mono text-[11px]" /> : "Not chosen yet"}
              >
                {s.vaultPath ? <CopyButton text={s.vaultPath} label="Copy path" /> : null}
              </Row>
            </Card>
          )}
        </Loader>
      </Group>

      <Group label="Models">
        <Card>
          <Row label="Model for each chat" description="Chosen in each conversation’s composer, next to Send.">
            <Button size="xs" variant="outline" onClick={() => openSettings("providers")}>
              Providers
              <ArrowRightIcon />
            </Button>
          </Row>
        </Card>
      </Group>

      <Group label="Keyboard shortcuts">
        <Card>
          {shortcuts().map((s) => (
            <div key={s.label} className="flex h-10 items-center justify-between gap-4 px-3.5 text-sm">
              <span className="min-w-0 truncate">{s.label}</span>
              <span className="shrink-0">
                <Keys keys={s.keys} />
              </span>
            </div>
          ))}
        </Card>
      </Group>
    </>
  );
}
