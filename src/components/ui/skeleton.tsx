// Adapted from shadcn/ui (MIT, https://github.com/shadcn-ui/ui), restyled onto steward tokens.
import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-hover", className)}
      {...props}
    />
  )
}

export { Skeleton }
