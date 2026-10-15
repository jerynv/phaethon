import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { setFullAccess, useFullAccess } from "@/lib/full-access";

import { useAnnounce } from "./announce";

/**
 * Above the message box for as long as the space has full access
 * (src/lib/full-access.ts): what it means, and Turn off. Turning off puts
 * focus in the message box and says so.
 */
export function FullAccessBanner({ space, onOff }: { space: string | undefined; onOff: () => void }) {
  const on = useFullAccess(space);
  const announce = useAnnounce();
  const [error, setError] = useState("");
  if (!on || !space) return null;
  async function off() {
    try {
      await setFullAccess(space!, false);
      setError("");
      announce("Full access is off. The assistant can only read this space again.");
      onOff();
    } catch (e) {
      setError(`Full access couldn’t be turned off: ${String(e)}`);
    }
  }
  return (
    <section
      aria-label="Full access"
      data-full-access-banner=""
      className="mb-2 flex items-start gap-2.5 rounded-lg border border-transparent bg-warning-soft py-2 ps-3 pe-2 text-base text-warning-ink forced-colors:border-[CanvasText]"
    >
      <Icon name="warning" className="mt-0.5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="wrap-break-word">
          <span className="font-medium">Full access is on.</span> The assistant can read and change anything on this Mac and use the internet, without asking.
        </p>
        {error && (
          <p role="alert" className="text-sm text-danger-ink">
            {error}
          </p>
        )}
      </div>
      <Button type="button" variant="outline" size="sm" data-full-access-off="" onClick={() => void off()} className="min-h-(--ph-target-min) shrink-0">
        Turn off
      </Button>
    </section>
  );
}
