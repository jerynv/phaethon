import { useEffect, useRef, useState } from "react";

import { SpaceMark } from "@/components/shell/space-mark";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { getSettings } from "@/lib/backend";
import { grantDate, grantLabel, revokeGrant, spaceInfo, useGrants, type GrantView } from "@/lib/grants";
import { STUB_SPACES, type Space } from "@/lib/spaces";
import { hueName } from "@/theme";

import { SectionHeader, SettingGroup } from "./controls";
import { useStatus } from "./status";

/**
 * Settings > Spaces: every space in the vault and, under each, what it may
 * read in other spaces (saved read-only grants), with Revoke. Modelled on the
 * per-app lists of macOS Privacy & Security and the "third-party access" pages
 * of GitHub and Google: who has access to what, since when, and one button to
 * take it back. Nothing here grants access; that only happens in a
 * conversation, when Phaethon asks.
 */
export function SpacesSection({ headingId }: { headingId: string }) {
  const [vaultPath, setVaultPath] = useState<string | undefined>();
  useEffect(() => {
    getSettings().then(
      (s) => setVaultPath(s.vaultPath),
      () => {},
    );
  }, []);
  // grants.json problems are about the whole file; every space reports the same list.
  const { state } = useGrants(STUB_SPACES[0].id);
  const problems = state.status === "ready" ? state.problems : [];

  return (
    <>
      <SectionHeader
        id={headingId}
        title="Spaces"
        description="A space only sees its own files. When Phaethon needs something from another space, it asks you in the conversation. Grants you choose to keep are listed here; they are read-only."
      />
      <SettingGroup title="In this vault">
        <ul className="flex flex-col divide-y divide-line" aria-label="Spaces in this vault">
          {STUB_SPACES.map((s) => (
            <SpaceRow key={s.id} space={s} />
          ))}
        </ul>
      </SettingGroup>
      {problems.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-md bg-warning-soft px-3.5 py-3 text-sm text-warning-ink">
          <Icon name="warning" className="mt-0.5 shrink-0" />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-medium">Some saved grants were ignored, so they give no access.</p>
            <ul className="flex list-disc flex-col gap-0.5 ps-4">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p>
              Fix or remove them in <code className="font-mono wrap-anywhere">{vaultPath ? `${vaultPath}/.phaethon/grants.json` : ".phaethon/grants.json in your vault"}</code>
            </p>
          </div>
        </div>
      )}
      <p className="flex items-start gap-2 text-sm text-ink-secondary">
        <Icon name="info" className="mt-0.5 shrink-0 text-ink-tertiary" />
        <span className="max-w-(--ph-measure)">Adding, renaming and colouring spaces are coming here next.</span>
      </p>
    </>
  );
}

function SpaceRow({ space }: { space: Space }) {
  const { state } = useGrants(space.id);
  const { say, fail } = useStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<number | null>(null);
  const emptyId = `space-${space.id}-grants`;
  const grants = state.status === "ready" ? state.grants : [];

  // After a revoke, focus the Revoke that took the removed one's place, or the empty-state line.
  useEffect(() => {
    const i = focusAfter.current;
    if (i === null || state.status !== "ready") return;
    focusAfter.current = null;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-revoke]");
    if (buttons?.length) buttons[Math.min(i, buttons.length - 1)]?.focus();
    else document.getElementById(emptyId)?.focus();
  }, [state, emptyId]);

  async function revoke(g: GrantView, index: number) {
    setBusy(g.id);
    try {
      const removed = await revokeGrant(g.id);
      focusAfter.current = index;
      say(removed ? `${space.name} can no longer read ${grantLabel(g)}.` : `${grantLabel(g)} was already removed.`);
    } catch (e) {
      fail(`Could not revoke ${space.name}'s access to ${grantLabel(g)}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="flex flex-col gap-2.5 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <SpaceMark hue={space.hue} className="mt-1.5" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-base font-medium text-ink">{space.name}</span>
          <span className="truncate text-sm text-ink-secondary">{space.description}</span>
        </span>
        <span className="text-right text-sm text-ink-secondary">
          Colour: {hueName(space.hue)}
          <span className="block font-mono text-xs text-ink-secondary">spaces/{space.id}</span>
        </span>
      </div>

      <div ref={listRef} className="ms-(--ph-space-mark-size) ps-3">
        {state.status === "loading" && <p className="text-sm text-ink-secondary">Checking what {space.name} can read…</p>}
        {state.status === "error" && (
          <p className="flex items-start gap-1.5 text-sm text-danger-ink">
            <Icon name="error" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
            Could not check what {space.name} can read: {state.error}
          </p>
        )}
        {state.status === "ready" && grants.length === 0 && (
          <p id={emptyId} tabIndex={-1} className="flex items-center gap-1.5 text-sm text-ink-secondary outline-none">
            <Icon name="lock" className="size-(--ph-icon-size-sm) shrink-0" />
            Can't read anything outside {space.name}.
          </p>
        )}
        {grants.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-sm text-ink-secondary">
              {space.name} can also read, without asking:
            </p>
            <ul aria-label={`What ${space.name} can read in other spaces`} className="flex flex-col rounded-md bg-surface-sunken">
              {grants.map((g, i) => {
                const from = spaceInfo(g.from);
                const date = grantDate(g.created);
                return (
                  <li key={g.id} className="flex items-center gap-3 py-1.5 ps-3 pe-1.5 not-first:border-t not-first:border-line">
                    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                      <span className="flex min-w-0 items-center gap-1.5 text-base">
                        <SpaceMark hue={from.hue} />
                        <span className="font-medium text-ink">{from.name}</span>
                        <span aria-hidden="true" className="text-ink-secondary">/</span>
                        <span className="min-w-0 truncate font-mono text-sm text-ink" title={g.path}>
                          {g.path}
                        </span>
                      </span>
                      <span className="text-xs text-ink-secondary">
                        {g.scope === "once" ? "This time only" : "Always"}
                        {date && ` · since ${date}`}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      data-revoke=""
                      disabled={busy !== null}
                      aria-label={`Revoke ${space.name}'s access to ${grantLabel(g)}`}
                      onClick={() => void revoke(g, i)}
                      className="min-h-(--ph-target-min)"
                    >
                      {busy === g.id ? "Revoking…" : "Revoke"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </li>
  );
}
