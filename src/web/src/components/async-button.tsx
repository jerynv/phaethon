import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/toast";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";

/**
 * Pending, done, failed for one click. Runs `action`; while it runs the
 * button shows a spinner (keeping its width), then a check for a moment.
 * A failure shakes the button and, when `failure` names it, says so in a toast.
 */
export function useAsyncAction(action: () => Promise<unknown>, failure?: string) {
  const [state, setState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
      clearTimeout(timer.current);
    },
    [],
  );
  const run = async () => {
    if (state === "pending") return;
    clearTimeout(timer.current);
    setState("pending");
    try {
      await action();
      if (!live.current) return;
      setState("success");
      timer.current = setTimeout(() => live.current && setState("idle"), 1200);
    } catch (e) {
      if (!live.current) return;
      setState("error");
      if (failure) toast.error(failure, errorText(e));
      timer.current = setTimeout(() => live.current && setState("idle"), 500);
    }
  };
  return { state, run };
}

export function AsyncButton({
  action,
  failure,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "onClick" | "pending" | "success"> & { action: () => Promise<unknown>; failure?: string }) {
  const { state, run } = useAsyncAction(action, failure);
  return (
    <Button
      {...props}
      className={cn(className, state === "error" && "animate-shake")}
      pending={state === "pending"}
      success={state === "success"}
      onClick={() => void run()}
    />
  );
}
