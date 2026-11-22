import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { useViewActive } from "@/app/Header";
import { type SettingsSection, type SettingsTarget, useNav } from "@/app/store";
import { RowError } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { ProviderIcon } from "@/components/provider-icon";
import { SkeletonRows } from "@/components/skeletons";
import { Truncate, TruncateTips } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ModelPick } from "../api";
import { EFFORT_LABEL, findModel, groupIdOf, pickName, targetForGroup, useCatalog, type CatalogGroup, type CatalogModel } from "../catalog";
import { EffortGlyph } from "./EffortGlyph";

/** A quiet hint badge for model rows, only when the model's family name makes it genuinely useful. */
function modelBadge(m: CatalogModel): string | null {
  if (m.model === null) return "Default";
  const n = m.name.toLowerCase();
  if (/\b(haiku|nano|mini|lite|flash|small|tiny)\b|flash-lite/.test(n)) return "Fast";
  if (/\b(opus|ultra|max)\b|\bpro\b/.test(n)) return "Pro";
  return null;
}

/**
 * The composer's model picker: only connected, ready providers and signed-in
 * coding agents appear in the switcher. A provider rail appears when 2+
 * providers are ready; unconfigured providers tuck into a quiet footer section.
 */

const sameModel = (a: ModelPick, b: Pick<CatalogModel, "backend" | "model">) => a.backend === b.backend && a.model === b.model;

/** Dispatched on window (the composer's `/model`) to open the picker. */
export const OPEN_MODEL_PICKER = "phaethon:open-model-picker";

type FlatItem =
  | { kind: "header"; key: string; group: CatalogGroup }
  | { kind: "loading"; key: string; group: CatalogGroup }
  | { kind: "error"; key: string; group: CatalogGroup }
  | { kind: "empty"; key: string; group: CatalogGroup }
  | { kind: "model"; key: string; group: CatalogGroup; m: CatalogModel; rowIndex: number };

const ITEM_HEIGHT: Record<FlatItem["kind"], number> = {
  header: 28,
  loading: 108,
  error: 36,
  empty: 28,
  model: 36,
};

export function ModelPicker({ pick, onPick, disabled }: { pick: ModelPick; onPick: (p: ModelPick) => void; disabled?: boolean }) {
  const groups = useCatalog((s) => s.groups);
  const status = useCatalog((s) => s.status);
  const error = useCatalog((s) => s.error);
  const autoFallback = useCatalog((s) => s.autoFallback);
  const load = useCatalog((s) => s.load);
  const loadModels = useCatalog((s) => s.loadModels);
  const openSettings = useNav((s) => s.openSettings);
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => void load(), [load]);
  const visible = useViewActive();
  useEffect(() => {
    if (disabled || !visible) return;
    const show = () => setOpen(true);
    window.addEventListener(OPEN_MODEL_PICKER, show);
    return () => window.removeEventListener(OPEN_MODEL_PICKER, show);
  }, [disabled, visible]);

  const readyGroups = useMemo(() => groups.filter((g) => g.ready), [groups]);
  const unreadyGroups = useMemo(() => groups.filter((g) => !g.ready), [groups]);
  const showRail = readyGroups.length >= 2;

  const goSettings = (section: SettingsSection = "models", target?: SettingsTarget) => {
    setOpen(false);
    openSettings(section, target);
  };

  const choose = (m: CatalogModel) => {
    const keep = sameModel(pick, m) ? pick.effort : null;
    const effort = keep && m.efforts.includes(keep) ? keep : null;
    onPick({ backend: m.backend, model: m.model, effort });
    setOpen(false);
  };

  const current = groups.find((g) => g.id === groupIdOf(pick));
  const currentUnready = !!current && !current.ready;
  const name = pickName(groups, pick);
  const empty = status === "ready" && readyGroups.length === 0;

  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger
        disabled={disabled}
        data-testid="model-picker"
        className="inline-flex h-7 min-w-0 max-w-56 items-center gap-1.5 rounded-md px-2 text-foreground text-sm transition-colors hover:bg-accent disabled:opacity-60 data-popup-open:bg-accent"
      >
        <ProviderIcon id={groupIdOf(pick)} className="size-3.5" />
        <span className="min-w-0 truncate">{name}</span>
        {currentUnready ? <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-label={current.need ?? "Not ready"} /> : null}
        <Icon icon={icons.chevronDown} className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="end"
        padding="none"
        className={cn("max-w-(--viewport-max-width) overflow-hidden rounded-xl", showRail ? "w-116" : "w-88")}
        initialFocus={() => searchRef.current ?? undefined}
      >
        {empty ? (
          <div className="flex flex-col items-center gap-3 px-6 py-7 text-center">
            <span className="flex size-10 items-center justify-center rounded-xl border bg-well text-muted-foreground">
              <Icon icon={icons.model} className="size-5" />
            </span>
            <div className="flex flex-col gap-1">
              <p className="font-medium text-foreground text-sm">No AI model is connected yet</p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Connect a subscription you already pay for, paste an API key, or use a local model.
              </p>
            </div>
            <div className="mt-1 flex w-full flex-col gap-2">
              <Button size="sm" className="w-full" onClick={() => goSettings("models")}>
                Set up AI models
              </Button>
            </div>
          </div>
        ) : (
          <ModelPickerPanel
            pick={pick}
            status={status}
            error={error}
            autoFallback={autoFallback}
            readyGroups={readyGroups}
            unreadyGroups={unreadyGroups}
            current={current}
            currentUnready={currentUnready}
            showRail={showRail}
            searchRef={searchRef}
            load={load}
            loadModels={loadModels}
            onChoose={choose}
            onGoSettings={goSettings}
          />
        )}
      </PopoverPopup>
    </Popover>
  );
}

function ModelPickerPanel({
  pick,
  status,
  error,
  autoFallback,
  readyGroups,
  unreadyGroups,
  current,
  currentUnready,
  showRail,
  searchRef,
  load,
  loadModels,
  onChoose,
  onGoSettings,
}: {
  pick: ModelPick;
  status: "idle" | "loading" | "ready" | "error";
  error: string | undefined;
  autoFallback: boolean;
  readyGroups: CatalogGroup[];
  unreadyGroups: CatalogGroup[];
  current: CatalogGroup | undefined;
  currentUnready: boolean;
  showRail: boolean;
  searchRef: React.RefObject<HTMLInputElement | null>;
  load: (force?: boolean) => Promise<void>;
  loadModels: (id: string) => Promise<void>;
  onChoose: (m: CatalogModel) => void;
  onGoSettings: (section?: SettingsSection, target?: SettingsTarget) => void;
}) {
  const [rail, setRail] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const [showUnready, setShowUnready] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const hideTip = useRef<(() => void) | null>(null);

  useEffect(() => {
    for (const g of useCatalog.getState().groups) if (g.ready) void loadModels(g.id);
  }, [loadModels]);

  const activeRail = rail === "all" || readyGroups.some((g) => g.id === rail) ? rail : "all";
  const shownGroups = useMemo(
    () => (activeRail === "all" ? readyGroups : readyGroups.filter((g) => g.id === activeRail)),
    [activeRail, readyGroups],
  );
  const q = query.trim().toLowerCase();
  const { rows, flat, rowToFlat } = useMemo(() => {
    const rowList: { g: CatalogGroup; m: CatalogModel }[] = [];
    const flatList: FlatItem[] = [];
    const indexMap: number[] = [];
    const showHeader = activeRail === "all";
    for (const g of shownGroups) {
      const matched = g.models.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.model ?? "").toLowerCase().includes(q) || g.name.toLowerCase().includes(q));
      if (q && matched.length === 0) continue;
      if (showHeader) flatList.push({ kind: "header", key: `h:${g.id}`, group: g });
      if (g.status === "loading" && matched.length === 0) flatList.push({ kind: "loading", key: `l:${g.id}`, group: g });
      else if (g.status === "error" && matched.length === 0) flatList.push({ kind: "error", key: `e:${g.id}`, group: g });
      else if (g.status === "ready" && g.models.length === 0) flatList.push({ kind: "empty", key: `n:${g.id}`, group: g });
      for (const m of matched) {
        const rowIndex = rowList.length;
        rowList.push({ g, m });
        indexMap.push(flatList.length);
        flatList.push({ kind: "model", key: `${g.id}:${m.backend}:${m.model}`, group: g, m, rowIndex });
      }
    }
    return { rows: rowList, flat: flatList, rowToFlat: indexMap };
  }, [shownGroups, q, activeRail]);

  useEffect(() => setHi(0), [q, activeRail]);

  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => listRef.current,
    estimateSize: (i) => ITEM_HEIGHT[flat[i]!.kind],
    getItemKey: (i) => flat[i]!.key,
    initialRect: { width: 352, height: 320 },
    overscan: 8,
  });

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!rows.length) return;
      e.preventDefault();
      const next = Math.max(0, Math.min(rows.length - 1, hi + (e.key === "ArrowDown" ? 1 : -1)));
      setHi(next);
      const flatIdx = rowToFlat[next];
      if (flatIdx !== undefined) virtualizer.scrollToIndex(flatIdx, { align: "auto" });
    } else if (e.key === "Enter" && rows[hi]) {
      // Let rail buttons and footer buttons handle their own Enter presses.
      if (e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      onChoose(rows[hi].m);
    }
  };

  return (
    <div className="flex h-96 max-h-(--available-height) min-h-0" onKeyDown={onKey}>
      {showRail ? (
        <div className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r bg-well py-2" role="tablist" aria-label="Providers">
          <RailButton active={activeRail === "all"} label="All connected models" onClick={() => setRail("all")}>
            <Icon icon={icons.apps} className="size-4 text-muted-foreground" />
          </RailButton>
          <div className="my-1 h-px w-6 bg-border" />
          {readyGroups.map((g) => (
            <RailButton
              key={g.id}
              active={activeRail === g.id}
              label={g.name}
              onClick={() => {
                setRail(g.id);
                void loadModels(g.id);
              }}
            >
              <ProviderIcon id={g.id} />
            </RailButton>
          ))}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3.5">
          <Icon icon={icons.search} className="size-3.5 shrink-0 text-subtle-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models…"
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-placeholder"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {currentUnready && current ? (
          <div className="flex items-start gap-2 border-b bg-warning/8 px-3.5 py-2 text-warning-foreground text-xs">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" />
            <p className="min-w-0 flex-1 leading-relaxed">
              Current model isn’t ready — choose a connected model below or{" "}
              <button
                type="button"
                onClick={() => onGoSettings("models", targetForGroup(current.id))}
                className="font-medium underline underline-offset-2 hover:opacity-80"
              >
                finish setup
              </button>
              .
            </p>
          </div>
        ) : null}
        <TruncateTips hideRef={hideTip}>
          <div
            ref={listRef}
            onScroll={() => hideTip.current?.()}
            className="min-h-0 flex-1 overflow-y-auto p-1.5"
            role="listbox"
            aria-label="Models"
          >
            {status === "loading" && readyGroups.length === 0 ? <SkeletonRows count={5} withIcon /> : null}
            {status === "error" ? <RowError className="h-8 px-2" message={error ?? "Couldn’t load models"} onRetry={() => void load(true)} /> : null}
            {flat.length > 0 ? (
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((v) => {
                  const item = flat[v.index]!;
                  return (
                    <div
                      key={item.key}
                      className="absolute inset-x-0 top-0"
                      style={{ transform: `translateY(${v.start}px)` }}
                    >
                      {item.kind === "header" ? (
                        <div className="flex h-7 items-center px-2.5">
                          <span className="type-label">{item.group.name}</span>
                        </div>
                      ) : item.kind === "loading" ? (
                        <SkeletonRows count={3} withIcon />
                      ) : item.kind === "error" ? (
                        <RowError className="h-8 px-2" message={item.group.error ?? "Couldn’t load models"} onRetry={() => void loadModels(item.group.id)} />
                      ) : item.kind === "empty" ? (
                        <p className="px-2.5 py-1.5 text-muted-foreground text-xs">{item.group.note ?? "No models listed."}</p>
                      ) : (
                        (() => {
                          const selected = sameModel(pick, item.m);
                          const badge = modelBadge(item.m);
                          return (
                            <div
                              role="option"
                              aria-selected={selected}
                              data-row={item.rowIndex}
                              data-highlighted={item.rowIndex === hi || undefined}
                              onMouseMove={() => hi !== item.rowIndex && setHi(item.rowIndex)}
                              onClick={() => onChoose(item.m)}
                              className="flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors data-highlighted:bg-accent"
                            >
                              <ProviderIcon id={item.group.id} />
                              <Truncate lazy className={cn("flex-1", selected && "font-medium")}>
                                {item.m.name}
                              </Truncate>
                              {badge ? (
                                <span aria-hidden className="shrink-0 rounded-md bg-muted/80 px-1.5 py-0.5 font-medium text-2xs text-muted-foreground">
                                  {badge}
                                </span>
                              ) : null}
                              <Icon icon={icons.check} className={cn("size-4 shrink-0 text-primary", selected ? "opacity-100" : "opacity-0")} />
                            </div>
                          );
                        })()
                      )}
                    </div>
                  );
                })}
              </div>
            ) : null}
            {status === "ready" && rows.length === 0 && q ? (
              <p className="px-3 py-6 text-center text-muted-foreground text-xs">No model matches “{query.trim()}”.</p>
            ) : null}
          </div>
        </TruncateTips>
        {unreadyGroups.length > 0 ? (
          <div className="shrink-0 border-t">
            <button
              type="button"
              aria-expanded={showUnready}
              onClick={() => setShowUnready((v) => !v)}
              className="flex h-8 w-full items-center justify-between gap-2 px-3.5 text-muted-foreground text-xs transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <span>Set up another ({unreadyGroups.length})</span>
              <Icon icon={icons.chevronDown} className={cn("size-3.5 transition-transform duration-150", !showUnready && "-rotate-90")} />
            </button>
            {showUnready ? (
              <div className="max-h-32 overflow-y-auto border-t bg-well/40 p-1">
                {unreadyGroups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => onGoSettings("models", targetForGroup(g.id))}
                    className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    <ProviderIcon id={g.id} className="size-3.5 opacity-60" />
                    <span className="min-w-0 flex-1 truncate text-foreground/85">{g.name}</span>
                    <span className="shrink-0 text-subtle-foreground">{g.need}</span>
                    <Icon icon={icons.chevronRight} className="size-3 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-t bg-well/30 px-3 text-muted-foreground text-xs">
          <button
            type="button"
            onClick={() => onGoSettings("models")}
            className="inline-flex items-center gap-1.5 rounded-full bg-muted/70 px-2 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <span className={cn("size-1.5 rounded-full", autoFallback ? "bg-success" : "bg-subtle-foreground/50")} />
            {autoFallback ? "Auto-fallback on" : "Auto-fallback off"}
          </button>
          <button type="button" className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground" onClick={() => onGoSettings("models")}>
            <Icon icon={icons.settings} className="size-3.5" />
            Manage models
          </button>
        </div>
      </div>
    </div>
  );
}

function RailButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
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
            className={cn(
              "relative inline-flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-accent",
              active && "bg-background shadow-2xs ring-1 ring-border/70 dark:bg-accent",
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="left">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** The effort control beside the picker, only for models that take one: a segmented choice in a small popover. */
export function EffortPicker({ pick, onPick, disabled }: { pick: ModelPick; onPick: (p: ModelPick) => void; disabled?: boolean }) {
  const groups = useCatalog((s) => s.groups);
  const model = findModel(groups, pick);
  const [open, setOpen] = useState(false);
  if (!model || model.efforts.length === 0) return null;
  const level = pick.effort ?? model.defaultEffort ?? model.efforts[Math.floor(model.efforts.length / 2)]!;
  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              disabled={disabled}
              aria-label={`Reasoning: ${EFFORT_LABEL[level] ?? level}`}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60 data-popup-open:bg-accent"
            />
          }
        >
          <EffortGlyph level={level} levels={model.efforts} className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>Reasoning · {EFFORT_LABEL[level] ?? level}</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="top" align="end" padding="none" className="rounded-xl">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-6 px-0.5 text-xs">
            <span className="text-subtle-foreground">Reasoning</span>
            {model.defaultEffort ? <span className="text-subtle-foreground">Default: {EFFORT_LABEL[model.defaultEffort] ?? model.defaultEffort}</span> : null}
          </div>
          <Tabs
            value={level}
            onValueChange={(e) => {
              onPick({ ...pick, effort: e === model.defaultEffort ? null : e });
              setOpen(false);
            }}
          >
            <TabsList aria-label="Reasoning">
              {model.efforts.map((e) => (
                <TabsTab key={e} value={e}>
                  {EFFORT_LABEL[e] ?? e}
                </TabsTab>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
