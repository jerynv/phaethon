import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { channel, tempHome } from "../../../tests/harness.ts";
import { ensureVault } from "../core/vault.ts";
import { setSetting } from "../settings/settings.ts";
import { readItems, writeItems, type MemoryItem } from "../memory/items.ts";
import { _resetJobs, registerJob, tick, type JobDef } from "../jobs/scheduler.ts";
import { _resetBackground, inQuiet, notify, openTarget, parseNotify, recentNotifications, setBackgroundSettings, setNotifySettings, subscribe, trayState, type AppEvent } from "./background.ts";
import { remindDue } from "./commands.ts";

const env = tempHome();
ensureVault();
const log = path.join(env.home, "notify.jsonl");
process.env.PHAETHON_NOTIFY_LOG = log;
afterAll(() => env.cleanup());
beforeEach(() => {
  _resetBackground();
  setSetting("notifications", undefined);
  setSetting("background", undefined);
  fs.rmSync(log, { force: true });
});

const at = (h: number, m = 0) => new Date(2026, 10, 16, h, m).getTime();

describe("notification settings", () => {
  it("quiet hours, including ones that run past midnight", () => {
    expect(inQuiet({ from: "22:00", to: "07:00" }, at(23))).toBe(true);
    expect(inQuiet({ from: "22:00", to: "07:00" }, at(6, 59))).toBe(true);
    expect(inQuiet({ from: "22:00", to: "07:00" }, at(7))).toBe(false);
    expect(inQuiet({ from: "13:00", to: "14:00" }, at(13, 30))).toBe(true);
    expect(inQuiet(null, at(3))).toBe(false);
  });

  it("fields fall back one by one", () => {
    expect(parseNotify({ enabled: "yes", kinds: { mail: false }, reminderMinutes: -3, quiet: { from: "25:00", to: "07:00" } })).toMatchObject({ enabled: true, kinds: { mail: false, reply: true }, reminderMinutes: 15, quiet: null });
  });

  it("a kind turned off isn't shown or kept; others are kept for the menu and logged", async () => {
    setNotifySettings({ kinds: { mail: false } as never });
    await notify({ kind: "mail", title: "Sent", body: "x" });
    await notify({ kind: "schedule", title: "Morning check", body: "Done." });
    expect(recentNotifications().map((n) => n.title)).toEqual(["Morning check"]);
    expect(trayState().unseen).toBe(1);
    expect(fs.readFileSync(log, "utf8")).toContain("Morning check");
    setNotifySettings({ enabled: false });
    await notify({ kind: "schedule", title: "Off", body: "" });
    expect(recentNotifications()).toHaveLength(1);
  });
});

describe("the window's event stream", () => {
  it("a target opened before any window listens waits for the first one", () => {
    openTarget({ kind: "thread", space: "work", thread: "123" });
    const ch = channel<AppEvent>();
    subscribe(ch);
    expect(ch.messages).toEqual([{ kind: "open", target: { kind: "thread", space: "work", thread: "123" } }]);
    openTarget({ kind: "settings", section: "memory" });
    expect(ch.messages.at(-1)).toEqual({ kind: "open", target: { kind: "settings", section: "memory" } });
  });
});

describe("reminders", () => {
  const item = (p: Partial<MemoryItem> & Pick<MemoryItem, "id" | "kind" | "text">): MemoryItem => ({ space: "work", scope: "space", created: 1, updated: 1, status: "active", keywords: [], people: [], origin: "agent", ...p });

  it("once, inside the lead time, for events and due tasks only", async () => {
    const now = Date.now();
    writeItems([
      item({ id: "soon", kind: "event", text: "Team sync", when: now + 10 * 60_000, source: { space: "work", thread: "9" } }),
      item({ id: "later", kind: "event", text: "Dentist", when: now + 3 * 3_600_000 }),
      item({ id: "task", kind: "task", text: "Send slides", when: now + 5 * 60_000 }),
      item({ id: "note", kind: "note", text: "Prefers email", when: now + 5 * 60_000 }),
      item({ id: "past", kind: "event", text: "Yesterday", when: now - 60_000 }),
    ]);
    expect(await remindDue(now)).toBe(2);
    const titles = recentNotifications().map((n) => n.title);
    expect(titles).toEqual(expect.arrayContaining(["In 10 min: Team sync", "Due in 5 min: Send slides"]));
    expect(recentNotifications().find((n) => n.title.includes("Team sync"))!.target).toEqual({ kind: "thread", space: "work", thread: "9" });
    expect(await remindDue(now + 60_000)).toBe(0);
    expect(readItems().find((i) => i.id === "soon")!.reminded).toBe(now);
  });

  it("a lead time of 0 turns them off", async () => {
    setNotifySettings({ reminderMinutes: 0 });
    writeItems([item({ id: "soon", kind: "event", text: "Team sync", when: Date.now() + 60_000 })]);
    expect(await remindDue()).toBe(0);
  });
});

describe("pausing automations", () => {
  it("paused automations wait; the sweep and reminders don't", async () => {
    _resetJobs();
    const runs: string[] = [];
    const job = (id: string): JobDef => ({ id, title: id, description: "", cron: () => "* * * * *", defaultOn: true, optional: false, model: false, ready: () => ({ ok: true }), run: async () => (runs.push(id), "ok") });
    registerJob(job("schedule:x"));
    registerJob(job("reminders"));
    registerJob(job("memory-sweep"));
    setBackgroundSettings({ pausedUntil: Date.now() + 3_600_000 });
    await tick(Date.now() + 60_000);
    await new Promise((r) => setTimeout(r, 10));
    expect(runs.sort()).toEqual(["memory-sweep", "reminders"]);
    setBackgroundSettings({ pausedUntil: null });
    runs.length = 0;
    await tick(Date.now() + 120_000);
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toContain("schedule:x");
  });
});
