import { afterAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault } from "../core/vault.ts";
import { setSetting } from "../settings/settings.ts";
import { _test, awaitingOutcome, itemsFor, parseItem, parseMemorySettings, readItems, sweep, sweepNow, visibleIn, writeItems, type MemoryItem } from "./items.ts";

const env = tempHome();
ensureVault();
afterAll(() => env.cleanup());

const { HOUR, DAY } = _test;
const NOW = Date.UTC(2026, 10, 15, 19);

function item(p: Partial<MemoryItem> & Pick<MemoryItem, "id" | "kind">): MemoryItem {
  return { text: p.id, space: "work", scope: "space", created: NOW - DAY, updated: NOW - DAY, status: "active", keywords: [], people: [], origin: "agent", ...p };
}

describe("die-off", () => {
  it("a state expires at its end and not before", () => {
    const items = [item({ id: "s", kind: "state", until: NOW + HOUR })];
    expect(sweep(items, NOW).expired).toEqual([]);
    expect(sweep(items, NOW + 2 * HOUR).expired).toEqual(["s"]);
    expect(items[0]!.status).toBe("expired");
  });

  it("extending a state keeps it", () => {
    const items = [item({ id: "s", kind: "state", until: NOW + HOUR })];
    items[0]!.until = NOW + 3 * DAY;
    expect(sweep(items, NOW + 2 * HOUR).expired).toEqual([]);
  });

  it("a passed event awaits its outcome, then expires after the grace period with none recorded", () => {
    const items = [item({ id: "e", kind: "event", when: NOW })];
    expect(awaitingOutcome(items[0]!, NOW + 30 * 60_000)).toBe(false);
    expect(awaitingOutcome(items[0]!, NOW + 2 * HOUR)).toBe(true);
    expect(sweep(items, NOW + 2 * DAY, { eventGraceDays: 3, archiveDays: 90 }).expired).toEqual([]);
    expect(sweep(items, NOW + 4 * DAY, { eventGraceDays: 3, archiveDays: 90 }).expired).toEqual(["e"]);
    expect(items[0]!.outcome).toMatch(/No outcome/);
  });

  it("a closed item leaves the archive after the keep time; 0 keeps it", () => {
    const done = () => [item({ id: "d", kind: "event", when: NOW, status: "done", closed: NOW })];
    const a = done();
    expect(sweep(a, NOW + 10 * DAY, { eventGraceDays: 3, archiveDays: 30 }).purged).toEqual([]);
    expect(sweep(a, NOW + 31 * DAY, { eventGraceDays: 3, archiveDays: 30 }).purged).toEqual(["d"]);
    expect(a).toEqual([]);
    const b = done();
    expect(sweep(b, NOW + 3000 * DAY, { eventGraceDays: 3, archiveDays: 0 }).purged).toEqual([]);
  });

  it("a note without an end never expires", () => {
    expect(sweep([item({ id: "n", kind: "note" })], NOW + 400 * DAY, { eventGraceDays: 3, archiveDays: 0 }).expired).toEqual([]);
  });
});

describe("walls", () => {
  const s = { shareAcrossSpaces: true, isolatedSpaces: [] as string[] };
  it("space items stay in their space", () => {
    expect(visibleIn(item({ id: "a", kind: "note", space: "work" }), "school", s)).toBe(false);
    expect(visibleIn(item({ id: "a", kind: "note", space: "work" }), "work", s)).toBe(true);
  });
  it("vault items cross only with the setting, and never into an isolated space", () => {
    const v = item({ id: "v", kind: "state", scope: "vault", space: "life" });
    expect(visibleIn(v, "work", s)).toBe(true);
    expect(visibleIn(v, "work", { shareAcrossSpaces: false, isolatedSpaces: [] })).toBe(false);
    expect(visibleIn(v, "work", { shareAcrossSpaces: true, isolatedSpaces: ["work"] })).toBe(false);
  });

  it("itemsFor reads the setting from settings.json", () => {
    writeItems([item({ id: "v", kind: "state", scope: "vault", space: "life", until: Date.now() + DAY }), item({ id: "w", kind: "note", space: "work" })]);
    expect(itemsFor("school").map((i) => i.id)).toEqual(["v"]);
    setSetting("memory", { shareAcrossSpaces: false });
    expect(itemsFor("school").map((i) => i.id)).toEqual([]);
    setSetting("memory", undefined);
  });
});

describe("storage", () => {
  it("hand edits that break a field keep the rest", () => {
    expect(parseItem({ id: "x", text: "t", space: "work", kind: "bogus", when: "soon" })).toMatchObject({ kind: "note", status: "active" });
    expect(parseItem({ id: "x", space: "work" })).toBeNull();
  });

  it("sweepNow writes only when something changed", () => {
    writeItems([item({ id: "s", kind: "state", until: Date.now() - 1000 })]);
    expect(sweepNow().expired).toEqual(["s"]);
    expect(readItems()[0]!.status).toBe("expired");
    expect(sweepNow().expired).toEqual([]);
  });

  it("settings fall back field by field", () => {
    expect(parseMemorySettings({ capture: "yes", archiveDays: 30, eventGraceDays: -1 })).toMatchObject({ capture: true, archiveDays: 30, eventGraceDays: 3 });
  });
});
