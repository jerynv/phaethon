import { useMemo, useState, type ReactNode } from "react";
import { useNav } from "@/app/store";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { SpaceAvatar } from "@/components/space-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { AccessPicker, type PickerItem } from "@/features/courses/components/AccessPicker";
import { cn } from "@/lib/utils";

/**
 * Pieces shared by Settings › Memory, People, Mail & connectors and
 * Automations: the spaces list, space chips with a searchable picker (after
 * Settings › Courses), a small select, a chip list editor, and times.
 */

export type SpaceLite = { id: string; name: string; hue: number };

/** Every space, in the sidebar's order. */
export function useSpaceList(): SpaceLite[] {
  const data = useNav((s) => s.spaces.data);
  return useMemo(() => (data ?? []).map((s) => ({ id: s.id, name: s.name, hue: s.hue })), [data]);
}

export const spaceName = (spaces: SpaceLite[], id: string) => spaces.find((s) => s.id === id)?.name ?? id;

/** "Every space" in a people picker. */
export const EVERY = "*";

/** Space chips before "+N". */
const CHIPS = 3;

export function SpaceChip({ space }: { space: SpaceLite }) {
  return (
    <Badge variant="outline" className="max-w-32 gap-1.5 font-normal">
      <SpaceAvatar hue={space.hue} />
      <span className="min-w-0 truncate">{space.name}</span>
    </Badge>
  );
}

/**
 * The spaces something reaches as chips, opening a searchable picker of every
 * space; each pick calls `onChange` at once. With `every`, an "Every space"
 * line comes first and `*` stands for it.
 */
export function SpacesPicker({
  value,
  onChange,
  spaces,
  label,
  every,
  empty = "Add to a space",
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  spaces: SpaceLite[];
  /** The trigger's accessible name: "Spaces that may use Work". */
  label: string;
  every?: boolean;
  empty?: string;
  disabled?: boolean;
}) {
  const all = every && value.includes(EVERY);
  const items: PickerItem[] = [...(every ? [{ id: EVERY, label: "Every space" }] : []), ...spaces.map((s) => ({ id: s.id, label: s.name, hue: s.hue }))];
  const ticked = all ? [EVERY, ...spaces.map((s) => s.id)] : value;
  const seen = spaces.filter((s) => value.includes(s.id));
  const shown = seen.slice(0, seen.length > CHIPS ? CHIPS - 1 : CHIPS);
  const more = seen.slice(shown.length);
  const toggle = (id: string, on: boolean) => {
    if (id === EVERY) return onChange(on ? [EVERY] : []);
    if (all) return onChange(spaces.map((s) => s.id).filter((x) => x !== id));
    onChange(on ? [...value.filter((x) => x !== EVERY), id] : value.filter((x) => x !== id));
  };
  return (
    <AccessPicker
      items={items}
      all={ticked}
      some={[]}
      search="Search spaces"
      empty="No space matches."
      onToggle={toggle}
      trigger={
        <Button variant="ghost" size="xs" shape="rect" aria-label={label} disabled={disabled} className="h-8 min-w-0 max-w-full shrink justify-end gap-1 px-1.5 sm:h-7">
          {all ? (
            <Badge variant="outline" className="gap-1.5 font-normal">
              <Icon icon={icons.deck} className="text-muted-foreground" />
              Every space
            </Badge>
          ) : seen.length === 0 ? (
            <span className="flex min-w-0 items-center gap-1 font-normal text-muted-foreground">
              <Icon icon={icons.add} />
              <span className="truncate">{empty}</span>
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1 overflow-hidden">
              {shown.map((s) => (
                <SpaceChip key={s.id} space={s} />
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

export type Option = { value: string; label: ReactNode };

/** A compact select for a row: a value, its options, an accessible name. */
export function SmallSelect({
  value,
  onChange,
  options,
  label,
  className,
  disabled,
  placeholder = "Choose",
}: {
  value: string | null;
  onChange: (v: string) => void;
  options: Option[];
  label: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => v != null && onChange(String(v))} disabled={disabled}>
      <SelectTrigger size="sm" aria-label={label} className={cn("w-40 min-w-0", className)}>
        <SelectValue>{(v: string | null) => options.find((o) => o.value === v)?.label ?? <span className="text-muted-foreground">{placeholder}</span>}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** A select of spaces, each with its dot. */
export function SpaceSelect({
  value,
  onChange,
  spaces,
  label = "Space",
  className,
  disabled,
}: {
  value: string | null;
  onChange: (id: string) => void;
  spaces: SpaceLite[];
  label?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <SmallSelect
      value={value}
      onChange={onChange}
      label={label}
      className={className}
      disabled={disabled}
      placeholder="Choose a space"
      options={spaces.map((s) => ({
        value: s.id,
        label: (
          <span className="flex min-w-0 items-center gap-2">
            <SpaceAvatar hue={s.hue} />
            <span className="min-w-0 truncate">{s.name}</span>
          </span>
        ),
      }))}
    />
  );
}

/**
 * A short list of words as removable chips with a field to add one (aliases,
 * addresses). Enter or a comma adds; each change calls `onChange` at once.
 */
export function ChipList({
  value,
  onChange,
  label,
  placeholder,
  disabled,
  mono,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  label: string;
  placeholder: string;
  disabled?: boolean;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()));
    setDraft("");
    if (parts.length) onChange([...value, ...parts]);
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {value.map((v) => (
        <Badge key={v} variant="secondary" size="lg" className={cn("max-w-full gap-0.5 pe-0.5 font-normal", mono && "font-mono")}>
          <span className="min-w-0 truncate">{v}</span>
          <Button size="icon-micro" variant="ghost-muted" aria-label={`Remove ${v}`} disabled={disabled} onClick={() => onChange(value.filter((x) => x !== v))}>
            <Icon icon={icons.close} />
          </Button>
        </Badge>
      ))}
      <Input
        size="sm"
        value={draft}
        disabled={disabled}
        aria-label={label}
        placeholder={placeholder}
        className="w-40 min-w-0 flex-1"
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(",")) {
            setDraft(v);
            queueMicrotask(add);
          } else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

// ---- Times --------------------------------------------------------------------

const DAY = 86_400_000;

function clock(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "Today 6:00 AM", "Tomorrow 9:00 AM", "Sat 6:00 AM" within a week, else "Nov 22, 6:00 AM". */
export function dayTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const days = Math.floor((ms - start.getTime()) / DAY);
  if (days === 0) return `Today ${clock(d)}`;
  if (days === 1) return `Tomorrow ${clock(d)}`;
  if (days === -1) return `Yesterday ${clock(d)}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${clock(d)}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "Nov 22", with the year when it isn't this one. */
export function shortDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "in 5 min", "in 3 h", then a day and time: when something next happens. */
export function untilText(ms: number, now = Date.now()): string {
  const diff = ms - now;
  if (diff <= 60_000) return "in a moment";
  const min = Math.round(diff / 60_000);
  if (min < 60) return `in ${min} min`;
  if (min < 6 * 60) return `in ${Math.round(min / 60)} h`;
  return dayTime(ms, now).replace(/^(Today|Tomorrow)/, (m) => m.toLowerCase());
}

/** A time as a `datetime-local` value ("2026-11-22T06:00"), in local time. */
export function toLocalInput(ms: number | undefined): string {
  if (ms === undefined) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A `datetime-local` value as ISO 8601 with the local offset ("2026-11-22T06:00:00-05:00"), or undefined when blank. */
export function fromLocalInput(v: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${toLocalInput(d.getTime())}:00${sign}${p(off / 60)}:${p(off % 60)}`;
}

/** Initials for a person's avatar: "Dana Reyes" → "DR". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = [...words[0]!][0] ?? "";
  const last = words.length > 1 ? ([...words.at(-1)!][0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cn("flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-3xs text-muted-foreground", className)}>
      {initials(name)}
    </span>
  );
}
