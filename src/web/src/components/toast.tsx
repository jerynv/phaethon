import { Toast } from "@base-ui/react/toast";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Toasts are for things the user isn't looking at: a background job that
 * finished or failed, a copy confirmation. Bottom right, at most three, the
 * title one line and the description up to three (docs/UI-REBUILD.md ›
 * Errors). Errors that belong to a surface are shown in that surface instead.
 */

type ToastType = "success" | "error" | "warning" | "info";
type ToastData = { action?: { label: string; onClick: () => void } };

export const toastManager = Toast.createToastManager<ToastData>();

export const toast = {
  show: (o: { type?: ToastType; title: string; description?: string; action?: ToastData["action"]; timeout?: number }) =>
    toastManager.add({ type: o.type ?? "info", title: o.title, description: o.description, timeout: o.timeout ?? (o.type === "error" ? 8000 : 4000), data: { action: o.action } }),
  success: (title: string, description?: string) => toast.show({ type: "success", title, description }),
  error: (title: string, description?: string, action?: ToastData["action"]) => toast.show({ type: "error", title, description, action }),
  info: (title: string, description?: string) => toast.show({ type: "info", title, description }),
};

const ICONS: Record<ToastType, ReactNode> = {
  success: <CircleCheckIcon className="size-4 text-success" />,
  error: <CircleAlertIcon className="size-4 text-error" />,
  warning: <TriangleAlertIcon className="size-4 text-warning" />,
  info: <InfoIcon className="size-4 text-muted-foreground" />,
};

function Toasts() {
  const { toasts } = Toast.useToastManager<ToastData>();
  return (
    <Toast.Portal>
      <Toast.Viewport className="fixed right-4 bottom-4 z-[150] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col-reverse gap-2 outline-none" data-slot="toast-viewport">
        {toasts.slice(-3).map((t) => (
          <Toast.Root
            key={t.id}
            toast={t}
            swipeDirection={["right", "down"]}
            className={cn(
              "group relative flex w-full items-start gap-2.5 rounded-[10px] border bg-popover py-2.5 pr-8 pl-3 text-popover-foreground shadow-lg/5 transition-[transform,opacity] duration-200 ease-drawer dark:shadow-none",
              "data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:translate-x-4",
            )}
          >
            <span className="mt-0.5 shrink-0">{ICONS[(t.type as ToastType) ?? "info"]}</span>
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
              <XIcon className="size-3" strokeWidth={2.25} />
            </Toast.Close>
          </Toast.Root>
        ))}
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
