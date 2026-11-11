import { CheckIcon, ChevronDownIcon, LayoutGridIcon, SearchIcon, Settings2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNav } from "@/app/store";
import { ProviderIcon } from "@/components/provider-icon";
import { RowError } from "@/components/errors";
import { SkeletonRows } from "@/components/skeletons";
import { Truncate } from "@/components/truncate";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ModelPick } from "../api";
import { EFFORT_LABEL, findModel, groupIdOf, pickName, useCatalog, type CatalogGroup, type CatalogModel } from "../catalog";
import { EffortGlyph } from "./EffortGlyph";

/**
 * The composer's model picker, after T3 Code's: a provider rail on the left,
 * search on top, model rows (logo · name · check). Coding agents sit in the
 * same rail. The choice belongs to this conversation.
 */

const sameModel = (a: ModelPick, b: Pick<CatalogModel, "backend" | "model">) => a.backend === b.backend && a.model === b.model;

export function ModelPicker({ pick, onPick, disabled }: { pick: ModelPick; onPick: (p: ModelPick) => void; disabled?: boolean }) {
  const { groups, status, error, load, loadModels } = useCatalog();
  const openSettings = useNav((s) => s.openSettings);
  const [open, setOpen] = useState(false);
  const [rail, setRail] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setRail("all");
    for (const g of useCatalog.getState().groups) if (!g.need || g.backend === "phaethon") void loadModels(g.id);
  }, [open, loadModels]);

  const shownGroups = rail === "all" ? groups : groups.filter((g) => g.id === rail);
  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      shownGroups.flatMap((g) =>
        g.models.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.model ?? "").toLowerCase().includes(q) || g.name.toLowerCase().includes(q)).map((m) => ({ g, m })),
      ),
    [shownGroups, q],
  );
  useEffect(() => setHi(0), [q, rail]);

  const choose = (m: CatalogModel) => {
    const keep = sameModel(pick, m) ? pick.effort : null;
    const effort = keep && m.efforts.includes(keep) ? keep : null;
    onPick({ backend: m.backend, model: m.model, effort });
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, Math.min(rows.length - 1, hi + (e.key === "ArrowDown" ? 1 : -1)));
      setHi(next);
      listRef.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && rows[hi]) {
      e.preventDefault();
      choose(rows[hi].m);
    }
  };

  const current = groups.find((g) => g.id === groupIdOf(pick));
  const name = pickName(groups, pick);

  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger
        disabled={disabled}
        data-testid="model-picker"
        className="inline-flex h-7 min-w-0 max-w-56 items-center gap-1.5 rounded-md px-2 text-foreground/80 text-sm transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60 data-popup-open:bg-accent"
      >
        <ProviderIcon id={groupIdOf(pick)} className="size-3.5" />
        <span className="min-w-0 truncate font-medium">{name}</span>
        {current?.need ? <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-label={current.need} /> : null}
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" strokeWidth={2.25} />
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" padding="none" className="w-[30rem] max-w-[calc(100vw-2rem)]" initialFocus={() => document.getElementById("model-search") as HTMLElement}>
        <div className="flex h-[21rem] max-h-(--available-height) min-h-0">
          <div className="flex w-11 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r bg-muted/40 py-1.5" role="tablist" aria-label="Providers">
            <RailButton active={rail === "all"} label="All models" onClick={() => setRail("all")}>
              <LayoutGridIcon className="size-4 text-muted-foreground" strokeWidth={1.75} />
            </RailButton>
            <div className="my-1 h-px w-6 bg-border" />
            {groups.map((g) => (
              <RailButton
                key={g.id}
                active={rail === g.id}
                label={g.need ? `${g.name} · ${g.need}` : g.name}
                dim={!!g.need}
                onClick={() => {
                  setRail(g.id);
                  void loadModels(g.id);
                }}
              >
                <ProviderIcon id={g.id} />
              </RailButton>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
              <SearchIcon className="size-3.5 shrink-0 text-subtle-foreground" strokeWidth={2} />
              <input
                id="model-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKey}
                placeholder="Search models"
                className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-placeholder"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1" role="listbox" aria-label="Models">
              {status === "loading" && groups.length === 0 ? <SkeletonRows count={6} withIcon /> : null}
              {status === "error" ? <RowError className="h-8 px-2" message={error ?? "Couldn’t load models"} onRetry={() => void load(true)} /> : null}
              {shownGroups.map((g) => (
                <GroupRows key={g.id} group={g} pick={pick} rows={rows} hi={hi} setHi={setHi} choose={choose} showHeader={rail === "all"} query={q} onSetup={() => openSettings(g.needAction ?? "providers")} onRetry={() => void loadModels(g.id)} />
              ))}
              {status === "ready" && rows.length === 0 && q ? <p className="px-2 py-6 text-center text-muted-foreground text-xs">No model matches “{query.trim()}”.</p> : null}
            </div>
            <div className="flex h-8 shrink-0 items-center justify-between border-t px-3 text-muted-foreground text-xs">
              <span>For this conversation</span>
              <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => openSettings("providers")}>
                <Settings2Icon className="size-3" />
                Providers
              </button>
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function RailButton({ active, label, onClick, children, dim }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode; dim?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={label}
            onClick={onClick}
            className={cn("relative inline-flex size-8 items-center justify-center rounded-md transition-colors hover:bg-accent", active && "bg-background shadow-xs/5 dark:bg-white/8", dim && "opacity-55")}
          />
        }
      >
        {active ? <span className="absolute top-1.5 bottom-1.5 -left-1.5 w-0.75 rounded-full bg-primary" /> : null}
        {children}
      </TooltipTrigger>
      <TooltipPopup side="left">{label}</TooltipPopup>
    </Tooltip>
  );
}

function GroupRows({
  group,
  pick,
  rows,
  hi,
  setHi,
  choose,
  showHeader,
  query,
  onSetup,
  onRetry,
}: {
  group: CatalogGroup;
  pick: ModelPick;
  rows: { g: CatalogGroup; m: CatalogModel }[];
  hi: number;
  setHi: (n: number) => void;
  choose: (m: CatalogModel) => void;
  showHeader: boolean;
  query: string;
  onSetup: () => void;
  onRetry: () => void;
}) {
  const mine = rows.map((r, i) => ({ ...r, i })).filter((r) => r.g.id === group.id);
  if (query && mine.length === 0) return null;
  return (
    <div className="pb-1">
      {showHeader || group.need ? (
        <div className="flex h-7 items-center gap-2 px-2">
          {showHeader ? <span className="font-medium text-2xs text-muted-foreground">{group.name}</span> : null}
          {group.need ? (
            <button type="button" onClick={onSetup} className="ml-auto inline-flex items-center gap-1 rounded-sm px-1 text-2xs text-warning-foreground hover:underline">
              {group.need} · Set up
            </button>
          ) : null}
        </div>
      ) : null}
      {group.status === "loading" && mine.length === 0 ? <SkeletonRows count={3} withIcon /> : null}
      {group.status === "error" && mine.length === 0 ? <RowError className="h-8 px-2" message={group.error ?? "Couldn’t load models"} onRetry={onRetry} /> : null}
      {group.status === "ready" && group.models.length === 0 ? <p className="px-2 py-1.5 text-muted-foreground text-xs">{group.note ?? "No models listed."}</p> : null}
      {mine.map(({ m, i }) => {
        const selected = sameModel(pick, m);
        return (
          <div
            key={`${m.backend}:${m.model}`}
            role="option"
            aria-selected={selected}
            data-row={i}
            data-highlighted={i === hi || undefined}
            onMouseMove={() => setHi(i)}
            onClick={() => choose(m)}
            className="flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm data-highlighted:bg-accent"
          >
            <ProviderIcon id={group.id} />
            <Truncate className="flex-1">{m.name}</Truncate>
            {m.efforts.length ? (
              <span className="shrink-0 text-subtle-foreground" title="Has reasoning levels">
                <EffortGlyph level={m.defaultEffort ?? "medium"} levels={m.efforts} className="size-3" />
              </span>
            ) : null}
            <CheckIcon className={cn("size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} strokeWidth={2.25} />
          </div>
        );
      })}
    </div>
  );
}

/** The effort control beside the picker, only for models that take one. */
export function EffortPicker({ pick, onPick, disabled }: { pick: ModelPick; onPick: (p: ModelPick) => void; disabled?: boolean }) {
  const groups = useCatalog((s) => s.groups);
  const model = findModel(groups, pick);
  const [open, setOpen] = useState(false);
  if (!model || model.efforts.length === 0) return null;
  const level = pick.effort ?? model.defaultEffort ?? model.efforts[Math.floor(model.efforts.length / 2)]!;
  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={`Reasoning: ${EFFORT_LABEL[level] ?? level}`}
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-foreground/70 text-xs transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60 data-popup-open:bg-accent"
      >
        <EffortGlyph level={level} levels={model.efforts} className="size-3.5" />
        <span className="max-[620px]:hidden">{EFFORT_LABEL[level] ?? level}</span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" padding="none" className="w-44">
        <div className="p-1">
          <div className="px-2 pt-1 pb-1.5 font-medium text-2xs text-muted-foreground">Reasoning</div>
          {model.efforts.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                onPick({ ...pick, effort: e === model.defaultEffort ? null : e });
                setOpen(false);
              }}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-sm hover:bg-accent"
            >
              <EffortGlyph level={e} levels={model.efforts} className="size-3.5 text-muted-foreground" />
              <span className="flex-1 text-left">{EFFORT_LABEL[e] ?? e}</span>
              {e === model.defaultEffort ? <span className="text-2xs text-subtle-foreground">default</span> : null}
              <CheckIcon className={cn("size-3.5", e === level ? "opacity-100" : "opacity-0")} strokeWidth={2.25} />
            </button>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
