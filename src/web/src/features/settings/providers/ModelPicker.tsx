/**
 * Choosing a model: a search field over grouped models, with the chosen one
 * marked by a check and "Selected". Two shapes share one list:
 *  - `ModelSelect`: a button showing the current model that opens the list;
 *  - `ModelList`: the list always visible (the Manage dialog).
 * A name typed in the search can be used as is when the provider accepts it
 * (lists don't always show every model).
 */
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { CheckIcon, ChevronsUpDownIcon, SearchIcon } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";

import { Combobox, ComboboxItem, ComboboxList, ComboboxPopup, ComboboxSearchInput, ComboboxTrigger } from "@/components/ui/combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { matchModels } from "./logic";

export type ModelOption = {
  /** Unique across groups: a model reference, or a special value like "" for "use the default". */
  value: string;
  label: string;
  /** Shown quieter after the label (an id that differs from the name, a provider). */
  detail?: string;
  icon?: ReactNode;
};
export type ModelGroup = {
  label: string;
  options: ModelOption[];
  /** Loading, or why the list couldn't be had (the core's sentence). */
  status?: "loading" | "error";
  error?: string;
  /** Turns a typed name into an option of this group, or null when it isn't a name this group takes. */
  typed?: (name: string) => ModelOption | null;
};

type Group = { value: string; items: ModelOption[]; status?: "loading" | "error"; error?: string };

function useGroups(groups: ModelGroup[], query: string) {
  return useMemo(() => {
    const filtered: Group[] = [];
    let count = 0;
    for (const g of groups) {
      const items = matchModels(
        g.options.map((o) => ({ ...o, id: o.value, name: o.label })),
        query,
      ).map(({ id: _id, name: _name, ...o }) => o as ModelOption);
      const typed = query.trim() && g.typed ? g.typed(query.trim()) : null;
      if (typed && !g.options.some((o) => o.value === typed.value)) items.push(typed);
      count += items.length;
      if (items.length || g.status || g.error) filtered.push({ value: g.label, items, status: g.status, error: g.error });
    }
    return { filtered, count };
  }, [groups, query]);
}

function OptionRow({ option, selected }: { option: ModelOption; selected: boolean }) {
  return (
    <ComboboxItem key={option.value} value={option} selectedFill={false} className={cn("min-h-9 gap-2 sm:min-h-8", selected && "bg-primary/10 font-medium dark:bg-primary/15")}>
      {option.icon}
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {option.detail ? <span className="max-w-[45%] shrink truncate text-sm text-muted-foreground max-sm:hidden">{option.detail}</span> : null}
      {selected ? (
        <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-primary">
          <CheckIcon aria-hidden className="size-4 text-primary" />
          <span className="sr-only">Selected</span>
        </span>
      ) : (
        <span aria-hidden className="size-4 shrink-0" />
      )}
    </ComboboxItem>
  );
}

function Groups({ value, showLabels }: { value: string | null; showLabels: boolean }) {
  return (
    <ComboboxList>
      {(group: Group) => (
        <ComboboxPrimitive.Group key={group.value} items={group.items} className="not-first:mt-1.5">
          {showLabels && group.value ? (
            <ComboboxPrimitive.GroupLabel className="px-2 pt-1.5 pb-1 text-sm font-medium text-muted-foreground">{group.value}</ComboboxPrimitive.GroupLabel>
          ) : null}
          {group.status === "loading" && !group.items.length ? (
            <div className="flex flex-col gap-1.5 px-2 py-1.5" aria-hidden>
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-4 w-2/5" />
            </div>
          ) : null}
          {group.error ? <p className="px-2 py-1 text-sm text-muted-foreground">{group.error}</p> : null}
          <ComboboxPrimitive.Collection>{(o: ModelOption) => <OptionRow key={o.value} option={o} selected={o.value === value} />}</ComboboxPrimitive.Collection>
        </ComboboxPrimitive.Group>
      )}
    </ComboboxList>
  );
}

function statusText(groups: ModelGroup[], count: number, query: string): string {
  if (groups.every((g) => g.status === "loading")) return "Loading models…";
  if (!query.trim()) return `${count} model${count === 1 ? "" : "s"}`;
  const q = query.trim();
  if (!count) return `Nothing matches “${q}”`;
  return count === 1 ? `1 model matches “${q}”` : `${count} models match “${q}”`;
}

/** A button showing the current model; opens a searchable list. */
export function ModelSelect({
  groups,
  value,
  onChange,
  triggerLabel,
  ariaLabel,
  ariaDescribedBy,
  disabled,
  invalid,
  id,
  className,
}: {
  groups: ModelGroup[];
  value: string | null;
  onChange: (option: ModelOption) => void;
  /** What the button shows for the current value. */
  triggerLabel: ReactNode;
  ariaLabel: string;
  ariaDescribedBy?: string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const { filtered, count } = useGroups(groups, query);
  const all = useMemo(() => groups.flatMap((g) => g.options), [groups]);
  const selected = all.find((o) => o.value === value) ?? null;
  const statusId = useId();
  return (
    <Combobox<ModelOption>
      items={filtered}
      filteredItems={filtered}
      filter={null}
      autoHighlight
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      value={selected}
      onValueChange={(next) => {
        if (next) onChange(next);
        setOpen(false);
      }}
      isItemEqualToValue={(a, b) => a.value === b.value}
      itemToStringLabel={(o) => o.label}
      disabled={disabled}
    >
      <ComboboxTrigger
        id={id}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid || undefined}
        className={cn(
          "relative inline-flex min-h-9 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 text-left text-[0.9375rem] text-foreground shadow-xs/5 outline-none transition-[box-shadow,background-color] hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 aria-invalid:border-destructive/50 data-disabled:cursor-not-allowed data-disabled:opacity-64 dark:bg-input/32 sm:min-h-8 sm:text-sm",
          className,
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{triggerLabel}</span>
        <ChevronsUpDownIcon aria-hidden className="-me-1 size-4 shrink-0 opacity-70" />
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="flex w-[min(26rem,calc(100vw-2rem))] flex-col">
        <ComboboxSearchInput
          placeholder="Search models"
          aria-label={`Search ${ariaLabel.toLowerCase()}`}
          aria-describedby={statusId}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div id={statusId} role="status" className="px-3 pt-1.5 text-sm text-muted-foreground">
          {statusText(groups, count, query)}
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden pb-1">
          <Groups value={value} showLabels={groups.length > 1} />
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}

/** The list always visible, with its own search field: the selected model is marked. */
export function ModelList({
  groups,
  value,
  onChange,
  label,
  labelId,
  inputId,
  describedBy,
}: {
  groups: ModelGroup[];
  value: string | null;
  onChange: (option: ModelOption) => void;
  label: string;
  labelId?: string;
  inputId?: string;
  describedBy?: string;
}) {
  const [query, setQuery] = useState("");
  const { filtered, count } = useGroups(groups, query);
  const all = useMemo(() => groups.flatMap((g) => g.options), [groups]);
  const selected = all.find((o) => o.value === value) ?? null;
  const statusId = useId();
  return (
    <Combobox<ModelOption>
      inline
      open
      items={filtered}
      filteredItems={filtered}
      filter={null}
      value={selected}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
      isItemEqualToValue={(a, b) => a.value === b.value}
      itemToStringLabel={(o) => o.label}
    >
      <div className="flex flex-col overflow-hidden rounded-lg border bg-background dark:bg-input/16">
        <div className="relative border-b">
          <SearchIcon aria-hidden className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <ComboboxPrimitive.Input
            id={inputId}
            aria-label={label}
            aria-labelledby={labelId}
            aria-describedby={[statusId, describedBy].filter(Boolean).join(" ")}
            placeholder="Search or type a model name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="h-10 w-full bg-transparent ps-9 pe-3 text-[0.9375rem] text-foreground outline-none placeholder:text-muted-foreground focus-visible:bg-accent/40 sm:h-9 sm:text-sm"
          />
        </div>
        <div className="flex max-h-[min(18rem,40vh)] min-h-0 flex-col overflow-hidden">
          <Groups value={value} showLabels={groups.length > 1} />
        </div>
        <div id={statusId} role="status" className="border-t px-3 py-1.5 text-sm text-muted-foreground">
          {statusText(groups, count, query)}
        </div>
      </div>
    </Combobox>
  );
}
