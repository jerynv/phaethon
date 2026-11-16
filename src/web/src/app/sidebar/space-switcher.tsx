import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { SpaceAvatar } from "@/components/space-avatar";
import { toast } from "@/components/toast";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";
import { api, type SpaceView } from "../api";
import { spaceKeys } from "../shortcuts";
import { NO_SPACES, useActiveSpace, useNav } from "../store";
import { WorkingMark } from "./rows";
import { useSpaceActivity } from "./space-header";

/**
 * The space switcher at the top of the sidebar: the space on show, as a row
 * that opens a menu of every space (with what each is busy with) and the
 * space's own actions. Only the chosen space's conversations are listed
 * below it, so spaces never compete for the sidebar's height.
 *
 * Switching sweeps a thin line under the row while the new space comes in
 * (and for as long as its conversations are still loading).
 */

/** How long the sweep runs for a switch whose conversations are already here. */
const SWEEP_MS = 560;

/** Replying, needs-you and new-reply marks for one space. */
function Activity({ space, quiet = false }: { space: SpaceView; quiet?: boolean }) {
  const threads = useNav((s) => s.threads[space.id]?.data);
  const a = useSpaceActivity(space.id, threads);
  if (!a.working && !a.waiting && !a.unread) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {a.working ? (
        <span className="flex items-center gap-1 text-2xs text-info-foreground tabular-nums" aria-label={`${a.working} replying`}>
          <WorkingMark />
          {a.working > 1 && !quiet ? a.working : null}
        </span>
      ) : null}
      {a.waiting ? <span className="size-1.5 rounded-full bg-warning" aria-label={`${a.waiting} need you`} /> : null}
      {a.unread ? <span className="size-1.5 rounded-full bg-primary" aria-label="New reply" /> : null}
    </span>
  );
}

/** Whether any space but the one on show has something going on (the trigger shows one quiet dot for them). */
function useElsewhere(spaces: SpaceView[], active: string | undefined): boolean {
  const unread = useNav((s) => Object.keys(s.unread).some((k) => !k.startsWith(`${active}/`)));
  const running = useNav((s) => spaces.some((sp) => sp.id !== active && s.threads[sp.id]?.data?.some((t) => t.running)));
  return unread || running;
}

export function SpaceSwitcher({ onNewSpace, onDown }: { onNewSpace: () => void; onDown: () => void }) {
  const spaces = useNav((s) => s.spaces.data) ?? NO_SPACES;
  const active = useActiveSpace();
  const selectSpace = useNav((s) => s.selectSpace);
  const openSettings = useNav((s) => s.openSettings);
  const newChat = useNav((s) => s.newChat);
  const loading = useNav((s) => !!s.activeSpace && !s.threads[s.activeSpace]?.data && !s.threads[s.activeSpace]?.error);
  const elsewhere = useElsewhere(spaces, active?.id);
  const [open, setOpen] = useState(false);

  // A switch sweeps the line once; a space still loading keeps it going.
  const [sweeping, setSweeping] = useState(false);
  const shown = useRef(active?.id);
  useEffect(() => {
    if (!active || shown.current === active.id) return;
    const first = shown.current === undefined;
    shown.current = active.id;
    if (first) return;
    setSweeping(true);
    const t = setTimeout(() => setSweeping(false), SWEEP_MS);
    return () => clearTimeout(t);
  }, [active]);
  const busy = sweeping || loading;

  if (!active) return null;
  return (
    <div className="relative">
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label={`Space: ${active.name}`}
              aria-busy={busy || undefined}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && !open) {
                  e.preventDefault();
                  onDown();
                }
              }}
              className="group/switcher flex h-(--pane-row-height) w-full min-w-0 items-center gap-2 rounded-md pr-1.5 pl-2 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent"
            />
          }
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            <SpaceAvatar key={active.id} name={active.name} hue={active.hue} className="size-2.5 animate-in zoom-in-50 duration-200" />
          </span>
          <span key={active.id} className="min-w-0 flex-1 truncate font-medium text-foreground animate-in fade-in slide-in-from-bottom-1 duration-200">
            {active.name}
          </span>
          {elsewhere ? <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="Something new in another space" /> : null}
          <Icon icon={icons.chevronsUpDown} className="size-4 shrink-0 text-subtle-foreground transition-colors group-hover/switcher:text-muted-foreground" />
        </MenuTrigger>
        <MenuPopup align="start" className="min-w-(--anchor-width)">
          <MenuGroup>
            <MenuGroupLabel>Spaces</MenuGroupLabel>
            {spaces.map((s, i) => {
              const keys = i < 9 ? spaceKeys(i).keys : null;
              return (
                <MenuItem key={s.id} aria-current={s.id === active.id ? "true" : undefined} onClick={() => selectSpace(s.id)}>
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <SpaceAvatar name={s.name} hue={s.hue} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <Activity space={s} quiet />
                  {s.id === active.id ? (
                    <Icon icon={icons.check} className="size-3.5 text-foreground" />
                  ) : keys ? (
                    <KbdGroup className="ml-2">
                      {keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </KbdGroup>
                  ) : null}
                </MenuItem>
              );
            })}
          </MenuGroup>
          <MenuSeparator />
          <MenuItem onClick={onNewSpace}>
            <Icon icon={icons.add} />
            New space
          </MenuItem>
          <MenuItem onClick={() => void newChat(active.id).catch((e) => toast.error("Couldn’t start a new chat", errorText(e)))}>
            <Icon icon={icons.newChat} />
            New chat in {active.name}
          </MenuItem>
          <MenuItem onClick={() => void api.showSpace(active.id).catch((e) => toast.error("Couldn’t show the folder", errorText(e)))}>
            <Icon icon={icons.folderOpen} />
            Show folder
          </MenuItem>
          <MenuItem onClick={() => openSettings("spaces")}>
            <Icon icon={icons.settings} />
            Space settings
          </MenuItem>
        </MenuPopup>
      </Menu>
      <span aria-hidden className={cn("pointer-events-none absolute inset-x-2 -bottom-0.5 h-px overflow-hidden rounded-full transition-opacity duration-200", busy ? "opacity-100" : "opacity-0")}>
        <span className={cn("block h-full w-full bg-linear-to-r from-transparent via-primary to-transparent", busy && "animate-[space-sweep_560ms_var(--ease-out-soft)_infinite]")} />
      </span>
    </div>
  );
}
