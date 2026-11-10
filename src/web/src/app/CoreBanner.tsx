import { WifiOffIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { coreStatus, onCoreStatus, type CoreStatus } from "@/lib/core";

/** How long the first connection may take before saying anything. */
const GRACE_MS = 2500;

/**
 * Says when Phaethon's core can't be reached (it restarts, or crashed). The
 * connection retries by itself, so there's nothing to press; the banner
 * goes away once it's back.
 */
export function CoreBanner() {
  const [status, setStatus] = useState<CoreStatus>(coreStatus());
  const [graceOver, setGraceOver] = useState(false);

  useEffect(() => {
    const off = onCoreStatus(setStatus);
    // The connection may have opened between render and this effect.
    setStatus(coreStatus());
    return off;
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setGraceOver(true), GRACE_MS);
    return () => clearTimeout(t);
  }, []);

  const show = status === "lost" || (status === "connecting" && graceOver);
  return (
    <div role="status" aria-live="polite">
      {show ? (
        <div className="flex shrink-0 items-center gap-2.5 border-b border-warning/30 bg-warning-surface px-4 py-2 text-sm text-warning-foreground">
          <WifiOffIcon aria-hidden="true" className="size-4 shrink-0" />
          <p>
            <span className="font-medium">Phaethon’s core isn’t responding.</span> Reconnecting…
          </p>
        </div>
      ) : null}
    </div>
  );
}
