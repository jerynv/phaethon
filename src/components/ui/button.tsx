// Adapted from shadcn/ui (MIT, https://github.com/shadcn-ui/ui), restyled onto Phaethon tokens.
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"
import { Button as VicButton, DangerButton } from "vic-ui"

// Vic owns the rim, face and interaction states; these sizes retain Phaethon's
// text scaling and minimum targets. Text labels can wrap without being clipped.
const buttonVariants = cva(
  "ui-button h-auto! min-w-0 shrink-0 whitespace-normal! text-balance select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&>.ui-button-face]:h-auto [&>.ui-button-face]:min-h-0 [&>.ui-button-face]:py-0.5 [&>.ui-button-face]:leading-tight",
  {
    variants: {
      variant: {
        default: "ui-button-ink",
        destructive: "ui-button-ink ui-button-danger",
        outline: "ui-button-line",
        ghost: "ui-button-quiet",
        link: "ui-button-link",
      },
      size: {
        default: "min-h-(--ph-control-height) [&>.ui-button-face]:px-2.5",
        xs: "min-h-(--ph-control-height-sm) text-sm! [&>.ui-button-face]:gap-1 [&>.ui-button-face]:px-1.5 [&_svg]:size-(--ph-icon-size-sm)",
        sm: "min-h-(--ph-control-height-sm) [&>.ui-button-face]:gap-1 [&>.ui-button-face]:px-2",
        lg: "min-h-(--ph-control-height-lg) text-md! [&>.ui-button-face]:px-3",
        icon: "ui-button-square size-(--ph-control-height) [&>.ui-button-face]:p-0",
        "icon-xs": "ui-button-square size-(--ph-control-height-sm) [&>.ui-button-face]:p-0 [&_svg]:size-(--ph-icon-size-sm)",
        "icon-sm": "ui-button-square size-(--ph-control-height-sm) [&>.ui-button-face]:p-0",
        "icon-lg": "ui-button-square size-(--ph-control-height-lg) [&>.ui-button-face]:p-0 [&_svg]:size-(--ph-icon-size-lg)",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)

const looks = { default: "ink", destructive: "ink", outline: "line", ghost: "quiet", link: "link" } as const

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  children,
  type,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const shared = {
    "data-slot": "button",
    "data-variant": variant,
    "data-size": size,
    className: cn(buttonVariants({ variant, size, className }), asChild && (size === "lg" || size === "icon-lg") && "ui-button-lg"),
    ...props,
  }

  // Keep Slot's event/ref composition for links and assistant-ui/Radix triggers.
  // The face belongs inside the slotted element, never around the control.
  if (asChild) {
    const child = React.Children.only(children) as React.ReactElement<{ children?: React.ReactNode }>
    return (
      <Slot.Root {...shared} {...(type ? { type } : {})}>
        {React.cloneElement(child, {}, <span className="ui-button-face">{child.props.children}</span>)}
      </Slot.Root>
    )
  }
  const Comp = variant === "destructive" ? DangerButton : VicButton
  return (
    <Comp {...shared} look={looks[variant ?? "default"]} size={size === "lg" || size === "icon-lg" ? "lg" : "md"} square={size?.startsWith("icon")} type={type ?? "submit"}>
      {children}
    </Comp>
  )
}

export { Button, buttonVariants }
