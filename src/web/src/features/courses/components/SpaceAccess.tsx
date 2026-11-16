import { useMemo, useState } from "react";
import { SurfaceError } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { SkeletonCard } from "@/components/skeletons";
import { SpaceAvatar } from "@/components/space-avatar";
import { Truncate } from "@/components/truncate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";
import { connectionName } from "../lib/sites";
import { courseGroups, sortSpaces, type CourseRow } from "../lib/space-access";
import { COURSE_PARTS, type SpaceSummary } from "../lib/types";
import { useCourses } from "../store";
import { AccessPicker, type PickerItem } from "./AccessPicker";

/** Rows shown before "Show more"; a search narrows past it. */
const PAGE = 30;
/** A search field once the list is longer than this. */
const SEARCH_FROM = 8;
/** Space chips on a row before "+N". */
const CHIPS = 3;
const ALL_PARTS = COURSE_PARTS.map((p) => p.part);

type Space = { id: string; name: string; hue: number; educationEnabled?: boolean };

function spaceList(ids: string[], known: SpaceSummary[]): Space[] {
  return sortSpaces(
    ids.map((id) => {
      const s = known.find((k) => k.id === id);
      return { id, name: s?.name ?? id, hue: s?.hue ?? 200, educationEnabled: s?.educationEnabled };
    }),
  );
}

function SpaceChip({ space, some }: { space: Space; some?: boolean }) {
  return (
    <Badge variant="outline" className={cn("max-w-32 gap-1.5 font-normal", some && "border-dashed text-muted-foreground")}>
      <SpaceAvatar hue={space.hue} />
      <span className="min-w-0 truncate">{space.name}</span>
    </Badge>
  );
}

function SpacesCell({ row, spaces }: { row: CourseRow; spaces: Space[] }) {
  const setParts = useCourses((s) => s.setParts);
  const seen = spaces.filter((s) => row.reach.all.includes(s.id) || row.reach.some.includes(s.id));
  const shown = seen.slice(0, seen.length > CHIPS ? CHIPS - 1 : CHIPS);
  const more = seen.slice(shown.length);
  const items: PickerItem[] = spaces.map((s) => ({ id: s.id, label: s.name, hue: s.hue }));
  return (
    <AccessPicker
      items={items}
      all={row.reach.all}
      some={row.reach.some}
      search="Search spaces"
      empty="No space matches."
      onToggle={(id, on) => void setParts(id, row.course.key, on ? ALL_PARTS : [])}
      trigger={
        <Button
          variant="ghost"
          size="xs"
          shape="rect"
          aria-label={`Spaces that see ${row.label}`}
          className="h-8 min-w-0 max-w-full shrink justify-end gap-1 px-1.5 sm:h-7"
        >
          {seen.length === 0 ? (
            <span className="flex items-center gap-1 font-normal text-muted-foreground">
              <Icon icon={icons.add} />
              Add to a space
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1">
              {shown.map((s) => (
                <SpaceChip key={s.id} space={s} some={row.reach.some.includes(s.id)} />
              ))}
              {more.length ? (
                <Tooltip>
                  <TooltipTrigger render={<Badge variant="secondary" className="font-normal tabular-nums" />}>+{more.length}</TooltipTrigger>
                  <TooltipPopup className="max-w-60">{more.map((s) => s.name).join(", ")}</TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          )}
          <Icon icon={icons.chevronsUpDown} className="text-muted-foreground" />
        </Button>
      }
    />
  );
}

function Row({ row, spaces }: { row: CourseRow; spaces: Space[] }) {
  return (
    <div className="flex min-h-11 items-center gap-3 py-1.5 ps-4 pe-2">
      <Truncate className="min-w-0 flex-1 text-sm" tooltip={row.label === row.course.name ? undefined : row.course.name}>
        {row.label}
      </Truncate>
      <SpacesCell row={row} spaces={spaces} />
    </div>
  );
}

/**
 * Settings › Courses › which space sees which course: one row per course, the
 * spaces that see it as chips, and a searchable picker of every space. Scales
 * to many spaces (chips and a picker, not a column each) and many courses
 * (search, the ones no space sees folded away, "Show more").
 */
export function SpaceAccess() {
  const access = useCourses((s) => s.access);
  const known = useCourses((s) => s.spaces);
  const connections = useCourses((s) => s.connections.data);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const showSkeleton = useDelayed(access.loading && !access.data);

  const view = access.data;
  const spaces = useMemo(() => spaceList(view?.spaces ?? [], known), [view?.spaces, known]);
  const { groups, hidden, total } = useMemo(() => {
    if (!view) return { groups: [], hidden: [], total: 0 };
    const site = (id: string) => connections?.find((c) => c.id === id);
    return courseGroups(view, {
      partCount: ALL_PARTS.length,
      query,
      schoolOf: (c) => {
        const s = site(c.connection);
        return s ? connectionName(s) : undefined;
      },
    });
  }, [view, connections, query]);

  if (access.error && !view) return <SurfaceError title="Couldn’t load course access" message={access.error} onRetry={() => void useCourses.getState().loadAccess()} />;
  if (!view) return showSkeleton ? <SkeletonCard rows={3} /> : <div className="h-36" />;
  if (view.courses.length === 0) return <div className="flex min-h-11 items-center rounded-card border bg-card px-4 py-3 text-muted-foreground text-sm">Imported courses show here.</div>;

  const searching = !!query.trim();
  let left = searching ? Number.POSITIVE_INFINITY : limit;
  const paged = groups
    .map((g) => {
      const rows = g.rows.slice(0, Math.max(0, left));
      left -= rows.length;
      return { ...g, rows };
    })
    .filter((g) => g.rows.length);
  const seenCount = groups.reduce((n, g) => n + g.rows.length, 0);
  const cut = seenCount - paged.reduce((n, g) => n + g.rows.length, 0);
  const grouped = groups.some((g) => g.label);

  return (
    <div className="space-y-2">
      {view.courses.length > SEARCH_FROM ? (
        <div className="relative">
          <Icon icon={icons.search} className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 text-muted-foreground" />
          <Input
            size="sm"
            value={query}
            placeholder="Search courses"
            aria-label="Search courses"
            className="*:data-[slot=input]:ps-8"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}
      <div className="divide-y rounded-card border bg-card" data-testid="space-access">
        {paged.map((g) => (
          <div key={g.id} className="divide-y">
            {grouped ? <div className="flex h-8 items-end px-4 pb-1.5 text-subtle-foreground text-xs">{g.label}</div> : null}
            {g.rows.map((r) => (
              <Row key={r.course.key} row={r} spaces={spaces} />
            ))}
          </div>
        ))}
        {cut > 0 ? (
          <div className="flex h-10 items-center px-2">
            <Button variant="ghost-muted" size="xs" shape="rect" onClick={() => setLimit((n) => n + PAGE * 2)}>
              Show {cut} more
            </Button>
          </div>
        ) : null}
        {hidden.length ? (
          <Collapsible open={hiddenOpen || searching} onOpenChange={setHiddenOpen}>
            <CollapsibleTrigger
              render={<button type="button" />}
              className="group flex h-10 w-full cursor-pointer items-center gap-2 px-4 text-left text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <Icon icon={icons.chevronDown} className="-rotate-90 size-3.5 transition-transform group-data-panel-open:rotate-0" />
              <span className="tabular-nums">
                {hidden.length} not in any space
              </span>
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="divide-y border-t">
                {hidden.map((r) => (
                  <Row key={r.course.key} row={r} spaces={spaces} />
                ))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        ) : null}
        {searching && total === 0 ? <div className="flex h-11 items-center px-4 text-muted-foreground text-sm">No course matches “{query.trim()}”.</div> : null}
      </div>
    </div>
  );
}
