// Adapted from shadcn/ui (MIT, https://github.com/shadcn-ui/ui), restyled onto steward tokens.
import * as React from "react"
import { cn } from "cn"

import { fieldClasses } from "@/components/ui/input"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClasses, "flex field-sizing-content min-h-16 px-2.5 py-1.5 leading-normal", className)}
      {...props}
    />
  )
}

export { Textarea }
