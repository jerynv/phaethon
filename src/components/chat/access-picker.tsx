import { useState } from "react";

import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/menu";
import { Icon } from "@/icons";
import { setFullAccess, useFullAccess } from "@/lib/full-access";

import { useAnnounce } from "./announce";

/** T3 Code's ComposerFooterControls permissions section (MIT): a compact permission choice in the toolbar. */
export function AccessPicker({ spaceId }: { spaceId: string }) {
  const full = useFullAccess(spaceId);
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function choose(want: boolean) {
    if (full === want || busy) return;
    setBusy(true);
    try {
      const enabled = await setFullAccess(spaceId, want);
      setError("");
      announce(enabled ? "Full access enabled." : "Space access enabled.");
    } catch (problem) {
      setError(String(problem));
      announce(`Access could not be changed. ${String(problem)}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button type="button" variant="ghost" size="xs" data-access-picker="" aria-disabled={busy} aria-busy={busy} onClick={(event) => { if (busy) event.preventDefault(); }}
          aria-label={`Access: ${full ? "Full access" : "Space access"}`} className="text-ink-secondary">
          <Icon name={full ? "shield" : "lock"} className="size-3.5" />
          <span className="hidden md:inline">{full ? "Full access" : "Space access"}</span>
          <Icon name="chevron-down" className="size-3" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="top" align="end" sideOffset={6} data-access-menu="" className="z-50 w-64">
          <DropdownMenu.RadioGroup value={full ? "full" : "space"} onValueChange={(value) => void choose(value === "full")}>
            {[{ value: "space", title: "Space access", detail: "Ask before changes" }, { value: "full", title: "Full access", detail: "Files, tools and network" }].map((mode) => (
              <DropdownMenu.RadioItem key={mode.value} value={mode.value} disabled={busy}
                className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none data-highlighted:bg-hover">
                <span className="min-w-0 flex-1">{mode.title}</span>
                <span className="text-xs text-ink-secondary">{mode.detail}</span>
                <DropdownMenu.ItemIndicator><Icon name="check" className="size-3.5" /></DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {error && <p role="alert" className="px-2.5 py-2 text-xs text-danger-ink">{error}</p>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
