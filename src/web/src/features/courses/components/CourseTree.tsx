import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { SiteMark } from "@/components/site-mark";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { sidebarMenuButtonVariants } from "@/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { shortCourseName } from "../lib/course-name";
import { connectionName, kindLabel } from "../lib/sites";
import { COURSE_PARTS, type CourseInfo, type LmsConnection } from "../lib/types";
import { partsOf, useCourses } from "../store";

export type SiteGroup = { id: string; connection: LmsConnection | null; courses: CourseInfo[] };
export type SiteActions = { onImport: (c: LmsConnection) => void; onSignIn: (c: LmsConnection) => void; onDisconnect: (c: LmsConnection) => void; busy: boolean };

/**
 * The tree's geometry, from two tokens: rows start `--tree-pad` in, and the
 * site's chevron and every course's icon sit in a `--tree-icon` column. The
 * guide line runs down the middle of the site's chevron column; courses
 * start right of that column, so their icons line up under the site's mark
 * (the site row's gap is the same `--tree-pad`).
 */
const TREE = "[--tree-icon:--spacing(4)] [--tree-pad:--spacing(2)]";
const GUIDE = "-translate-x-1/2 pointer-events-none absolute inset-y-0 left-[calc(var(--tree-pad)+var(--tree-icon)/2)] w-px bg-border";
const CHILDREN = "relative flex flex-col gap-px pl-[calc(var(--tree-pad)+var(--tree-icon))]";
const ROW = "px-(--tree-pad) gap-(--tree-pad)";

const HIDDEN_OPEN = "phaethon.courses.hiddenOpen";
function readOpen(): Record<string, boolean> {
  try {
    return (JSON.parse(localStorage.getItem(HIDDEN_OPEN) ?? "null") as Record<string, boolean> | null) ?? {};
  } catch {
    return {};
  }
}

/** Whether each site's hidden courses are shown, remembered per site. */
function useHiddenOpen() {
  const [open, setOpen] = useState(readOpen);
  const toggle = (site: string) =>
    setOpen((o) => {
      const next = { ...o };
      if (o[site]) delete next[site];
      else next[site] = true;
      try {
        localStorage.setItem(HIDDEN_OPEN, JSON.stringify(next));
      } catch {
        // Private window: it lasts for the session.
      }
      return next;
    });
  return [open, toggle] as const;
}

const matches = (c: CourseInfo, q: string) => c.name.toLowerCase().includes(q) || shortCourseName(c.name).toLowerCase().includes(q) || (c.code ?? "").toLowerCase().includes(q);

const fold = { initial: { height: 0, opacity: 0 }, animate: { height: "auto", opacity: 1 }, exit: { height: 0, opacity: 0 }, transition: { duration: 0.16 } } as const;

/**
 * The left pane's list (docs/UI-REBUILD.md › Courses): each course site is a
 * folder; under it, on a guide line from its chevron, the courses this space
 * sees, then the ones it doesn't folded into one quiet "8 hidden" row.
 */
export function CourseTree({
  space,
  groups,
  query,
  openKey,
  onOpen,
  ...actions
}: { space: string; groups: SiteGroup[]; query: string; openKey: string | undefined; onOpen: (key: string) => void } & SiteActions) {
  const access = useCourses((s) => s.access.data);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [hiddenOpen, toggleHidden] = useHiddenOpen();
  const q = query.trim().toLowerCase();
  const isHidden = (c: CourseInfo) => partsOf(access, space, c.key).length === 0;

  return (
    <div className={cn("flex flex-col", TREE)}>
      {groups.map((g) => {
        const list = q ? g.courses.filter((c) => matches(c, q)) : g.courses;
        if (q && !list.length) return null;
        const isFolded = !q && folded[g.id];
        const shown = list.filter((c) => !isHidden(c));
        const hidden = list.filter(isHidden);
        // A search shows the hidden courses it finds.
        const hiddenShown = !!q || !!hiddenOpen[g.id];
        return (
          <div key={g.id} className="flex flex-col">
            <SiteRow connection={g.connection} folded={!!isFolded} onFold={() => setFolded((f) => ({ ...f, [g.id]: !f[g.id] }))} {...actions} />
            <AnimatePresence initial={false}>
              {!isFolded ? (
                <motion.div {...fold} className="overflow-hidden">
                  <div className={CHILDREN}>
                    <span aria-hidden className={GUIDE} />
                    {shown.map((c) => (
                      <CourseRow key={c.key} course={c} selected={openKey === c.key} onOpen={() => onOpen(c.key)} />
                    ))}
                    {hidden.length ? (
                      <HiddenGroup count={hidden.length} open={hiddenShown} disabled={!!q} onToggle={() => toggleHidden(g.id)}>
                        {hidden.map((c) => (
                          <HiddenRow key={c.key} space={space} course={c} selected={openKey === c.key} onOpen={() => onOpen(c.key)} />
                        ))}
                      </HiddenGroup>
                    ) : null}
                    {!g.courses.length && g.connection?.signedIn ? (
                      <button
                        type="button"
                        disabled={actions.busy}
                        onClick={() => g.connection && actions.onImport(g.connection)}
                        className={cn(sidebarMenuButtonVariants(), ROW, "text-primary hover:bg-primary/6 hover:text-primary [&>svg]:text-primary")}
                      >
                        <Icon icon={icons.download} className="size-4" />
                        Import courses
                      </button>
                    ) : !g.courses.length ? (
                      <p className={cn("flex h-7 items-center text-muted-foreground text-xs", ROW)}>No courses imported yet.</p>
                    ) : null}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        );
      })}
      {q && !groups.some((g) => g.courses.some((c) => matches(c, q))) ? <p className="px-(--tree-pad) py-2 text-muted-foreground text-sm">No course matches “{query.trim()}”.</p> : null}
    </div>
  );
}

/** A site in the tree: a folder that folds its courses away, its sign-in state, and its actions on hover. */
function SiteRow({ connection: c, folded, onFold, onImport, onSignIn, onDisconnect, busy }: { connection: LmsConnection | null; folded: boolean; onFold: () => void } & SiteActions) {
  return (
    <div className="group flex h-8 items-center gap-1 rounded-md pr-1 transition-colors hover:bg-accent">
      <button
        type="button"
        aria-expanded={!folded}
        onClick={onFold}
        className="flex h-full min-w-0 flex-1 items-center gap-(--tree-pad) rounded-md pl-(--tree-pad) text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex w-(--tree-icon) shrink-0 justify-center" data-testid="site-chevron">
          <Icon icon={icons.chevronDown} className={cn("size-3.5 text-muted-foreground transition-transform", folded && "-rotate-90")} />
        </span>
        {c ? <SiteMark connection={c} className="size-4" /> : <Icon icon={icons.folder} className="size-4 text-muted-foreground" />}
        <Truncate className="min-w-0 font-medium">{c ? connectionName(c) : "Other courses"}</Truncate>
        {c ? (
          <Tooltip>
            <TooltipTrigger render={<span className={cn("size-1.5 shrink-0 rounded-full", c.signedIn ? "bg-success" : "bg-warning")} aria-label={c.signedIn ? "Signed in" : "Signed out"} />} />
            <TooltipPopup>
              {kindLabel(c.kind)} · {c.signedIn ? "signed in" : "signed out"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </button>
      {c && !c.signedIn ? (
        <Button size="xs" variant="ghost" className="text-primary" onClick={() => onSignIn(c)}>
          Sign in
        </Button>
      ) : null}
      {c ? (
        <Menu>
          <MenuTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label={`${connectionName(c)} actions`} className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100" />}>
            <Icon icon={icons.more} />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem disabled={!c.signedIn || busy} onClick={() => onImport(c)}>
              <Icon icon={icons.download} />
              Import courses
            </MenuItem>
            <MenuItem onClick={() => onSignIn(c)}>
              <Icon icon={icons.signIn} />
              Sign in again
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => onDisconnect(c)}>
              <Icon icon={icons.disconnected} />
              Disconnect
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}

/** The course's name as the site gives it and its code: what the short row name leaves out. */
function RawName({ course }: { course: CourseInfo }) {
  return (
    <span className="flex flex-col">
      <span>{course.name}</span>
      {course.code ? <span className="text-muted-foreground">{course.code}</span> : null}
    </span>
  );
}

/** A course this space sees: 28 px, its icon in the tree's icon column, its short name. */
function CourseRow({ course, selected, onOpen }: { course: CourseInfo; selected: boolean; onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-current={selected ? "true" : undefined}
            data-active={selected}
            onClick={onOpen}
            className={cn(sidebarMenuButtonVariants(), ROW, "focus-visible:ring-2", selected && "[&>svg]:text-foreground")}
          />
        }
      >
        <Icon icon={icons.courses} className="size-4" />
        <span className="min-w-0 flex-1 truncate">{shortCourseName(course.name)}</span>
      </TooltipTrigger>
      <TooltipPopup side="right">
        <RawName course={course} />
      </TooltipPopup>
    </Tooltip>
  );
}

/** One quiet row for the courses this space doesn't see; open, it lists them compact under it. */
function HiddenGroup({ count, open, disabled, onToggle, children }: { count: number; open: boolean; disabled: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-px">
      <button
        type="button"
        aria-expanded={open}
        disabled={disabled}
        onClick={onToggle}
        className={cn(sidebarMenuButtonVariants({ tone: "muted" }), ROW, "focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-100")}
        data-testid="hidden-courses"
      >
        <span className="flex w-(--tree-icon) shrink-0 justify-center">
          <Icon icon={icons.chevronDown} className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
        </span>
        <span className="min-w-0 flex-1 truncate">{count} hidden</span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div {...fold} className="overflow-hidden">
            <div className="flex flex-col gap-px" role="group" aria-label="Hidden from this space">
              {children}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** A course this space doesn't see: compact and subtle, with Show in this space on hover. */
function HiddenRow({ space, course, selected, onOpen }: { space: string; course: CourseInfo; selected: boolean; onOpen: () => void }) {
  const setParts = useCourses((s) => s.setParts);
  const name = shortCourseName(course.name);
  return (
    <div className="group/hidden relative flex">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-current={selected ? "true" : undefined}
              data-active={selected}
              onClick={onOpen}
              className={cn(sidebarMenuButtonVariants({ size: "sm" }), ROW, "pr-8 text-subtle-foreground focus-visible:ring-2")}
            />
          }
        >
          <span aria-hidden className="w-(--tree-icon) shrink-0" />
          <span className="min-w-0 flex-1 truncate">{name}</span>
        </TooltipTrigger>
        <TooltipPopup side="right">
          <RawName course={course} />
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Show ${name} in this space`}
              onClick={() => void setParts(space, course.key, COURSE_PARTS.map((p) => p.part))}
              className="-translate-y-1/2 absolute top-1/2 right-0.5 opacity-0 focus-visible:opacity-100 group-hover/hidden:opacity-100"
            />
          }
        >
          <Icon icon={icons.view} />
        </TooltipTrigger>
        <TooltipPopup>Show in this space</TooltipPopup>
      </Tooltip>
    </div>
  );
}
