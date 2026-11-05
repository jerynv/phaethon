import { useEffect, useRef, useState } from "react";
import { Progress, Skeleton } from "vic-ui";

import { ProviderLogo } from "@/components/provider-logo";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IconTip } from "@/components/ui/tooltip";
import { Icon } from "@/icons";
import { agentInstances, agentInstanceUsage, type AgentInstanceUsage, type AgentInstanceView } from "@/lib/backend";

export const OPEN_USAGE_EVENT = "phaethon:open-usage";
type AccountUsage = { state: "loading" } | { state: "ready"; value: AgentInstanceUsage } | { state: "error"; message: string };

function resetLabel(value: string | number | null) {
  if (value == null) return null;
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : `Resets ${date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

/** T3's UsageLimits/UsageLimitsPooled: every account remains visible, with independent windows.
 * The host queries at most two CLI homes at a time. Missing limits never become zero usage.
 */
export function UsageDialog() {
  const [open, setOpen] = useState(false);
  const [instances, setInstances] = useState<AgentInstanceView[]>([]);
  const [results, setResults] = useState<Record<string, AccountUsage>>({});
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const restoreFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const show = () => {
      restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
    };
    window.addEventListener(OPEN_USAGE_EVENT, show);
    return () => window.removeEventListener(OPEN_USAGE_EVENT, show);
  }, []);
  useEffect(() => {
    if (!open) return;
    const current = ++generation.current;
    const active = () => generation.current === current;
    setInstances([]); setResults({}); setError(""); setLoading(true);
    void (async () => {
      try {
        const items = await agentInstances();
        if (!active()) return;
        setInstances(items);
        const initial: Record<string, AccountUsage> = {};
        for (const item of items) {
          initial[item.config.id] = !item.installed || item.loggedIn === false
            ? { state: "ready", value: { available: false, windows: [], reason: !item.installed ? "Not installed" : "Sign in to view usage." } }
            : { state: "loading" };
        }
        setResults(initial);
        const queue = items.filter((item) => item.installed && item.loggedIn !== false);
        let index = 0;
        const read = async () => {
          while (active() && index < queue.length) {
            const item = queue[index++];
            try {
              const value = await agentInstanceUsage(item.config.id);
              if (active()) setResults((previous) => ({ ...previous, [item.config.id]: { state: "ready", value } }));
            } catch (reason) {
              if (active()) setResults((previous) => ({ ...previous, [item.config.id]: { state: "error", message: String(reason) } }));
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(2, queue.length) }, read));
      } catch (reason) {
        if (active()) setError(String(reason));
      } finally {
        if (active()) setLoading(false);
      }
    })();
    return () => { ++generation.current; };
  }, [open, refresh]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-usage-dialog="" className="flex max-w-3xl! flex-col gap-4! overflow-hidden" onCloseAutoFocus={(event) => {
        const target = restoreFocus.current;
        if (target?.isConnected && !target.closest("[hidden], [inert]")) { event.preventDefault(); target.focus(); }
      }}>
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>Usage</DialogTitle>
            <IconTip label="Refresh usage" spoken="Refresh usage"><Button variant="ghost" size="icon-sm" aria-label="Refresh usage" disabled={loading} onClick={() => setRefresh((value) => value + 1)}><Icon name="retry" className={loading ? "animate-spin" : undefined} /></Button></IconTip>
          </div>
          <DialogDescription className="sr-only">Usage limits across your assistant connections.</DialogDescription>
        </DialogHeader>
        <div data-instance-usage="" className="grid min-h-0 min-w-0 gap-3 overflow-y-auto [grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr))]">
          {instances.map((instance) => {
            const result = results[instance.config.id];
            const windows = result?.state === "ready" && result.value.available ? result.value.windows.filter((window) => typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)) : [];
            return <section key={instance.config.id} data-usage-account={instance.config.id} className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface px-3 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <ProviderLogo provider={`${instance.config.cli}-cli`} className="size-5 shrink-0" />
                <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium text-ink">{instance.config.name}</h3><p data-usage-source={instance.source ?? (instance.managedHome ? "managed" : "system")} className="text-xs leading-normal wrap-anywhere text-ink-secondary">{[instance.source === "system" ? "System CLI" : "Phaethon-managed", instance.account, instance.plan].filter(Boolean).join(" · ")}</p></div>
              </div>
              {!result || result.state === "loading" ? <div role="status" aria-label={`Loading ${instance.config.name} usage`} className="flex flex-col gap-2"><Skeleton className="h-2 w-full" /><Skeleton className="h-2 w-2/3" /></div>
                : result.state === "error" ? <p role="alert" className="text-xs text-danger-ink">{result.message}</p>
                : windows.length ? windows.map((window, index) => <div key={`${window.label}-${index}`} className="flex min-w-0 flex-col gap-1.5 [&_.ui-progress-label]:font-normal" data-usage-window={window.label}>
                  <Progress label={window.label} value={window.usedPercent} valueText={`${Math.round(window.usedPercent)}% used`} max={100} size="sm" tone={window.usedPercent >= 90 ? "caution" : "moving"} />
                  {resetLabel(window.resetsAt) && <span className="text-xs text-ink-tertiary">{resetLabel(window.resetsAt)}</span>}
                </div>) : <p className="text-xs text-ink-secondary">{result.value.reason ?? "Usage not reported."}</p>}
            </section>;
          })}
          {loading && !instances.length && <div role="status" aria-label="Loading connections" className="col-span-full flex flex-col gap-3"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
          {error && <p role="alert" className="col-span-full text-sm text-danger-ink">{error}</p>}
          {!loading && !error && !instances.length && <p className="col-span-full text-sm text-ink-secondary">Add an assistant connection to view usage.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
