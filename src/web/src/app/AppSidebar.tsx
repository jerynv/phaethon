import { SearchIcon, SettingsIcon, SquarePenIcon } from "lucide-react";
import { useState } from "react";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ConversationList } from "./ConversationList";
import { useNav } from "./nav";
import { useShell } from "./shell-store";
import { keysFor, viewKeys } from "./shortcuts";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { switchSpace, useCurrentSpace } from "./spaces";
import { newConversation, type ThreadList } from "./threads";
import { visibleViews } from "./views";

function Keys({ keys }: { keys: string[] }) {
  return (
    <KbdGroup className="ms-auto opacity-0 transition-opacity group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100">
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </KbdGroup>
  );
}

function GroupLabel({ children, id }: { children: string; id?: string }) {
  return (
    <h2 id={id} className="px-2.5 pt-1 pb-1.5 font-medium text-xs text-sidebar-muted-foreground">
      {children}
    </h2>
  );
}

/**
 * The app sidebar: the space switcher, New chat and Search, the space's views
 * (education spaces), its conversations, and Settings. Collapsible and
 * resizable on desktop; a sheet at phone width.
 */
export function AppSidebar({ list }: { list: ThreadList }) {
  const space = useCurrentSpace();
  const spaceId = useNav((s) => s.spaceId);
  const view = useNav((s) => s.view);
  const openSettings = useNav((s) => s.openSettings);
  const setSearchOpen = useShell((s) => s.setSearchOpen);
  const { isMobile, setOpenMobile } = useSidebar();
  const [error, setError] = useState<string | null>(null);
  const views = visibleViews(space?.educationEnabled ?? false);
  const closeIfMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar
      collapsible="offcanvas"
      resizable={{ minWidth: 232, maxWidth: 420, storageKey: "phaethon.sidebar-width" }}
      aria-label="Sidebar"
      className="border-sidebar-border"
    >
      <nav
        aria-label="Spaces and conversations"
        data-workspace-area="sidebar"
        data-workspace-order={0}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
        <SidebarHeader className="drag-region gap-1 px-2 pt-0 pb-1">
          <div className="flex h-12 items-center gap-1 ps-[var(--titlebar-inset-start)] max-md:ps-0">
            <SpaceSwitcher />
            <Tooltip>
              <TooltipTrigger render={<SidebarTrigger className="size-8 shrink-0 text-sidebar-muted-foreground" aria-keyshortcuts={keysFor("sidebar").aria} />} />
              <TooltipPopup side="bottom">
                Hide sidebar <KbdGroup className="ms-1">{keysFor("sidebar").keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</KbdGroup>
              </TooltipPopup>
            </Tooltip>
          </div>
          <SidebarMenu className="gap-0.5">
            <SidebarMenuItem>
              <SidebarMenuButton
                className="font-normal text-sidebar-foreground"
                aria-keyshortcuts={keysFor("newChat").aria}
                onClick={async () => {
                  setError(null);
                  const problem = await newConversation(spaceId);
                  if (problem) setError(problem);
                  else closeIfMobile();
                }}
              >
                <SquarePenIcon />
                <span>New chat</span>
                <Keys keys={keysFor("newChat").keys} />
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                className="font-normal text-sidebar-foreground"
                aria-keyshortcuts={keysFor("search").aria}
                onClick={() => {
                  closeIfMobile();
                  setSearchOpen(true);
                }}
              >
                <SearchIcon />
                <span>Search</span>
                <Keys keys={keysFor("search").keys} />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          {views.length > 1 ? (
            <SidebarGroup aria-labelledby="sidebar-views-heading" role="group" className="pt-1">
              <h2 id="sidebar-views-heading" className="sr-only">
                Views
              </h2>
              <SidebarMenu className="gap-0.5">
                {views.map((v, i) => {
                  const active = view.kind === v.kind;
                  // In Chat the open conversation carries the fill; Chat itself is marked by weight and icon.
                  const quiet = active && v.kind === "chat";
                  const Icon = v.icon;
                  return (
                    <SidebarMenuItem key={v.kind}>
                      <SidebarMenuButton
                        isActive={active && !quiet}
                        aria-current={active ? "page" : undefined}
                        aria-keyshortcuts={viewKeys(i).aria}
                        className={cn("font-normal text-sidebar-foreground", quiet && "font-medium [&>svg]:text-space-foreground")}
                        onClick={() => {
                          switchSpace(spaceId, { kind: v.kind });
                          closeIfMobile();
                        }}
                      >
                        <Icon />
                        <span>{v.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          ) : null}

          <SidebarGroup aria-labelledby="sidebar-conversations-heading" role="group">
            <GroupLabel id="sidebar-conversations-heading">Conversations</GroupLabel>
            {error ? (
              <p role="alert" className="mx-2.5 mb-1.5 rounded-md bg-error-surface px-2 py-1.5 text-error-foreground text-sm">
                {error}
              </p>
            ) : null}
            <ConversationList spaceId={spaceId} list={list} onError={setError} />
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="border-t border-sidebar-border px-2 pt-1.5 pb-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                className="font-normal text-sidebar-foreground"
                aria-keyshortcuts={keysFor("settings").aria}
                aria-haspopup="dialog"
                onClick={() => {
                  closeIfMobile();
                  openSettings();
                }}
              >
                <SettingsIcon />
                <span>Settings</span>
                <Keys keys={keysFor("settings").keys} />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </nav>
      <SidebarRail />
    </Sidebar>
  );
}
