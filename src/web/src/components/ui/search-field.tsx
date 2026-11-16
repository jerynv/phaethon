import type * as React from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * The app's one search field (docs/UI-REBUILD.md › Primitives): a 28 px
 * (`--search-field-height`) `rounded-lg` well with a hairline, the magnifier,
 * the input, and an optional trailing slot for keys, a clear button or a
 * spinner. The sidebar's search and the Courses list's search use it, so
 * they look and line up the same.
 *
 * Every prop but `trailing` and `className` goes to the `<input>` (a
 * `searchbox`; `ref` included). `className` styles the outer box (width,
 * flex). Escape clears a field with text when `onClear` is given.
 */
function SearchField({
  className,
  trailing,
  onClear,
  onKeyDown,
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & {
  /** Keys, a clear button (`SearchFieldAction`) or a spinner at the right end. */
  trailing?: React.ReactNode;
  /** Escape with text in the field calls this (and stops there). */
  onClear?: () => void;
}) {
  return (
    <div
      data-slot="search-field"
      className={cn(
        "relative flex h-(--search-field-height) min-w-0 items-center rounded-lg border bg-well transition-colors hover:border-border-strong has-disabled:opacity-64 has-focus-visible:border-ring/60 has-focus-visible:bg-background",
        className,
      )}
    >
      <Icon icon={icons.search} className="pointer-events-none ml-2 size-4 shrink-0 text-subtle-foreground" />
      <input
        type="text"
        role="searchbox"
        autoComplete="off"
        spellCheck={false}
        {...props}
        onKeyDown={(e) => {
          if (e.key === "Escape" && onClear && e.currentTarget.value) {
            e.preventDefault();
            e.stopPropagation();
            onClear();
            return;
          }
          onKeyDown?.(e);
        }}
        className="h-full w-full min-w-0 rounded-lg bg-transparent pr-2 pl-1.5 text-sm text-foreground outline-none placeholder:text-subtle-foreground"
      />
      {trailing ? <span className="mr-1 flex shrink-0 items-center">{trailing}</span> : null}
    </div>
  );
}

/** A small action in the field's trailing slot: clear, or the keys that open the palette. */
function SearchFieldAction({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-sm px-1 text-subtle-foreground text-xs tabular-nums outline-none transition-colors hover:bg-foreground/6 hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export { SearchField, SearchFieldAction };
