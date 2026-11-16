import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault } from "../core/vault.ts";
import { describeCron, nextRun, parseCron, previousRun, toCron } from "./cron.ts";
import { _resetJobs, isEnabled, jobBaseline, registerJob, resetBaseline, runJob, setJobEnabled, tick, viewJobs, type JobDef } from "./scheduler.ts";
import { addSchedule, readSchedules, updateSchedule } from "./schedules.ts";

const env = tempHome();
ensureVault();
afterAll(() => env.cleanup());

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe("cron", () => {
  it("parses fields, ranges, steps and names", () => {
    const c = parseCron("*/15 9-17 * * mon-fri");
    expect([...c.minute.values]).toEqual([0, 15, 30, 45]);
    expect([...c.dow.values]).toEqual([1, 2, 3, 4, 5]);
    expect(() => parseCron("61 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("* * *")).toThrow(/five fields/);
  });

  it("finds the next and previous run", () => {
    const c = parseCron("30 7 * * 1-5");
    // Sat Nov 14 2026 → Mon Nov 16 7:30
    expect(nextRun(c, local(2026, 11, 14, 12))).toBe(local(2026, 11, 16, 7, 30));
    expect(previousRun(c, local(2026, 11, 16, 9), 86_400_000)).toBe(local(2026, 11, 16, 7, 30));
    expect(previousRun(c, local(2026, 11, 15, 9), 86_400_000)).toBeUndefined();
  });

  it("day-of-month and weekday together match either (Vixie)", () => {
    const c = parseCron("0 0 1 * 0");
    expect(nextRun(c, local(2026, 11, 2))).toBe(local(2026, 11, 8));
  });

  it("friendly forms", () => {
    expect(toCron("daily 7:30 am")).toBe("30 7 * * *");
    expect(toCron("weekdays 08:00")).toBe("0 8 * * 1-5");
    expect(toCron("weekly mon 9 pm")).toBe("0 21 * * 1");
    expect(toCron("every 30m")).toBe("*/30 * * * *");
    expect(toCron("hourly")).toBe("0 * * * *");
    expect(() => toCron("whenever")).toThrow();
    expect(describeCron("30 7 * * *")).toBe("Every day at 7:30 AM");
    expect(describeCron("0 8 * * 1-5")).toBe("Weekdays at 8:00 AM");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
  });
});

describe("scheduler", () => {
  let runs: string[] = [];
  const job = (p: Partial<JobDef> & { id: string }): JobDef => ({
    title: p.id,
    description: "",
    cron: () => "0 7 * * *",
    defaultOn: true,
    optional: true,
    model: false,
    ready: () => ({ ok: true }),
    run: async () => {
      runs.push(p.id);
      return "done";
    },
    ...p,
  });
  beforeEach(() => {
    _resetJobs();
    runs = [];
  });

  it("first sight starts counting; a missed daily run catches up once; then waits for the next", async () => {
    registerJob(job({ id: "daily" }));
    const t0 = local(2026, 11, 16, 6);
    expect(await tick(t0)).toEqual([]);
    expect(jobBaseline("daily")).toBe(t0);
    // The app was closed at 7:00; opened at 9:00 the same day.
    expect(await tick(local(2026, 11, 16, 9))).toEqual(["daily"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toEqual(["daily"]);
    expect(await tick(local(2026, 11, 16, 10))).toEqual([]);
  });

  it("an idle job says why and doesn't run", async () => {
    registerJob(job({ id: "idle", ready: () => ({ ok: false, reason: "No mail account is assigned to a space yet." }) }));
    resetBaseline("idle");
    expect(await tick(Date.now() + 2 * 86_400_000)).toEqual([]);
    expect(viewJobs().find((j) => j.id === "idle")!.ready).toEqual({ ok: false, reason: "No mail account is assigned to a space yet." });
    await expect(runJob("idle")).rejects.toThrow(/No mail account/);
  });

  it("turning off stops it; the sweep can't be turned off", async () => {
    registerJob(job({ id: "opt" }));
    registerJob(job({ id: "sweep", optional: false }));
    setJobEnabled("opt", false);
    expect(isEnabled({ ...job({ id: "opt" }) })).toBe(false);
    expect(() => setJobEnabled("sweep", false)).toThrow(/can’t be turned off/);
  });

  it("records the result and the failure", async () => {
    registerJob(job({ id: "bad", run: async () => Promise.reject(new Error("boom")) }));
    await expect(runJob("bad")).rejects.toThrow("boom");
    expect(viewJobs().find((j) => j.id === "bad")).toMatchObject({ lastOk: false, lastError: "boom" });
  });
});

describe("schedules", () => {
  it("one from the agent starts off; the person's starts on; bad times are refused", () => {
    const a = addSchedule({ space: "work", title: "Morning mail", prompt: "Summarize", when: "weekdays 8:00 am" }, "agent");
    expect(a).toMatchObject({ enabled: false, cron: "0 8 * * 1-5", origin: "agent" });
    const u = addSchedule({ space: "work", title: "Weekly review", prompt: "Review", when: "weekly fri 16:00" }, "user");
    expect(u.enabled).toBe(true);
    expect(() => addSchedule({ space: "work", title: "x", prompt: "y", when: "sometime" }, "user")).toThrow(/isn’t one Phaethon understands/);
    expect(updateSchedule(a.id, { enabled: true }).enabled).toBe(true);
    expect(readSchedules()).toHaveLength(2);
  });
});
