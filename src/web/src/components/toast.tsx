import { Toast } from "@base-ui/react/toast";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * Toasts are for things the user isn't looking at: a background job that
 * finished or failed, a copy confirmation. Bottom right, at most three, the
 * title one line and the description up to three (docs/UI-REBUILD.md ›
 * Errors). Errors that belong to a surface are shown in that surface instead.
 *
 * The icon pops in, a hairline along the bottom counts down the time left
 * (paused while hovered, like the timer), and `toast.promise` shows a
 * spinner that turns into the result.
 */

type ToastType = "success" | "error" | "warning" | "info" | "loading";
type ToastData = { action?: { label: string; onClick: () => void }; timeout?: number };

export const toastManager = Toast.createToastManager<ToastData>();

const timeoutFor = (type: ToastType | undefined, given?: number) => given ?? (type === "error" ? 8000 : type === "loading" ? 0 : 4000);

export const toast = {
  show: (o: { type?: ToastType; title: string; description?: string; action?: ToastData["action"]; timeout?: number }) => {
    const timeout = timeoutFor(o.type, o.timeout);
    return toastManager.add({ type: o.type ?? "info", title: o.title, description: o.description, timeout, data: { action: o.action, timeout } });
  },
  success: (title: string, description?: string) => toast.show({ type: "success", title, description }),
  error: (title: string, description?: string, action?: ToastData["action"]) => toast.show({ type: "error", title, description, action }),
  info: (title: string, description?: string) => toast.show({ type: "info", title, description }),
  /** A spinner while `p` runs, then its success or failure in the same toast. */
  promise: <T,>(p: Promise<T>, o: { loading: string; success: string | ((v: T) => string); error: string | ((e: unknown) => string) }) =>
    toastManager.promise(p, {
      loading: { title: o.loading, type: "loading", timeout: 0, data: { timeout: 0 } },
      success: (v: T) => ({ title: typeof o.success === "function" ? o.success(v) : o.success, type: "success", timeout: 4000, data: { timeout: 4000 } }),
      error: (e: unknown) => ({ title: typeof o.error === "function" ? o.error(e) : o.error, type: "error", timeout: 8000, data: { timeout: 8000 } }),
    }),
};

const ICONS: Record<ToastType, ReactNode> = {
  success: <CircleCheckIcon className="size-4 text-success" />,
  error: <CircleAlertIcon className="size-4 text-error" />,
  warning: <TriangleAlertIcon className="size-4 text-warning" />,
  info: <InfoIcon className="size-4 text-muted-foreground" />,
  loading: <Spinner size="md" tone="muted" />,
};

function Toasts() {
  const { toasts } = Toast.useToastManager<ToastData>();
  return (
    <Toast.Portal>
      <Toast.Viewport className="fixed right-4 bottom-4 z-(--z-toast) flex w-88 max-w-(--viewport-max-width) flex-col-reverse gap-2 outline-none" data-slot="toast-viewport">
        {toasts.slice(-3).map((t) => {
          const type = (t.type as ToastType) ?? "info";
          const timeout = t.data?.timeout ?? 0;
          return (
            <Toast.Root
              key={t.id}
              toast={t}
              swipeDirection={["right", "down"]}
              data-type={type}
              className={cn(
                "group relative flex w-full items-start gap-2.5 overflow-hidden rounded-xl border bg-popover py-2.5 pr-8 pl-3 text-popover-foreground shadow-popup transition-[transform,opacity] duration-200 ease-drawer",
                "data-starting-style:translate-y-3 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:translate-x-4 data-ending-style:opacity-0",
              )}
            >
              <motion.span
                key={type}
                className="mt-0.5 shrink-0"
                initial={{ scale: 0.4, rotate: -20, opacity: 0 }}
                animate={{ scale: 1, rotate: 0, opacity: 1 }}
                transition={{ type: "spring", duration: 0.35, bounce: 0.45, delay: 0.05 }}
              >
                {ICONS[type]}
              </motion.span>
              <Toast.Content className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Toast.Title className="truncate font-medium text-sm" />
                {t.description ? <Toast.Description className="line-clamp-3 text-muted-foreground text-xs" /> : null}
                {t.data?.action ? (
                  <button
                    type="button"
                    className="mt-1 self-start font-medium text-primary text-xs hover:underline"
                    onClick={() => {
                      t.data?.action?.onClick();
                      toastManager.close(t.id);
                    }}
                  >
                    {t.data.action.label}
                  </button>
                ) : null}
              </Toast.Content>
              <Toast.Close
                aria-label="Dismiss"
                className="absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
              >
                <XIcon className="size-3" />
              </Toast.Close>
              {timeout > 0 ? (
                <span
                  key={`${type}-${timeout}`}
                  aria-hidden
                  className={cn(
                    "absolute inset-x-0 bottom-0 h-px origin-left animate-toast-countdown group-hover:[animation-play-state:paused]",
                    type === "error" ? "bg-error/60" : type === "success" ? "bg-success/60" : "bg-foreground/20",
                  )}
                  style={{ animationDuration: `${timeout}ms` }}
                />
              ) : null}
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={toastManager} limit={3}>
      {children}
      <Toasts />
    </Toast.Provider>
  );
}
