import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ Menu: {}, nativeImage: {}, Tray: class {} }));
const { menuTemplate } = await import("../src/desktop/tray.ts");

const h = { open: vi.fn(), action: vi.fn(), quit: vi.fn() };
const base = { keepRunning: true, openAtLogin: false, running: 0, sending: [], automations: { on: 0 }, recent: [], unseen: 0 };
const labels = (items: { label?: string; type?: string }[]) => items.map((i) => i.label ?? `--${i.type}`);

describe("the menu-bar menu", () => {
  it("quiet: open, settings, quit", () => {
    expect(labels(menuTemplate(base, h))).toEqual(["Open Phaethon", "--separator", "Settings…", "Quit Phaethon"]);
  });

  it("shows replies, sends counting down with Stop, the next automation with Pause, and recent notifications that open their place", () => {
    const now = new Date(2026, 10, 16, 9, 0).getTime();
    const items = menuTemplate(
      {
        ...base,
        running: 2,
        sending: [{ space: "work", id: "d_1", to: "dana@corp.com", subject: "Out sick", sendAt: now + 40_000 }],
        automations: { on: 2, next: { title: "Morning inbox check", at: now + 30 * 60_000 } },
        recent: [{ id: "n1", kind: "reminder", title: "In 10 min: Team sync", body: "", at: now, target: { kind: "thread", space: "work", thread: "9" } }],
        unseen: 1,
      },
      h,
      now,
    );
    expect(labels(items)).toEqual([
      "Open Phaethon",
      "--separator",
      "Writing 2 replies…",
      "Sending “Out sick” to dana@corp.com in 40 s",
      "Stop sending",
      "Next: Morning inbox check in 30 min",
      "Pause automations",
      "--separator",
      "Recent",
      "In 10 min: Team sync",
      "--separator",
      "Settings…",
      "Quit Phaethon",
    ]);
    (items.find((i) => i.label === "Stop sending")!.click as () => void)();
    expect(h.action).toHaveBeenCalledWith({ kind: "stopSend", space: "work", id: "d_1" });
    (items.find((i) => i.label === "In 10 min: Team sync")!.click as () => void)();
    expect(h.open).toHaveBeenCalledWith({ kind: "thread", space: "work", thread: "9" });
  });

  it("paused automations offer Resume", () => {
    const now = Date.now();
    const items = menuTemplate({ ...base, automations: { on: 1, pausedUntil: now + 3_600_000 } }, h, now);
    expect(labels(items)).toContain("Resume automations");
  });
});
