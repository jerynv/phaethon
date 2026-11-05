import { useEffect, useRef, useState } from "react";
import { Progress, Select, Skeleton } from "vic-ui";

import { ProviderLogo } from "@/components/provider-logo";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/icons";
import { agentInstances, agentInstanceUsage, type AgentInstanceUsage, type AgentInstanceView } from "@/lib/backend";

export const OPEN_USAGE_EVENT = "phaethon:open-usage";

/** Like T3's UsageLimits, usage is a destination apart from provider configuration.
 * Only the chosen connection is queried; closed or superseded requests cannot publish.
 */
export function UsageDialog() {
  const [open, setOpen] = useState(false);
  const [instances, setInstances] = useState<AgentInstanceView[]>([]);
  const [id, setId] = useState("");
  const [usage, setUsage] = useState<AgentInstanceUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const restoreFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const show = () => {
      restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setId(""); setUsage(null); setError("");
      setOpen(true);
    };
    window.addEventListener(OPEN_USAGE_EVENT, show);
    return () => window.removeEventListener(OPEN_USAGE_EVENT, show);
  }, []);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setInstances([]); setId(""); setUsage(null); setError(""); setLoading(true);
    void agentInstances().then((items) => {
      if (!active) return;
      setInstances(items);
      setId(items.find((item) => item.selected)?.config.id ?? items[0]?.config.id ?? "");
      if (!items.length) setLoading(false);
    }, (reason) => { if (active) { setError(String(reason)); setLoading(false); } });
    return () => { active = false; ++generation.current; };
  }, [open]);
  useEffect(() => {
    if (!open || !id) return;
    const current = ++generation.current;
    setLoading(true); setUsage(null); setError("");
    void agentInstanceUsage(id).then((value) => {
      if (generation.current === current) setUsage(value);
    }, (reason) => {
      if (generation.current === current) setError(String(reason));
    }).finally(() => { if (generation.current === current) setLoading(false); });
    return () => { ++generation.current; };
  }, [open, id, refresh]);
  const current = instances.find((item) => item.config.id === id);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-usage-dialog="" className="flex max-w-md! flex-col gap-5! overflow-hidden" onCloseAutoFocus={(event) => {
        const target = restoreFocus.current;
        if (target?.isConnected && !target.closest("[hidden], [inert]")) { event.preventDefault(); target.focus(); }
      }}>
        <DialogHeader><DialogTitle>Usage</DialogTitle><DialogDescription className="sr-only">Current limits reported by your assistant connection.</DialogDescription></DialogHeader>
        {instances.length > 0 && <div data-usage-account=""><Select aria-label="Usage connection" value={id} onValueChange={setId} items={instances.map((item) => ({ value: item.config.id, text: item.config.name, label: item.config.name, start: <ProviderLogo provider={`${item.config.cli}-cli`} className="size-4" /> }))} /></div>}
        <div data-instance-usage="" className="flex min-h-16 min-w-0 flex-col gap-4 overflow-y-auto">
          {loading ? <div role="status" aria-label="Loading usage" className="flex flex-col gap-3"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-2 w-full" /><Skeleton className="h-3 w-1/2" /></div>
            : error ? <p role="alert" className="text-sm text-danger-ink">{error}</p>
            : usage?.available && usage.windows.length ? usage.windows.map((window) => <div key={window.label} className="flex flex-col gap-1.5">
              <Progress label={window.label} value={window.usedPercent} valueText={`${Math.round(window.usedPercent)}% used`} max={100} size="sm" tone={window.usedPercent >= 90 ? "caution" : "moving"} />
              {window.resetsAt != null && <span className="text-xs text-ink-tertiary">Resets {new Date(typeof window.resetsAt === "number" ? window.resetsAt * 1000 : window.resetsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>}
            </div>) : <p className="text-sm text-ink-secondary">{usage?.reason ?? (instances.length ? "This connection does not report usage limits." : "Add an assistant connection to view usage.")}</p>}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
          <span className="min-w-0 truncate text-xs text-ink-tertiary">{current?.account ?? current?.config.name ?? ""}</span>
          <Button variant="ghost" size="sm" aria-label="Refresh usage" disabled={loading || !id} onClick={() => setRefresh((value) => value + 1)}><Icon name="retry" className={loading ? "animate-spin" : undefined} />Refresh</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
