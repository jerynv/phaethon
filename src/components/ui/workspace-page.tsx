import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

// The shared, centered content measure follows T3 Code's WorkspacePageContainer pattern.
export function WorkspacePage({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("mx-auto flex w-full max-w-(--ph-thread-width) flex-col gap-6 px-4 pt-6 pb-10 sm:px-6", className)} {...props} />;
}
