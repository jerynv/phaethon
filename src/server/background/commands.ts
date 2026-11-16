import type { AppTarget } from "#shared/host.ts";
import { commands, Refusal } from "../rpc/registry.ts";
import type { Channel } from "../rpc/channel.ts";
import { host } from "../host.ts";
import { onStart, onStop } from "../lifecycle.ts";
import { runCount } from "../core/runs.ts";
import { listSpaces } from "../spaces/meta.ts";
import { listDrafts, onDraftChange, stopSend } from "../mail/outbox.ts";
import { formatWhen, mutateItems } from "../memory/items.ts";
import { registerJob, viewJobs, type JobDef } from "../jobs/scheduler.ts";
import {
  backgroundSettings,
  markSeen,
  notify,
  notifySettings,
  openTarget,
  pushTray,
  recentNotifications,
  setBackgroundSettings,
  setNotifySettings,
  setTrayParts,
  subscribe,
  type AppEvent,
  type BackgroundSettings,
  type NotifySettings,
} from "./background.ts";

/** Settings › Notifications, the app-wide event stream, the menu bar's actions and the reminders job. */

function spaceIds(): string[] {
  try {
    return listSpaces().map((s) => s.id);
  } catch {
    return [];
  }
}

// What the menu bar shows: replies being written, sends counting down, automations.
setTrayParts(() => {
  const sending = spaceIds().flatMap((space) => {
    try {
      return listDrafts(space)
        .filter((d) => d.status === "scheduled" && d.sendAt !== undefined)
        .map((d) => ({ space, id: d.id, to: d.to.join(", ") || "(no one yet)", subject: d.subject, sendAt: d.sendAt! }));
    } catch {
      return [];
    }
  });
  const jobs = viewJobs();
  const automations = jobs.filter((j) => j.id.startsWith("schedule:") || (j.optional && j.enabled && j.ready.ok));
  const upcoming = automations.filter((j) => j.next !== null).sort((a, b) => a.next! - b.next!)[0];
  const running = jobs.find((j) => j.running);
  return {
    running: runCount(),
    sending,
    automations: { on: automations.length, ...(upcoming ? { next: { title: upcoming.title, at: upcoming.next! } } : {}), ...(running ? { runningTitle: running.title } : {}) },
  };
});

/**
 * Reminders: an event (or a task's due time) on the front burner, a set
 * number of minutes before it, once. No model.
 */
export async function remindDue(now = Date.now()): Promise<number> {
  const lead = notifySettings().reminderMinutes;
  if (!lead) return 0;
  const due = mutateItems((items) => {
    const out: typeof items = [];
    for (const it of items) {
      if (it.status !== "active" || it.reminded || it.when === undefined || (it.kind !== "event" && it.kind !== "task")) continue;
      if (it.when > now && it.when - now <= lead * 60_000) {
        it.reminded = now;
        out.push({ ...it });
      }
    }
    return out;
  });
  for (const it of due) {
    const mins = Math.max(1, Math.round((it.when! - now) / 60_000));
    const target: AppTarget = it.source ? { kind: "thread", space: it.source.space, thread: it.source.thread } : { kind: "settings", section: "memory" };
    await notify({ kind: "reminder", title: it.kind === "task" ? `Due in ${mins} min: ${it.text}` : `In ${mins} min: ${it.text}`, body: `${formatWhen(it.when!)} · ${it.space}`, target });
  }
  return due.length;
}

export const REMINDERS: JobDef = {
  id: "reminders",
  title: "Reminders",
  description: "Every minute, a notification shortly before an event or a task's due time on the front burner (the lead time is in Settings › Notifications). No model.",
  cron: () => "* * * * *",
  defaultOn: true,
  optional: true,
  model: false,
  ready: () => (notifySettings().enabled && notifySettings().kinds.reminder && notifySettings().reminderMinutes > 0 ? { ok: true } : { ok: false, reason: "Reminders are off in Settings › Notifications." }),
  run: async () => {
    const n = await remindDue();
    return n ? `Reminded of ${n}.` : "Nothing coming up.";
  },
};
registerJob(REMINDERS);

commands({
  notify_settings_get: () => notifySettings(),
  notify_settings_set: ({ patch }: { patch: Partial<NotifySettings> }) => setNotifySettings(patch ?? {}),
  background_get: () => backgroundSettings(),
  background_set: ({ patch }: { patch: Partial<Omit<BackgroundSettings, "pausedUntil">> & { pausedUntil?: number | null } }) => setBackgroundSettings(patch ?? {}),
  automations_pause: ({ minutes }: { minutes: number }) => {
    if (typeof minutes !== "number" || minutes <= 0 || minutes > 7 * 24 * 60) throw new Refusal("Pause for between a minute and a week.");
    return setBackgroundSettings({ pausedUntil: Date.now() + minutes * 60_000 });
  },
  automations_resume: () => setBackgroundSettings({ pausedUntil: null }),
  notifications_recent: () => recentNotifications(),
  notifications_seen: () => markSeen(),
  /** A test notification, so the person can see that (and how) they arrive. */
  notify_test: async () => ({
    shown: await notify({ kind: "job", title: "Notifications are on", body: "Reminders, finished tasks and mail will show up like this.", target: { kind: "settings", section: "notifications" } }),
    desktop: host().available,
  }),
  /** The window's one stream of app-wide events (a notification clicked, something to open). Call once per window. */
  app_events: ({ onEvent }: { onEvent: Channel<AppEvent> }) => {
    subscribe(onEvent);
    return null;
  },
});

let tick: NodeJS.Timeout | undefined;

onStart("background: menu bar and notifications", () => {
  host().on((event) => {
    if (event.kind === "openTarget") openTarget(event.target);
    else if (event.kind === "trayAction") {
      const a = event.action;
      if (a.kind === "stopSend") {
        try {
          stopSend(a.space, a.id);
        } catch {
          // gone already
        }
      } else if (a.kind === "pauseAutomations") setBackgroundSettings({ pausedUntil: Date.now() + a.minutes * 60_000 });
      else if (a.kind === "resumeAutomations") setBackgroundSettings({ pausedUntil: null });
      else if (a.kind === "seen") markSeen();
      pushTray();
    }
  });
  onDraftChange(() => pushTray());
  pushTray();
  // Times in the menu ("next in 2 h") and runs ending stay current.
  tick = setInterval(pushTray, 10_000);
  tick.unref?.();
});

onStop("background: stop the menu's clock", () => {
  if (tick) clearInterval(tick);
});
