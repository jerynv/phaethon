import { memo, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { SpaceAvatar } from "@/components/space-avatar";
import { toast } from "@/components/toast";
import { Truncate } from "@/components/truncate";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuTrail } from "@/components/ui/sidebar";
import { convState, useChats } from "@/features/chat/store";
import { errorText } from "@/lib/core";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { api, type SpaceView } from "../api";
import { useNav, type ThreadRow } from "../store";
import { WorkingMark } from "./rows";

/** How many of a space's conversations are replying and waiting, and whether any has a new reply. */
export function useSpaceActivity(space: string, threads: ThreadRow[] | undefined) {
  const prefix = `${space}/`;
  const local = useChats(
    useShallow((s) => {
      let working = 0;
      let waiting = 0;
      const seen: string[] = [];
      for (const [key, c] of Object.entries(s.convs)) {
        if (!key.startsWith(prefix)) continue;
        seen.push(key.slice(prefix.length));
        const st = convState(c);
        if (st === "working") working++;
        else if (st === "waiting") waiting++;
      }
      return { working, waiting, seen: seen.join(",") };
    }),
  );
  const elsewhere = useMemo(() => {
    const known = new Set(local.seen.split(","));
    return (threads ?? []).filter((t) => t.running && !known.has(t.id)).length;
  }, [threads, local.seen]);
  const unread = useNav((s) => Object.keys(s.unread).some((k) => k.startsWith(prefix)));
  return { working: local.working + elsewhere, waiting: local.waiting, unread };
}

export function SpaceMenuItems({ space, Item }: { space: SpaceView; Item: typeof MenuItem }) {
  const newChat = useNav((s) => s.newChat);
  const openSettings = useNav((s) => s.openSettings);
  return (
    <>
      <Item onClick={() => void newChat(space.id)}>
        <Icon icon={icons.newChat} />
        New chat
      </Item>
      <Item onClick={() => void api.showSpace(space.id).catch((e) => toast.error("Couldn’t show the folder", errorText(e)))}>
        <Icon icon={icons.folderOpen} />
        Show folder
      </Item>
      <Item onClick={() => openSettings("spaces")}>
        <Icon icon={icons.settings} />
        Space settings
      </Item>
    </>
  );
}

type HeaderProps = { space: SpaceView; index: number; folded: boolean; count: number; standIn: boolean; filtering: boolean };

/**
 * A space's row, sticky at the top of the list while its conversations
 * scroll under it. Folded (or while filtering) it shows its count, and how
 * many of its conversations are busy, waiting or have a new reply.
 */
export const SpaceHeader = memo(function SpaceHeader({ space, index, folded, count, standIn, filtering }: HeaderProps) {
  const active = useNav((s) => s.activeSpace === space.id);
  const settingsOpen = useNav((s) => s.settings !== null);
  const threads = useNav((s) => s.threads[space.id]?.data);
  const toggleCollapsed = useNav((s) => s.toggleCollapsed);
  const selectSpace = useNav((s) => s.selectSpace);
  const newChat = useNav((s) => s.newChat);
  const [menu, setMenu] = useState(false);
  const activity = useSpaceActivity(space.id, threads);
  const hideOnHover = "group-hover/menu-item:hidden group-has-focus-visible/menu-item:hidden group-data-[keep=true]/menu-item:hidden";
  const summary = folded || filtering;

  return (
    <div className="group/menu-item sticky top-0 z-20 h-7 bg-sidebar" data-item-key={`space:${space.id}`} data-keep={menu || undefined}>
      <SidebarMenuButton
        aria-label={`Go to ${space.name}`}
        isActive={standIn}
        data-nav-row=""
        onClick={() => selectSpace(space.id)}
        onKeyDown={(e) => {
          if (filtering) return;
          if (e.key === "ArrowRight" && folded) toggleCollapsed(space.id);
          else if (e.key === "ArrowLeft" && !folded) toggleCollapsed(space.id);
        }}
        className="group-hover/menu-item:pr-18 group-has-focus-visible/menu-item:pr-18 group-data-[keep=true]/menu-item:pr-18"
      >
        <SpaceAvatar name={space.name} hue={space.hue} />
        <Truncate className={cn("flex-1", active && !settingsOpen ? "text-foreground" : "text-sidebar-foreground")}>{space.name}</Truncate>
        {summary ? (
          <span className={cn("ml-auto flex shrink-0 items-center gap-1.5 pl-1", hideOnHover)}>
            {activity.working && !filtering ? (
              <span className="flex items-center gap-1 text-2xs text-info-foreground tabular-nums" aria-label={`${activity.working} replying`}>
                <WorkingMark />
                {activity.working > 1 ? activity.working : null}
              </span>
            ) : null}
            {activity.waiting && !filtering ? <span className="size-1.5 rounded-full bg-warning" aria-label={`${activity.waiting} need you`} /> : null}
            {activity.unread && !filtering ? <span className="size-1.5 rounded-full bg-primary" aria-label="New reply" /> : null}
            {count ? (
              <span className="min-w-4 text-right text-2xs text-subtle-foreground type-live" aria-label={filtering ? `${count} matching` : `${count} conversations`}>
                {count}
              </span>
            ) : null}
          </span>
        ) : index < 9 && isMac() ? (
          <SidebarMenuBadge>⌘{index + 1}</SidebarMenuBadge>
        ) : null}
      </SidebarMenuButton>
      <SidebarMenuTrail keep={menu}>
        {filtering ? null : (
          <SidebarMenuAction tabIndex={-1} aria-expanded={!folded} aria-label={`${folded ? "Expand" : "Collapse"} ${space.name}`} onClick={() => toggleCollapsed(space.id)}>
            <Icon icon={icons.chevronRight} className={cn("transition-transform duration-150 ease-out-soft", !folded && "rotate-90")} />
          </SidebarMenuAction>
        )}
        <Menu open={menu} onOpenChange={setMenu}>
          <MenuTrigger render={<SidebarMenuAction aria-label={`${space.name} actions`} />}>
            <Icon icon={icons.more} />
          </MenuTrigger>
          <MenuPopup align="start" side="right">
            <SpaceMenuItems space={space} Item={MenuItem} />
          </MenuPopup>
        </Menu>
        <SidebarMenuAction aria-label={`New chat in ${space.name}`} onClick={() => void newChat(space.id)}>
          <Icon icon={icons.newChat} />
        </SidebarMenuAction>
      </SidebarMenuTrail>
    </div>
  );
});
