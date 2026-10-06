import { Icon } from "@/icons";
import { STUB_SPACES, type Space } from "@/lib/spaces";
import { hueName, numericValue, TOKEN_BY_NAME, useAppearance } from "@/theme";

import { SectionHeader, SettingGroup } from "./controls";

/** A space's own hue, when the space list carries one; otherwise it follows the accent. */
function spaceHue(s: Space): number | undefined {
  const h = (s as Space & { hue?: unknown }).hue;
  return typeof h === "number" && Number.isFinite(h) ? h : undefined;
}

export function SpacesSection({ headingId }: { headingId: string }) {
  const a = useAppearance();
  const accentSpec = TOKEN_BY_NAME.get("--st-accent-h")!;
  const accent = numericValue(accentSpec, a.tokens["--st-accent-h"]);
  return (
    <>
      <SectionHeader
        id={headingId}
        title="Spaces"
        description="Each space is a separate folder in your vault. The agent works inside one space at a time and cannot see the others."
      />
      <SettingGroup title="In this vault">
        <ul className="flex flex-col divide-y divide-line" aria-label="Spaces in this vault">
          {STUB_SPACES.map((s) => {
            const own = spaceHue(s);
            const h = own ?? accent;
            return (
              <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                <span
                  aria-hidden="true"
                  className="size-(--st-icon-size) shrink-0 rounded-full"
                  style={{ background: `oklch(0.62 var(--st-space-c) ${h})` }}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-base font-medium text-ink">{s.name}</span>
                  <span className="truncate text-sm text-ink-secondary">{s.description}</span>
                </span>
                <span className="text-right text-sm text-ink-secondary">
                  {own === undefined ? `Accent colour (${hueName(h)})` : `Colour: ${hueName(h)}`}
                  <span className="block font-mono text-xs text-ink-tertiary">spaces/{s.id}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </SettingGroup>
      <p className="flex items-start gap-2 text-sm text-ink-secondary">
        <Icon name="info" className="mt-0.5 shrink-0 text-ink-tertiary" />
        <span className="max-w-(--st-measure)">
          This list is read-only for now. Adding, renaming and colouring spaces, and per-space rules for what the agent may read,
          write and run, are coming here next.
        </span>
      </p>
    </>
  );
}
