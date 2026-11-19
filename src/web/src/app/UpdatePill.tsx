import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { openUpdateDialog, useUpdateView } from "@/features/updates/UpdateDialogs";

/**
 * A quiet row above Settings while a new version is ready; nothing otherwise.
 * It follows the update dialog's state, so it appears once the check after
 * launch finds a release (and stays after Later), and opens that dialog.
 */
export function UpdatePill() {
  const view = useUpdateView();
  if (view?.status.state !== "available") return null;
  const version = view.status.version;
  return (
    // Above the footer's hairline, so the footer keeps the one height every bottom bar shares.
    <div className="flex shrink-0 flex-col px-2 pb-1">
      <button
        type="button"
        onClick={() => openUpdateDialog()}
        className="flex h-7 items-center gap-2 rounded-md bg-primary/8 px-2 text-primary text-sm transition-colors hover:bg-primary/12 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Icon icon={icons.download} className="size-4" />
        <span className="min-w-0 truncate">Update to {version}</span>
      </button>
    </div>
  );
}
