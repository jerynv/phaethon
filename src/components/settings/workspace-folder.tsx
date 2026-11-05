import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { useSpaceActivity } from "@/lib/activity";
import { bindWorkspace, chooseWorkspace, clearWorkspace, getWorkspace, WORKSPACE_CHANGED, type WorkspaceLocation } from "@/lib/workspace";

export function WorkspaceFolderSetting({ space }: { space: string }) {
  const [location, setLocation] = useState<WorkspaceLocation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const activity = useSpaceActivity();
  useEffect(() => {
    let live = true;
    const load = () => getWorkspace(space).then(value => { if (live) { setLocation(value); setError(""); } }, e => live && setError(String(e)));
    void load(); window.addEventListener(WORKSPACE_CHANGED, load);
    return () => { live = false; window.removeEventListener(WORKSPACE_CHANGED, load); };
  }, [space]);
  const change = async (clear: boolean) => {
    setBusy(true); setError("");
    try {
      if (clear) setLocation(await clearWorkspace(space));
      else { const choice = await chooseWorkspace(); if (choice) setLocation(await bindWorkspace(space, choice)); }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <div className="flex flex-col gap-1.5" data-workspace-folder={space}>
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex-1 text-sm font-normal text-ink">CLI workspace</span>
      {location?.kind === "folder" && <Button type="button" variant="ghost" size="sm" disabled={busy || activity[space]?.running} onClick={() => void change(true)}>Use managed folder</Button>}
      <Button type="button" variant="outline" size="sm" data-change-workspace="" disabled={busy || activity[space]?.running} onClick={() => void change(false)}><Icon name="folder" className="size-3.5" />{busy ? "Choosing…" : "Choose folder…"}</Button>
    </div>
    {location && <p className="text-xs wrap-anywhere text-ink-secondary" data-workspace-location="">{location.path}{!location.available && <span className="ms-2 text-danger-ink">Unavailable</span>}</p>}
    {error && <p role="alert" className="text-xs text-danger-ink">{error}</p>}
  </div>;
}
