// Adapted from shadcn/ui (MIT, https://github.com/shadcn-ui/ui), restyled onto Phaethon tokens.
import * as React from "react"
import { cn } from "cn"

/** Shared look for single- and multi-line text fields. */
const fieldClasses = [
  "w-full min-w-0 rounded-md border border-line-strong bg-raised text-base text-ink shadow-xs",
  "transition-[border-color,background-color] duration-(--ph-duration-fast) ease-out",
  "placeholder:text-ink-secondary",
  "hover:border-ink-tertiary focus-visible:border-focus",
  "disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-ink-secondary disabled:shadow-none",
  "aria-invalid:border-danger",
  "read-only:bg-surface",
]

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        fieldClasses,
        "h-(--ph-control-height) px-2.5",
        "file:me-2 file:inline-flex file:h-full file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-ink",
        className
      )}
      {...props}
    />
  )
}

export { Input, fieldClasses }
