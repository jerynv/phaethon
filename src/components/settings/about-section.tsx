import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import type { Settings } from "@/lib/backend";

import { PathText, SectionHeader, SettingGroup, SettingRow } from "./controls";
import { useStatus } from "./status";

/** How long "Copied" shows before the button reads "Copy path" again. */
const COPIED_MS = 2000;

export function AboutSection({ headingId, settings }: { headingId: string; settings: Settings | null }) {
  const [isCopied, setCopied] = useState(false);
  const { say, fail } = useStatus();
  const vault = settings?.vaultPath;

  useEffect(() => {
    if (!isCopied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [isCopied]);

  return (
    <>
      <SectionHeader
        id={headingId}
        title="About Phaethon"
        description="An accessible workspace for your own AI agent, where everything it knows is plain files you own."
      />
      <SettingGroup title="This copy">
        <SettingRow label="Version">
          <span className="text-base text-ink tabular-nums">{settings?.version ?? "Unknown"}</span>
        </SettingRow>
        <SettingRow label="Licence" description="Free and open source. You may use, change and share it.">
          <span className="text-base text-ink">MIT</span>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Your vault" description="Your spaces, notes, conversations and these settings are files in this folder.">
        <SettingRow stacked label="Vault folder" description="Settings are saved in .phaethon/settings.json inside it. API keys are not: they stay in this computer’s keychain.">
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 rounded-md bg-surface-sunken px-2.5 py-1.5 font-mono text-sm wrap-anywhere text-ink">
              {vault ? <PathText path={vault} /> : "Not available in this preview"}
            </code>
            {vault && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  navigator.clipboard.writeText(vault).then(
                    () => {
                      // Restart the timer when copied twice in a row.
                      setCopied(false);
                      requestAnimationFrame(() => setCopied(true));
                      say("Vault folder path copied.");
                    },
                    () => fail("Could not copy the path. Select it and copy it instead."),
                  )
                }
              >
                <Icon name={isCopied ? "check" : "copy"} />
                {isCopied ? "Copied" : "Copy path"}
              </Button>
            )}
          </div>
        </SettingRow>
      </SettingGroup>
      <p className="max-w-(--ph-measure) text-sm text-ink-secondary">
        Text is set in Atkinson Hyperlegible, designed by the Braille Institute so similar letters are easy to tell apart.
      </p>
    </>
  );
}
