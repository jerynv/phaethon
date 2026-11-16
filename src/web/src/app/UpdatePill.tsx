import { useEffect, useState } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { api, type UpdateView } from "./api";
import { useNav } from "./store";

/** A quiet row above Settings when a new version is ready; nothing otherwise. */
export function UpdatePill() {
  const [view, setView] = useState<UpdateView | null>(null);
  const openSettings = useNav((s) => s.openSettings);
  useEffect(() => {
    let live = true;
    void api.updateState().then((v) => live && setView(v), () => {});
    return () => {
      live = false;
    };
  }, []);
  if (view?.status.state !== "available") return null;
  return (
    // Above the footer's hairline, so the footer keeps the one height every bottom bar shares.
    <div className="flex shrink-0 flex-col px-2 pb-1">
      <button
        type="button"
        onClick={() => openSettings("about")}
        className="flex h-7 items-center gap-2 rounded-md bg-primary/8 px-2 text-primary text-sm transition-colors hover:bg-primary/12 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Icon icon={icons.download} className="size-4" />
        <span className="min-w-0 truncate">Update to {view.status.version}</span>
      </button>
    </div>
  );
}
