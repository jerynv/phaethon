import fs from "node:fs";
import { randomBytes } from "node:crypto";
import type { AppNotification, AppTarget, NotificationKind, TrayState } from "#shared/host.ts";
import { host } from "../host.ts";
import { log } from "../log.ts";
import { messageOf } from "../rpc/registry.ts";
import type { Channel } from "../rpc/channel.ts";
import { readSettings, setSetting } from "../settings/settings.ts";

/**
 * Phaethon in the background: system notifications, the menu-bar menu's
 * state, and the app-wide event stream to open windows.
 *
 * - `notify` checks the person's notification settings (each kind on or off,
 *   quiet hours), keeps the latest in memory for the menu, and asks the
 *   desktop shell to show it. Without a shell (tests, a served page) it is
 *   only kept (and written to $PHAETHON_NOTIFY_LOG, for tests).
 * - The menu-bar state is pushed to the shell whenever it changes.
 * - A notification or menu item that opens something reaches the window
 *   through `app_events`; one that arrives before a window is listening
 *   waits for it.
 */

// ---- Settings -------------------------------------------------------------------

export type NotifySettings = {
  enabled: boolean;
  kinds: Record<NotificationKind, boolean>;
  /** Minutes before an event (or a task's due time) to remind. 0 turns reminders off. */
  reminderMinutes: number;
  /** "22:00"–"07:00": no sound and no banner then (they still reach the menu). Null for none. */
  quiet: { from: string; to: string } | null;
};

export type BackgroundSettings = {
  keepRunning: boolean;
  openAtLogin: boolean;
  /** Automations don't run before this (ms). */
  pausedUntil?: number;
};

export const DEFAULT_NOTIFY: Readonly<NotifySettings> = Object.freeze({
  enabled: true,
  kinds: { reply: true, schedule: true, mail: true, reminder: true, digest: true, job: true },
  reminderMinutes: 15,
  quiet: null,
});

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

export function parseNotify(raw: unknown): NotifySettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const k = o.kinds && typeof o.kinds === "object" ? (o.kinds as Record<string, unknown>) : {};
  const kinds = { ...DEFAULT_NOTIFY.kinds };
  for (const key of Object.keys(kinds) as NotificationKind[]) if (typeof k[key] === "boolean") kinds[key] = k[key] as boolean;
  const q = o.quiet && typeof o.quiet === "object" ? (o.quiet as Record<string, unknown>) : null;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : true,
    kinds,
    reminderMinutes: typeof o.reminderMinutes === "number" && o.reminderMinutes >= 0 && o.reminderMinutes <= 24 * 60 ? Math.round(o.reminderMinutes) : DEFAULT_NOTIFY.reminderMinutes,
    quiet: q && typeof q.from === "string" && typeof q.to === "string" && HHMM.test(q.from) && HHMM.test(q.to) ? { from: q.from, to: q.to } : null,
  };
}

export function parseBackground(raw: unknown): BackgroundSettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    keepRunning: typeof o.keepRunning === "boolean" ? o.keepRunning : true,
    openAtLogin: typeof o.openAtLogin === "boolean" ? o.openAtLogin : false,
    ...(typeof o.pausedUntil === "number" && o.pausedUntil > Date.now() ? { pausedUntil: o.pausedUntil } : {}),
  };
}

export const notifySettings = () => parseNotify(readSettings().notifications);
export const backgroundSettings = () => parseBackground(readSettings().background);

export function setNotifySettings(patch: Partial<NotifySettings>): NotifySettings {
  const next = parseNotify({ ...notifySettings(), ...patch, kinds: { ...notifySettings().kinds, ...(patch.kinds ?? {}) } });
  setSetting("notifications", next);
  return next;
}

export function setBackgroundSettings(patch: Partial<Omit<BackgroundSettings, "pausedUntil">> & { pausedUntil?: number | null }): BackgroundSettings {
  const cur = backgroundSettings();
  const next = parseBackground({ ...cur, ...patch, pausedUntil: patch.pausedUntil === null ? undefined : (patch.pausedUntil ?? cur.pausedUntil) });
  setSetting("background", next);
  pushTray();
  return next;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

/** Whether `at` falls in the quiet hours (which may run past midnight). */
export function inQuiet(q: NotifySettings["quiet"], at = Date.now()): boolean {
  if (!q) return false;
  const d = new Date(at);
  const now = d.getHours() * 60 + d.getMinutes();
  const from = minutes(q.from);
  const to = minutes(q.to);
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

// ---- Notifications ------------------------------------------------------------------

const MAX_RECENT = 20;
const recent: AppNotification[] = [];
let unseen = 0;

export function recentNotifications(): AppNotification[] {
  return [...recent];
}

/**
 * Shows a notification if the person wants that kind (always kept for the
 * menu). Resolves with whether the system showed it.
 */
export async function notify(n: Omit<AppNotification, "id" | "at"> & { at?: number }): Promise<boolean> {
  const s = notifySettings();
  if (!s.enabled || !s.kinds[n.kind]) return false;
  const full: AppNotification = { ...n, id: `n_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`, at: n.at ?? Date.now(), ...(inQuiet(s.quiet) ? { silent: true } : {}) };
  recent.unshift(full);
  recent.splice(MAX_RECENT);
  unseen++;
  if (process.env.PHAETHON_NOTIFY_LOG) {
    try {
      fs.appendFileSync(process.env.PHAETHON_NOTIFY_LOG, `${JSON.stringify(full)}\n`);
    } catch {
      // a test log only
    }
  }
  pushTray();
  broadcast({ kind: "notification", notification: full });
  const h = host();
  if (!h.available) return false;
  // In quiet hours it reaches the menu but not the screen.
  if (full.silent && inQuiet(s.quiet)) return false;
  try {
    return (await h.call<{ shown: boolean }>({ op: "notify", notification: full })).shown;
  } catch (e) {
    log.warn("notification failed", { error: messageOf(e) });
    return false;
  }
}

/** Fire and forget, for code that shouldn't wait on the shell. */
export function notifyLater(n: Parameters<typeof notify>[0]): void {
  void notify(n).catch(() => {});
}

export function markSeen(): void {
  if (!unseen) return;
  unseen = 0;
  pushTray();
}

// ---- The app-wide event stream -------------------------------------------------------

export type AppEvent = { kind: "open"; target: AppTarget } | { kind: "notification"; notification: AppNotification };

const listeners = new Set<Channel<AppEvent>>();
let waiting: AppTarget | undefined;

export function subscribe(ch: Channel<AppEvent>): void {
  listeners.add(ch);
  ch.onClose(() => listeners.delete(ch));
  if (waiting) {
    const t = waiting;
    waiting = undefined;
    ch.send({ kind: "open", target: t });
  }
}

function broadcast(e: AppEvent): boolean {
  let reached = false;
  for (const ch of [...listeners]) {
    ch.send(e);
    if (ch.closed) listeners.delete(ch);
    else reached = true;
  }
  return reached;
}

/** Opens `target` in the window; if no window is listening yet, the next one that connects opens it. */
export function openTarget(target: AppTarget): void {
  if (!broadcast({ kind: "open", target })) waiting = target;
}

// ---- The menu bar ----------------------------------------------------------------------

type TrayParts = Pick<TrayState, "running" | "sending" | "automations">;
let parts: () => TrayParts = () => ({ running: 0, sending: [], automations: { on: 0 } });

/** The modules that know (runs, outbox, jobs) give their part of the menu. */
export function setTrayParts(f: () => TrayParts): void {
  parts = f;
}

let last = "";
let timer: NodeJS.Timeout | undefined;

export function trayState(): TrayState {
  const b = backgroundSettings();
  let p: TrayParts;
  try {
    p = parts();
  } catch {
    p = { running: 0, sending: [], automations: { on: 0 } };
  }
  return { keepRunning: b.keepRunning, openAtLogin: b.openAtLogin, ...p, automations: { ...p.automations, ...(b.pausedUntil ? { pausedUntil: b.pausedUntil } : {}) }, recent: recent.slice(0, 6), unseen };
}

/** Sends the menu's state to the shell, when it changed (debounced). */
export function pushTray(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    const h = host();
    if (!h.available) return;
    const state = trayState();
    const json = JSON.stringify(state);
    if (json === last) return;
    last = json;
    h.call({ op: "trayState", state }).catch(() => {});
  }, 150);
  timer.unref?.();
}

/** Tests. */
export function _resetBackground(): void {
  recent.splice(0);
  unseen = 0;
  listeners.clear();
  waiting = undefined;
  last = "";
}
