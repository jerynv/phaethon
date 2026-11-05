import { useEffect, useState } from "react";

import { Details } from "@/components/ui/details";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import type { Settings } from "@/lib/backend";

import { PathText, SectionHeader, SettingGroup, SettingRow } from "./controls";
import { useStatus } from "./status";
import { UpdatesGroup } from "./updates";

/** How long "Copied" shows before the button reads "Copy path" again. */
const COPIED_MS = 2000;

/** A path with a Copy path button that confirms in place and in the status line. */
function CopyPath({ path, what }: { path: string; what: string }) {
  const [isCopied, setCopied] = useState(false);
  const { say, fail } = useStatus();

  useEffect(() => {
    if (!isCopied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [isCopied]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 font-mono text-xs wrap-anywhere text-ink-secondary">
        <PathText path={path} />
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={isCopied ? `${what} path copied` : `Copy ${what} path`}
        title={isCopied ? "Copied" : "Copy path"}
        onClick={() =>
          navigator.clipboard.writeText(path).then(
            () => {
              // Restart the timer when copied twice in a row.
              setCopied(false);
              requestAnimationFrame(() => setCopied(true));
              say(`Path of ${what} copied.`);
            },
            () => fail("Could not copy the path. Select it and copy it instead."),
          )
        }
      >
        <Icon name={isCopied ? "check" : "copy"} />
      </Button>
    </div>
  );
}

export function AboutSection({ headingId, settings }: { headingId: string; settings: Settings | null }) {
  const vault = settings?.vaultPath;
  const filesHeading = `${headingId}-files`;

  return (
    <>
      <SectionHeader
        id={headingId}
        title="About Phaethon"
      />
      <SettingGroup title="Application">
        <SettingRow label="Version">
          <span className="text-base text-ink tabular-nums">{settings?.version ?? "Unknown"}</span>
        </SettingRow>
      </SettingGroup>

      <UpdatesGroup />

      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5 px-1">
          <h4 id={filesHeading} data-files-heading="" tabIndex={-1} className="self-start rounded-xs text-md font-semibold text-ink">
            Files
          </h4>
        </div>
        <div data-about-files="" className="flex flex-col divide-y divide-line rounded-lg border border-line bg-raised">
          <SettingRow label="Phaethon folder">
            {vault ? <CopyPath path={vault} what="your Phaethon folder" /> : <span className="text-sm text-ink-secondary">Not available in this preview.</span>}
          </SettingRow>
          <SettingRow label="Instructions">
            {vault ? <CopyPath path={`${vault}/MANUAL.md`} what="MANUAL.md" /> : <PathText path="MANUAL.md" />}
          </SettingRow>
          <SettingRow label="Conversations">
            <PathText path="spaces/<space>/.phaethon/" />
          </SettingRow>
          <SettingRow label="Attachments">
            <PathText path="spaces/<space>/attachments/" />
          </SettingRow>
        </div>
      </div>

      <Details summary="Legal" className="text-xs text-ink-secondary"><p>Phaethon is available under the MIT licence.</p><p>Atkinson Hyperlegible by the Braille Institute. OpenDyslexic by Abbie Gonzalez. Lexend by Bonnie Shaver-Troup and Thomas Jockin.</p></Details>
    </>
  );
}
