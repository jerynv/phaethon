import type { ComponentProps } from "react";
import { Input as VicInput } from "vic-ui";
import { cn } from "@/lib/utils";

function Input({ className, ...props }: ComponentProps<"input">) {
  return <VicInput {...props} data-slot="input" className={cn("min-h-(--ph-control-height)", className)} />;
}

export { Input };
