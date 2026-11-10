import { app, screen, type BrowserWindow, type Rectangle } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * The main window's size and place, kept in Electron's own profile folder
 * (not the core's app data) and restored only onto a display that still exists.
 */
type Saved = { bounds: Rectangle; maximized: boolean };

function file(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

export function loadWindowState(min: { width: number; height: number }): Saved | null {
  try {
    const saved = JSON.parse(fs.readFileSync(file(), "utf8")) as Saved;
    const b = saved?.bounds;
    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
    const area = screen.getDisplayMatching(b).workArea;
    const visible = b.x < area.x + area.width && b.x + b.width > area.x && b.y < area.y + area.height && b.y + b.height > area.y;
    if (!visible) return null;
    return { bounds: { ...b, width: Math.max(b.width, min.width), height: Math.max(b.height, min.height) }, maximized: Boolean(saved.maximized) };
  } catch {
    return null;
  }
}

export function keepWindowState(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const save = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    const state: Saved = { bounds: window.isMaximized() ? window.getNormalBounds() : window.getBounds(), maximized: window.isMaximized() };
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(state));
    } catch {
      // A window that opens at the default size next time is fine.
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  window.on("resize", later);
  window.on("move", later);
  window.on("close", () => {
    clearTimeout(timer);
    save();
  });
}
