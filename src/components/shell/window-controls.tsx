import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";
import { useEffect, useState, type ReactNode } from "react";

import { Icon } from "@/icons";
import { cn } from "@/lib/utils";

function currentWindow(): TauriWindow | null {
  try {
    return getCurrentWindow();
  } catch {
    return null; // a plain browser: no native window to drive
  }
}

/** Minimize / maximize-restore / close for Windows and Linux, where we draw the title bar ourselves. */
export function WindowControls() {
  const [win] = useState(currentWindow);
  const [maximized, setMaximized] = useState(false);

  // Keep the maximize / restore glyph honest. A maximize from the keyboard
  // (Win+Up) or a double-click on the bar also resizes the page, so a DOM
  // resize listener is enough; no event permission needed.
  useEffect(() => {
    if (!win) return;
    let live = true;
    const sync = () => {
      win.isMaximized().then(
        (m) => live && setMaximized(Boolean(m)),
        () => {},
      );
    };
    sync();
    window.addEventListener("resize", sync);
    return () => {
      live = false;
      window.removeEventListener("resize", sync);
    };
  }, [win]);

  if (!win) return null;

  return (
    <div role="group" aria-label="Window" className="flex h-full self-stretch">
      <ControlButton label="Minimize" onClick={() => void win.minimize()}>
        <Icon name="window-minimize" className="size-(--st-icon-size-sm)" />
      </ControlButton>
      <ControlButton label={maximized ? "Restore" : "Maximize"} onClick={() => void win.toggleMaximize()}>
        <Icon name={maximized ? "window-restore" : "window-maximize"} className="size-(--st-icon-size-sm)" />
      </ControlButton>
      <ControlButton label="Close" danger onClick={() => void win.close()}>
        <Icon name="window-close" className="size-(--st-icon-size-sm)" />
      </ControlButton>
    </div>
  );
}

function ControlButton({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      data-window-control=""
      className={cn(
        "flex h-full w-(--st-window-control-width) items-center justify-center text-ink-secondary",
        "transition-colors duration-(--st-duration-fast)",
        "group-data-[inactive]/titlebar:text-ink-tertiary",
        // The bar meets the window edge, so draw the focus ring inside the button.
        "focus-visible:-outline-offset-2!",
        danger
          ? "hover:bg-danger hover:text-ink-inverse active:bg-danger/85 active:text-ink-inverse"
          : "hover:bg-hover hover:text-ink active:bg-selected",
      )}
    >
      {children}
    </button>
  );
}
