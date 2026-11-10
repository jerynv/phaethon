import { ChevronRightIcon, SquarePenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useNav } from "./nav";
import { keysFor } from "./shortcuts";
import { SpaceMark } from "./SpaceMark";
import { switchSpace, useCurrentSpace } from "./spaces";
import { newConversation, UNTITLED, type ThreadList } from "./threads";
import { viewLabel } from "./views";

function ShortcutTip({ label, keys }: { label: string; keys: string[] }) {
  return (
    <>
      {label}
      <KbdGroup className="ms-1.5">
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </KbdGroup>
    </>
  );
}

/**
 * The main area's title bar: where you are (space › view, or space ›
 * conversation in Chat), and the sidebar toggle and New chat while the
 * sidebar is hidden. It is the window's drag region on desktop; on macOS it
 * leaves room for the traffic lights when the sidebar is hidden.
 */
export function TitleBar({ list }: { list: ThreadList }) {
  const space = useCurrentSpace();
  const view = useNav((s) => s.view);
  const spaceId = useNav((s) => s.spaceId);
  const { state, isMobile } = useSidebar();
  const sidebarHidden = isMobile || state === "collapsed";
  const current = list.threads?.find((t) => t.current);
  const conversationTitle = current && current.messages > 0 ? current.title : UNTITLED;
  const page = view.kind === "chat" ? conversationTitle : viewLabel(view.kind);

  return (
    <header
      className={cn(
        "drag-region flex h-12 shrink-0 items-center gap-1.5 border-b border-border/70 pe-3",
        sidebarHidden && !isMobile ? "ps-[calc(var(--titlebar-inset-start)+0.5rem)]" : "ps-3",
      )}
      data-workspace-area="titlebar"
      data-workspace-order={1}
      aria-label="Title bar"
      role="region"
      tabIndex={-1}
    >
      {sidebarHidden ? (
        <>
          <Tooltip>
            <TooltipTrigger render={<SidebarTrigger className="size-8 shrink-0 text-muted-foreground" aria-keyshortcuts={keysFor("sidebar").aria} />} />
            <TooltipPopup side="bottom">
              <ShortcutTip label="Show sidebar" keys={keysFor("sidebar").keys} />
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label="New chat"
                  aria-keyshortcuts={keysFor("newChat").aria}
                  onClick={() => void newConversation(spaceId)}
                />
              }
            >
              <SquarePenIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              <ShortcutTip label="New chat" keys={keysFor("newChat").keys} />
            </TooltipPopup>
          </Tooltip>
        </>
      ) : null}

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1 text-sm">
          {space ? (
            <li className="flex min-w-0 shrink items-center">
              <Button
                variant="ghost"
                size="sm"
                className="no-drag max-w-48 gap-2 px-1.5 font-medium text-muted-foreground hover:text-foreground"
                onClick={() => switchSpace(space.id, { kind: "chat" })}
              >
                {sidebarHidden ? <SpaceMark name={space.name} hue={space.hue} className="size-5" /> : null}
                <span className="truncate">{space.name}</span>
              </Button>
            </li>
          ) : null}
          {space ? (
            <li aria-hidden="true" className="flex shrink-0 text-muted-foreground/70">
              <ChevronRightIcon className="size-4" />
            </li>
          ) : null}
          <li className="min-w-0 flex-1">
            <h1 className="truncate px-1 font-medium text-foreground text-sm">
              {page}
            </h1>
          </li>
        </ol>
      </nav>
    </header>
  );
}
