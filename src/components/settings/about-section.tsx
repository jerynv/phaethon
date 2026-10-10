import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import type { Settings } from "@/lib/backend";

import { ExternalLink } from "./agent-section";
import { ANTHROPIC_PRIVACY_URL, KEY_STORE } from "./api-key";
import { PathText, SectionHeader, SettingGroup, SettingRow } from "./controls";
import { useStatus } from "./status";

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
      <code className="min-w-0 flex-1 rounded-md bg-surface-sunken px-2.5 py-1.5 font-mono text-sm wrap-anywhere text-ink">
        <PathText path={path} />
      </code>
      <Button
        type="button"
        variant="outline"
        size="sm"
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
        {isCopied ? "Copied" : "Copy path"}
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
        description="An accessible workspace for your own AI assistant, where everything it knows is plain files you own."
      />
      <SettingGroup title="This copy">
        <SettingRow label="Version">
          <span className="text-base text-ink tabular-nums">{settings?.version ?? "Unknown"}</span>
        </SettingRow>
        <SettingRow label="Licence" description="Free and open source. You may use, change and share it.">
          <span className="text-base text-ink">MIT</span>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Your Phaethon folder" description="Your spaces, conversations, attachments and these settings are files in this folder.">
        <SettingRow
          stacked
          label="Folder"
          description={`Phaethon keeps its own files (these settings, your conversations, and what each space may read) in hidden folders named .phaethon, so they stay out of your way; you never need to open them. Settings are in .phaethon/settings.json inside it. Your API key isn’t: it stays in ${KEY_STORE}.`}
        >
          {vault ? <CopyPath path={vault} what="your Phaethon folder" /> : <span className="text-sm text-ink-secondary">Not available in this preview.</span>}
        </SettingRow>
      </SettingGroup>

      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5 px-1">
          {/* Focusable from script: Assistant › "Where they are" lands here. */}
          <h4 id={filesHeading} data-files-heading="" tabIndex={-1} className="self-start rounded-xs text-md font-semibold text-ink">
            Your files and privacy
          </h4>
        </div>
        <div data-privacy="" className="flex flex-col divide-y divide-line rounded-lg border border-line bg-raised text-sm text-ink-secondary shadow-sm">
          <div className="flex flex-col gap-1 px-4 py-3.5">
            <p className="text-base font-medium text-ink">Plain files, not encrypted</p>
            <p className="max-w-(--ph-measure)">
              Conversations, attachments and settings are ordinary files that anyone with access to your account on this computer can open.
              If your Phaethon folder is in iCloud Drive, Dropbox or another synced folder, they sync too.
            </p>
          </div>
          <div className="flex flex-col gap-1 px-4 py-3.5">
            <p className="text-base font-medium text-ink">MANUAL.md is read in every space</p>
            <p className="max-w-(--ph-measure)">
              MANUAL.md is a note at the top of your Phaethon folder where you tell the assistant how you like it to work, like the
              instructions you’d give a new assistant. It is read in every space, so keep anything that belongs to one space out of it.
            </p>
          </div>
          <div className="flex flex-col gap-1 px-4 py-3.5">
            <p className="text-base font-medium text-ink">What is read from another space stays in this one</p>
            <p className="max-w-(--ph-measure)">
              When you let a space read something in another space, what it read from there is saved in that space’s conversation, in that
              space’s folder, and syncs with it. Removing the access stops future reads; it doesn’t delete what was already read. Delete the
              conversation to remove it.
            </p>
          </div>
          <div className="flex flex-col gap-1.5 px-4 py-3.5">
            <p className="text-base font-medium text-ink">Deleting a conversation</p>
            <p className="max-w-(--ph-measure)">
              Each space keeps its conversations as files inside its own folder, in a hidden folder named .phaethon:
            </p>
            <ul className="flex list-disc flex-col gap-1 ps-5">
              <li>
                the current one in <span className="font-mono wrap-anywhere text-ink">spaces/<i>space</i>/.phaethon/thread.json</span>
              </li>
              <li>
                earlier ones in <span className="font-mono wrap-anywhere text-ink">spaces/<i>space</i>/.phaethon/threads/</span>
              </li>
              <li>
                files you attached in <span className="font-mono wrap-anywhere text-ink">spaces/<i>space</i>/attachments/</span>
              </li>
            </ul>
            <p className="max-w-(--ph-measure)">
              Delete a file to delete that conversation for good. Folders whose names start with a dot are hidden in Finder: press
              Command-Shift-full stop to show them. Copies already sent to Anthropic are covered by{" "}
              <ExternalLink href={ANTHROPIC_PRIVACY_URL}>Anthropic’s privacy policy</ExternalLink>.
            </p>
          </div>
        </div>
      </div>

      <p className="max-w-(--ph-measure) text-sm text-ink-secondary">
        The default reading font is Atkinson Hyperlegible, designed by the Braille Institute so similar letters are easy to tell apart.
      </p>
    </>
  );
}
