import { useEffect, useMemo, useRef, useState } from "react";
import { useViewActive } from "@/app/Header";
import { useNav } from "@/app/store";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { ProviderIcon } from "@/components/provider-icon";
import { RowError } from "@/components/errors";
import { SkeletonRows } from "@/components/skeletons";
import { Truncate } from "@/components/truncate";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ModelPick } from "../api";
import { EFFORT_LABEL, findModel, groupIdOf, pickName, useCatalog, type CatalogGroup, type CatalogModel } from "../catalog";
import { EffortGlyph } from "./EffortGlyph";

/**
 * A model's rough tier from its family name ("haiku", "mini" → light; "sonnet", "flash" → middle; "opus",
 * "pro" → top), drawn as the references' ten-bar meter (ref 8386). Only a hint for choosing: providers publish
 * no comparable number, so an unknown family shows no meter rather than a guess.
 */
export function modelTier(name: string): number | null {
  const n = name.toLowerCase();
  if (/\b(haiku|nano|mini|lite|small|tiny|8b|7b|3b)\b|flash-lite|flash lite/.test(n)) return 4;
  if (/\b(opus|ultra|large|max)\b|\bpro\b|gpt-5(?![.\d]*[- ]?(mini|nano))|\bo3\b|grok-4/.test(n)) return 9;
  if (/\b(sonnet|flash|medium|mixtral)\b|gpt-4/.test(n)) return 7;
  return null;
}

/** Each provider's meter takes the chart hue nearest its brand; monochrome brands use ink. */
const TINT: Record<string, string> = {
  anthropic: "bg-chart-2",
  claude: "bg-chart-2",
  "claude-cli": "bg-chart-2",
  gemini: "bg-chart-3",
  "gemini-cli": "bg-chart-3",
  mistral: "bg-chart-1",
  deepseek: "bg-chart-3",
  groq: "bg-chart-2",
  together: "bg-chart-6",
  openrouter: "bg-chart-6",
  lmstudio: "bg-chart-6",
};

function TierMeter({ tier, group }: { tier: number; group: string }) {
  const on = TINT[group] ?? "bg-foreground";
  return (
    <span className="flex shrink-0 items-center gap-0.5" aria-hidden title="Rough tier, from the model’s family">
      {Array.from({ length: 10 }, (_, i) => (
        <span key={i} className={cn("h-3.5 w-0.75 rounded-full", i < tier ? on : "bg-foreground/8")} />
      ))}
    </span>
  );
}

/**
 * The composer's model picker, after T3 Code's: a provider rail on the left,
 * search on top, model rows (logo · name · check). Coding agents sit in the
 * same rail. The choice belongs to this conversation.
 */

const sameModel = (a: ModelPick, b: Pick<CatalogModel, "backend" | "model">) => a.backend === b.backend && a.model === b.model;

/** Dispatched on window (the composer's `/model`) to open the picker. */
export const OPEN_MODEL_PICKER = "phaethon:open-model-picker";

export function ModelPicker({ pick, onPick, disabled }: { pick: ModelPick; onPick: (p: ModelPick) => void; disabled?: boolean }) {
  const { groups, status, error, load, loadModels } = useCatalog();
  const openSettings = useNav((s) => s.openSettings);
  const [open, setOpen] = useState(false);
  const [rail, setRail] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => void load(), [load]);
  const visible = useViewActive();
  useEffect(() => {
    if (disabled || !visible) return;
    const show = () => setOpen(true);
    window.addEventListener(OPEN_MODEL_PICKER, show);
    return () => window.removeEventListener(OPEN_MODEL_PICKER, show);
  }, [disabled, visible]);
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
        className="inline-flex h-8 min-w-0 max-w-56 items-center gap-1.5 rounded-lg px-2.5 text-foreground text-sm transition-colors hover:bg-accent disabled:opacity-60 data-popup-open:bg-accent"
      >
        <ProviderIcon id={groupIdOf(pick)} className="size-3.5" />
        <span className="min-w-0 truncate">{name}</span>
        {current?.need ? <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-label={current.need} /> : null}
        <Icon icon={icons.chevronDown} className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" padding="none" className="w-120 max-w-(--viewport-max-width) rounded-xl" initialFocus={() => document.getElementById("model-search") as HTMLElement}>
        <div className="flex h-96 max-h-(--available-height) min-h-0">
          <div className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r bg-well py-2" role="tablist" aria-label="Providers">
            <RailButton active={rail === "all"} label="All models" onClick={() => setRail("all")}>
              <Icon icon={icons.apps} className="size-4 text-muted-foreground" />
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
            <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
              <Icon icon={icons.search} className="size-4 shrink-0 text-subtle-foreground" />
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
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox" aria-label="Models">
              {status === "loading" && groups.length === 0 ? <SkeletonRows count={6} withIcon /> : null}
              {status === "error" ? <RowError className="h-8 px-2" message={error ?? "Couldn’t load models"} onRetry={() => void load(true)} /> : null}
              {shownGroups.map((g) => (
                <GroupRows key={g.id} group={g} pick={pick} rows={rows} hi={hi} setHi={setHi} choose={choose} showHeader={rail === "all"} query={q} onSetup={() => openSettings(g.needAction ?? "providers")} onRetry={() => void loadModels(g.id)} />
              ))}
              {status === "ready" && rows.length === 0 && q ? <p className="px-2 py-6 text-center text-muted-foreground text-xs">No model matches “{query.trim()}”.</p> : null}
            </div>
            <div className="flex h-10 shrink-0 items-center justify-between border-t px-4 text-muted-foreground text-xs">
              <span>For this conversation</span>
              <button type="button" className="inline-flex items-center gap-1.5 hover:text-foreground" onClick={() => openSettings("providers")}>
                <Icon icon={icons.settings} className="size-3.5" />
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
            className={cn("relative inline-flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-accent", active && "bg-background shadow-raised dark:bg-accent", dim && "opacity-55")}
          />
        }
      >
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
        <div className="flex h-8 items-center gap-2 px-2.5">
          {showHeader ? <span className="text-subtle-foreground text-xs">{group.name}</span> : null}
          {group.need ? (
            <button type="button" onClick={onSetup} className="ml-auto inline-flex items-center gap-1 rounded-sm px-1 text-warning-foreground text-xs hover:underline">
              {group.need} · Set up
            </button>
          ) : null}
        </div>
      ) : null}
      {group.status === "loading" && mine.length === 0 ? <SkeletonRows count={3} withIcon /> : null}
      {group.status === "error" && mine.length === 0 ? <RowError className="h-8 px-2" message={group.error ?? "Couldn’t load models"} onRetry={onRetry} /> : null}
      {group.status === "ready" && group.models.length === 0 ? <p className="px-2.5 py-1.5 text-muted-foreground text-xs">{group.note ?? "No models listed."}</p> : null}
      {mine.map(({ m, i }) => {
        const selected = sameModel(pick, m);
        const tier = m.model ? modelTier(m.name) : null;
        return (
          <div
            key={`${m.backend}:${m.model}`}
            role="option"
            aria-selected={selected}
            data-row={i}
            data-highlighted={i === hi || undefined}
            onMouseMove={() => setHi(i)}
            onClick={() => choose(m)}
            className="flex h-9 cursor-pointer items-center gap-3 rounded-lg px-2.5 text-base data-highlighted:bg-accent"
          >
            <ProviderIcon id={group.id} />
            <Truncate className="flex-1">{m.name}</Truncate>
            {m.efforts.length ? (
              <span className="shrink-0 text-subtle-foreground" title="Has reasoning levels">
                <EffortGlyph level={m.defaultEffort ?? "medium"} levels={m.efforts} className="size-3" />
              </span>
            ) : null}
            {tier ? <TierMeter tier={tier} group={group.id} /> : null}
            <Icon icon={icons.check} className={cn("size-4 shrink-0 text-primary", selected ? "opacity-100" : "opacity-0")} />
          </div>
        );
      })}
    </div>
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
      <PopoverTrigger
        disabled={disabled}
        aria-label={`Reasoning: ${EFFORT_LABEL[level] ?? level}`}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60 data-popup-open:bg-accent"
      >
        <EffortGlyph level={level} levels={model.efforts} className="size-3.5" />
        <span className="@max-md/composer:hidden">{EFFORT_LABEL[level] ?? level}</span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" padding="none" className="rounded-xl">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-6 px-0.5 text-xs">
            <span className="text-subtle-foreground">Reasoning</span>
            {model.defaultEffort ? <span className="text-subtle-foreground">Default: {EFFORT_LABEL[model.defaultEffort] ?? model.defaultEffort}</span> : null}
          </div>
          <SegmentedControl
            value={level}
            onValueChange={(e) => {
              onPick({ ...pick, effort: e === model.defaultEffort ? null : e });
              setOpen(false);
            }}
          >
            {model.efforts.map((e) => (
              <SegmentedControlItem key={e} value={e}>
                {EFFORT_LABEL[e] ?? e}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
