// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "@/lib/utils";

function Separator({ className, orientation = "horizontal", ...props }: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:not-[[class^='h-']]:not-[[class*='_h-']]:self-stretch",
        className,
      )}
      data-slot="separator"
      orientation={orientation}
      {...props}
    />
  );
}

export { Separator };
