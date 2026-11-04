import type { ComponentProps } from "react";
import { TextareaControl } from "vic-ui";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <TextareaControl {...props} data-slot="textarea" className={cn("min-h-[calc(var(--ph-control-height)*2)]", className)} />;
}
