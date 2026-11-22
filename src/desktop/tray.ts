import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import { IDENTITY } from "../shared/channel.ts";
import type { AppTarget, TrayAction, TrayState } from "../shared/host.ts";
import { TRAY_ICON_1X, TRAY_ICON_2X } from "./tray-icon.ts";

/**
 * Phaethon in the menu bar (the notification area on Windows and Linux): a
 * native menu, rebuilt only when the core's state changes, so it costs next
 * to nothing while Phaethon runs in the background. It shows what's happening
 * (replies being written, sends counting down, the next automation), the
 * latest notifications, and the few things worth doing without the window.
 */

export type TrayHandlers = {
  open: (target?: AppTarget) => void;
  action: (a: TrayAction) => void;
  quit: () => void;
};

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

function when(ms: number, now = Date.now()): string {
  const secs = Math.round((ms - now) / 1000);
  if (secs < 60) return secs <= 0 ? "now" : `in ${secs} s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `in ${mins} min`;
  return new Date(ms).toDateString() === new Date(now).toDateString() ? `at ${clock.format(ms)}` : day.format(ms);
}

/** Minutes until 8 am tomorrow, for "Pause until tomorrow". */
function untilTomorrow(now = new Date()): number {
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  t.setHours(8, 0, 0, 0);
  return Math.round((t.getTime() - now.getTime()) / 60_000);
}

export function menuTemplate(state: TrayState, h: TrayHandlers, now = Date.now()): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [{ label: `Open ${IDENTITY.productName}`, click: () => h.open() }, { type: "separator" }];
  if (state.running) items.push({ label: state.running === 1 ? "Writing a reply…" : `Writing ${state.running} replies…`, enabled: false });
  for (const s of state.sending) {
    items.push({ label: `Sending “${s.subject || "(no subject)"}” to ${s.to} ${when(s.sendAt, now)}`, enabled: false });
    items.push({ label: "Stop sending", click: () => h.action({ kind: "stopSend", space: s.space, id: s.id }) });
  }
  const a = state.automations;
  if (a.pausedUntil && a.pausedUntil > now) {
    items.push({ label: `Automations paused until ${new Date(a.pausedUntil).toDateString() === new Date(now).toDateString() ? clock.format(a.pausedUntil) : day.format(a.pausedUntil)}`, enabled: false });
    items.push({ label: "Resume automations", click: () => h.action({ kind: "resumeAutomations" }) });
  } else if (a.on) {
    if (a.runningTitle) items.push({ label: `Running: ${a.runningTitle}`, enabled: false });
    else if (a.next) items.push({ label: `Next: ${a.next.title} ${when(a.next.at, now)}`, enabled: false });
    items.push({
      label: "Pause automations",
      submenu: [
        { label: "For 1 hour", click: () => h.action({ kind: "pauseAutomations", minutes: 60 }) },
        { label: "Until tomorrow morning", click: () => h.action({ kind: "pauseAutomations", minutes: untilTomorrow(new Date(now)) }) },
        { label: "For a week", click: () => h.action({ kind: "pauseAutomations", minutes: 7 * 24 * 60 }) },
      ],
    });
  }
  if (state.running || state.sending.length || a.on || a.pausedUntil) items.push({ type: "separator" });
  if (state.recent.length) {
    items.push({ label: "Recent", enabled: false });
    for (const n of state.recent.slice(0, 5)) items.push({ label: n.title.length > 60 ? `${n.title.slice(0, 59)}…` : n.title, toolTip: n.body, click: () => h.open(n.target) });
    items.push({ type: "separator" });
  }
  items.push({ label: "Settings…", click: () => h.open({ kind: "settings", section: "notifications" }) });
  items.push({ label: `Quit ${IDENTITY.productName}`, accelerator: "CommandOrControl+Q", click: () => h.quit() });
  return items;
}

export function createTray(h: TrayHandlers): { update: (state: TrayState) => void; destroy: () => void } {
  const icon = nativeImage.createEmpty();
  icon.addRepresentation({ scaleFactor: 1, dataURL: TRAY_ICON_1X });
  icon.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_2X });
  icon.setTemplateImage(true);
  const tray = new Tray(icon);
  tray.setToolTip(IDENTITY.productName);
  let state: TrayState = { keepRunning: true, openAtLogin: false, running: 0, sending: [], automations: { on: 0 }, recent: [], unseen: 0 };
  const rebuild = () => {
    const menu = Menu.buildFromTemplate(menuTemplate(state, h));
    // Opening the menu counts as seeing what's new.
    menu.on("menu-will-show", () => state.unseen && h.action({ kind: "seen" }));
    tray.setContextMenu(menu);
    if (process.platform === "darwin") tray.setTitle(state.unseen ? String(state.unseen) : "", { fontType: "monospacedDigit" });
    const busy = state.running ? "writing a reply" : state.sending.length ? "sending mail" : "";
    tray.setToolTip(busy ? `${IDENTITY.productName} · ${busy}` : IDENTITY.productName);
  };
  rebuild();
  return {
    update(next) {
      state = next;
      rebuild();
    },
    destroy: () => tray.destroy(),
  };
}
