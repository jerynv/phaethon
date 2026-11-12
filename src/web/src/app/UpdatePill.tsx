import { ArrowDownCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
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
    <button
      type="button"
      onClick={() => openSettings("about")}
      className="flex h-7 items-center gap-2 rounded-md bg-primary/8 px-2 text-primary text-sm transition-colors hover:bg-primary/12"
    >
      <ArrowDownCircleIcon className="size-4" strokeWidth={1.75} />
      <span className="min-w-0 truncate">Update to {view.status.version}</span>
    </button>
  );
}
