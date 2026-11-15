import * as React from "react";
import { cn } from "@/lib/utils";
import { Switch } from "./switch";

/**
 * A setting as a sentence (docs/UI-REBUILD.md › Primitives › Toggle row):
 * title, one line of description, the switch on the right; the whole row is
 * the label. Stack rows in a `divide-y` list or a Card. With `icon` it is the
 * references' Triggers row (brand glyph, name, switch).
 */
function ToggleRow({
  title,
  description,
  icon,
  checked,
  onCheckedChange,
  disabled,
  pending,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Saving: the switch shows the new state but can't be flipped again until it settles. */
  pending?: boolean;
  className?: string;
}) {
  const id = React.useId();
  return (
    <div data-slot="toggle-row" data-disabled={disabled || undefined} className={cn("flex items-center gap-3 py-3 data-disabled:opacity-60", className)}>
      {icon ? <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4.5">{icon}</span> : null}
      <label htmlFor={id} className={cn("flex min-w-0 flex-1 flex-col gap-0.5", !disabled && "cursor-pointer")}>
        <span className="text-foreground text-sm">{title}</span>
        {description ? <span className="text-muted-foreground text-sm">{description}</span> : null}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={(v) => onCheckedChange(v)} disabled={disabled || pending} aria-busy={pending || undefined} />
    </div>
  );
}

export { ToggleRow };
