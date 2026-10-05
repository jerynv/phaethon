// Adapted from shadcn/ui (MIT, https://github.com/shadcn-ui/ui), restyled onto steward tokens.
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

/*
 * Desktop density: 28 px by default, 24 px small, 32 px large (control-height
 * tokens). Native-feeling cursor (default, not a hand). Focus is the global
 * ring from index.css; every variant designs hover, pressed, open and disabled.
 */
const buttonVariants = cva(
  [
    "inline-flex shrink-0 cursor-default items-center justify-center gap-1.5 rounded-md border border-transparent",
    "text-base leading-none font-medium whitespace-nowrap select-none",
    "transition-[color,background-color,border-color,box-shadow] duration-(--st-duration-fast) ease-out",
    "disabled:pointer-events-none disabled:opacity-45",
    "aria-invalid:border-danger",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: [
          "bg-accent-fill text-ink-inverse shadow-sm",
          "hover:bg-accent-fill-hover active:bg-accent-fill-hover active:shadow-none",
          "data-[state=open]:bg-accent-fill-hover",
        ],
        destructive: [
          "bg-danger text-ink-inverse shadow-sm",
          "hover:bg-danger/90 active:bg-danger/80 active:shadow-none",
        ],
        outline: [
          "border-line-strong bg-raised text-ink shadow-sm",
          "hover:bg-hover active:bg-selected active:shadow-none",
          "data-[state=open]:bg-selected aria-expanded:bg-selected",
        ],
        secondary: [
          "bg-hover text-ink",
          "hover:bg-selected active:bg-selected active:border-line",
          "data-[state=open]:bg-selected",
        ],
        ghost: [
          "text-ink-secondary",
          "hover:bg-hover hover:text-ink active:bg-selected active:text-ink",
          "data-[state=open]:bg-hover data-[state=open]:text-ink aria-expanded:bg-hover aria-expanded:text-ink",
          "aria-pressed:bg-selected aria-pressed:text-ink",
        ],
        link: [
          "h-auto! border-0 px-0! text-accent-ink underline-offset-2",
          "hover:underline active:opacity-80",
        ],
      },
      size: {
        default: "h-(--st-control-height) px-3 has-[>svg]:px-2.5",
        xs: "h-(--st-control-height-sm) gap-1 px-2 text-sm has-[>svg]:px-1.5 [&_svg]:size-(--st-icon-size-sm)",
        sm: "h-(--st-control-height-sm) gap-1 px-2.5 has-[>svg]:px-2",
        lg: "h-(--st-control-height-lg) gap-2 px-4 text-md has-[>svg]:px-3",
        icon: "size-(--st-control-height)",
        "icon-xs": "size-(--st-control-height-sm) [&_svg]:size-(--st-icon-size-sm)",
        "icon-sm": "size-(--st-control-height-sm)",
        "icon-lg": "size-(--st-control-height-lg) [&_svg]:size-(--st-icon-size-lg)",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
