import { ArchiveIcon, ChevronsUpDownIcon, FilePlusIcon, FolderOpenIcon, FolderPlusIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuRadioItemIndicator, MenuSeparator, MenuShortcut, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { announce } from "@/lib/announce";
import { errorText } from "@/lib/core";
import { fileManagerName } from "@/lib/platform";
import { api } from "./api";
import { useNav, type Activity } from "./nav";
import { useShell } from "./shell-store";
import { SpaceMark } from "./SpaceMark";
import { chordText, spaceKeys } from "./shortcuts";
import { switchSpace, useCurrentSpace, useSpaces } from "./spaces";

export const ACTIVITY_WORDS: Record<Activity, { shown: string; spoken: string }> = {
  answering: { shown: "Answering", spoken: "answering" },
  needsYou: { shown: "Needs you", spoken: "needs your answer" },
};

export function ActivityBadge({ activity, className }: { activity: Activity; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 font-medium text-xs leading-4",
        activity === "needsYou"
          ? "bg-warning-surface text-warning-foreground contrast-more:border contrast-more:border-current"
          : "text-muted-foreground",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          activity === "needsYou" ? "bg-warning" : "animate-status-pulse bg-primary",
        )}
      />
      {ACTIVITY_WORDS[activity].shown}
    </span>
  );
}

/**
 * The space switcher at the top of the sidebar: the current space's mark and
 * name; its menu lists every space (with ⌘1…9), what each is doing, and New
 * space. A dot on the trigger says another space needs an answer.
 */
export function SpaceSwitcher() {
  const spaces = useSpaces((s) => s.spaces);
  const status = useSpaces((s) => s.status);
  const current = useCurrentSpace();
  const spaceId = useNav((s) => s.spaceId);
  const activity = useNav((s) => s.activity);
  const openSettings = useNav((s) => s.openSettings);
  const setNewSpaceOpen = useShell((s) => s.setNewSpaceOpen);
  const elsewhereNeedsYou = spaces.some((s) => s.id !== spaceId && activity[s.id] === "needsYou");

  if (status === "loading" && !current) {
    return (
      <div className="flex h-9 flex-1 items-center gap-2 px-2" aria-hidden="true">
        <Skeleton className="size-6 rounded-md" />
        <Skeleton className="h-4 w-24" />
      </div>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        data-target=""
        className={cn(
          "group/switcher no-drag flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[var(--control-radius)] px-1.5 text-start outline-none",
          "hover:bg-sidebar-row-hover data-popup-open:bg-sidebar-row-active focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        )}
        aria-label={`Space: ${current?.name ?? "none"}${elsewhereNeedsYou ? ", another space needs your answer" : ""}. Switch space`}
      >
        {current ? <SpaceMark name={current.name} hue={current.hue} /> : null}
        <span className="min-w-0 flex-1 truncate font-semibold text-sm text-sidebar-foreground">
          {current?.name ?? "Choose a space"}
        </span>
        {elsewhereNeedsYou ? <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-warning" /> : null}
        <ChevronsUpDownIcon aria-hidden="true" className="size-4 shrink-0 text-sidebar-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-72 max-w-[calc(100vw-2rem)]">
        <MenuGroup>
          <MenuGroupLabel>Spaces</MenuGroupLabel>
          <MenuRadioGroup value={spaceId} onValueChange={(id) => switchSpace(String(id))}>
            {spaces.map((s, i) => {
              const a = activity[s.id];
              return (
                <MenuRadioItem
                  key={s.id}
                  value={s.id}
                  className="min-h-10 sm:min-h-9"
                  aria-keyshortcuts={i < 9 ? spaceKeys(i).aria : undefined}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <SpaceMark name={s.name} hue={s.hue} className="size-5 text-[0.75rem]" />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    {a ? <ActivityBadge activity={a} /> : null}
                    <MenuRadioItemIndicator className="text-space-foreground" />
                    {i < 9 && !a ? <MenuShortcut>{chordText(spaceKeys(i).keys)}</MenuShortcut> : null}
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuGroup>
        {current ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>{current.name}</MenuGroupLabel>
              <MenuItem onClick={() => void spaceAction(() => api.showSpace(current.id))}>
                <FolderOpenIcon />
                Show in {fileManagerName()}
              </MenuItem>
              <MenuItem onClick={() => void addFiles(current.id, current.name, false)}>
                <FilePlusIcon />
                Add files…
              </MenuItem>
              <MenuItem onClick={() => void addFiles(current.id, current.name, true)}>
                <FolderPlusIcon />
                Add a folder…
              </MenuItem>
              <MenuItem onClick={() => void exportSpace(current.id)}>
                <ArchiveIcon />
                Export…
              </MenuItem>
            </MenuGroup>
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={() => setNewSpaceOpen(true)}>
          <PlusIcon />
          New space…
        </MenuItem>
        <MenuItem onClick={() => openSettings("spaces")}>
          <Settings2Icon />
          Edit spaces…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

async function spaceAction(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (e) {
    announce(errorText(e));
    window.alert(errorText(e));
  }
}

async function addFiles(id: string, name: string, folder: boolean): Promise<void> {
  await spaceAction(async () => {
    const added = await api.addToSpace(id, folder);
    if (!added) return;
    const skipped = added.skipped ? `, ${added.skipped} left out` : "";
    announce(`Added ${added.files} ${added.files === 1 ? "file" : "files"} to ${name}${skipped}.`);
  });
}

async function exportSpace(id: string): Promise<void> {
  await spaceAction(async () => {
    const done = await api.exportSpace(id);
    if (!done) return;
    announce(`Exported ${done.files} ${done.files === 1 ? "file" : "files"} to ${done.fileName}.`);
    await api.showExport();
  });
}
