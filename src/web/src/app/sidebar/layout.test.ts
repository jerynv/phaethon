import { describe, expect, it } from "vitest";
import { cursorPosition, foldTitle, groupThreads, LABEL, LABEL_GAP, layoutSpaces, revealOffset, ROW, SPACE_GAP, STICKY, type SpaceInput } from "./layout";
import type { ThreadRow } from "../store";

// Wednesday 12 November 2025, 15:00 local time.
const NOW = new Date(2025, 10, 12, 15, 0, 0).getTime();
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();
const row = (id: string, updated: number, extra: Partial<ThreadRow> = {}): ThreadRow => ({ id, title: `Chat ${id}`, updated, messages: 2, ...extra });
const shape = (rows: ThreadRow[]) => groupThreads(rows, NOW, "en-US").map((g) => [g.label, g.rows.map((r) => r.id)]);

describe("groupThreads", () => {
  it("groups by recency: today, yesterday, the previous 7 and 30 days, then months", () => {
    const rows = [
      row("a", at(2025, 10, 12, 9)),
      row("b", at(2025, 10, 12, 0) + 1),
      row("c", at(2025, 10, 11, 23)),
      row("d", at(2025, 10, 11, 0)),
      row("e", at(2025, 10, 10)),
      row("f", at(2025, 10, 5, 0)),
      row("g", at(2025, 10, 4, 23)),
      row("h", at(2025, 9, 13, 0)),
      row("i", at(2025, 9, 12, 23)),
      row("j", at(2025, 9, 1)),
      row("k", at(2025, 8, 30)),
      row("l", at(2025, 0, 2)),
      row("m", at(2024, 11, 31)),
      row("n", at(2023, 5, 15)),
    ];
    expect(shape(rows)).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c", "d"]],
      ["Previous 7 days", ["e", "f"]],
      ["Previous 30 days", ["g", "h"]],
      ["October", ["i", "j"]],
      ["September", ["k"]],
      ["January", ["l"]],
      ["December 2024", ["m"]],
      ["June 2023", ["n"]],
    ]);
  });

  it("puts pinned ones first in the order they were pinned, whatever their age", () => {
    const rows = [row("old", at(2024, 1, 1), { pinned: 300 }), row("new", at(2025, 10, 12, 10)), row("first", at(2025, 10, 1), { pinned: 100 })];
    expect(shape(rows)).toEqual([
      ["Pinned", ["first", "old"]],
      ["Today", ["new"]],
    ]);
  });

  it("sorts newest first whatever order they come in, ties by id as the core does", () => {
    const t = at(2025, 10, 12, 8);
    expect(shape([row("1", t - 5), row("3", t), row("2", t)])).toEqual([["Today", ["3", "2", "1"]]]);
  });

  it("counts a time ahead of this computer's clock as today, and leaves out empty groups", () => {
    expect(shape([row("future", NOW + 3_600_000 * 30), row("older", at(2025, 6, 4))])).toEqual([
      ["Today", ["future"]],
      ["July", ["older"]],
    ]);
  });

  it("splits days at local midnight across a daylight-saving change", () => {
    // 2 November 2025 is a DST change in many zones; the 7-day bound is still midnight.
    const bound = new Date(2025, 10, 5).getTime();
    expect(shape([row("in", bound), row("out", bound - 1)]).map(([l]) => l)).toEqual(["Previous 7 days", "Previous 30 days"]);
  });

  it("groups 1500 conversations quickly", () => {
    const rows = Array.from({ length: 1500 }, (_, i) => row(String(i), NOW - i * 3_600_000 * 7));
    const t = performance.now();
    const groups = groupThreads(rows, NOW, "en-US");
    expect(performance.now() - t).toBeLessThan(50);
    expect(groups.reduce((n, g) => n + g.rows.length, 0)).toBe(1500);
    expect(groups[0]!.label).toBe("Today");
  });
});

describe("layoutSpaces", () => {
  const space = (id: string, rows: ThreadRow[], over: Partial<SpaceInput> = {}): SpaceInput => ({
    id,
    collapsed: false,
    status: "ready",
    rows,
    hasMore: false,
    cursor: null,
    empty: "No conversations yet",
    ...over,
  });

  it("lays out each space's row, its group labels and rows at fixed heights", () => {
    const l = layoutSpaces([space("a", [row("1", at(2025, 10, 12)), row("2", at(2025, 10, 11))]), space("b", [], { collapsed: true })], NOW, "en-US");
    expect(l.items.map((i) => [i.kind, i.start])).toEqual([
      ["space", 0],
      ["label", ROW],
      ["row", ROW + LABEL],
      ["label", 2 * ROW + LABEL],
      ["row", 2 * ROW + 2 * LABEL + LABEL_GAP],
      ["space", 3 * ROW + 2 * LABEL + LABEL_GAP + SPACE_GAP],
    ]);
    expect(l.sections.map((s) => [s.space, s.start, s.end])).toEqual([
      ["a", 0, 3 * ROW + 2 * LABEL + LABEL_GAP],
      ["b", 3 * ROW + 2 * LABEL + LABEL_GAP + SPACE_GAP, 4 * ROW + 2 * LABEL + LABEL_GAP + SPACE_GAP],
    ]);
    expect(l.sections[0]!.blocks.map((b) => [b.label, b.from, b.to])).toEqual([
      ["Today", 1, 3],
      ["Yesterday", 3, 5],
    ]);
    expect(l.size).toBe(l.sections[1]!.end);
  });

  it("puts the loader after the loaded run, before a conversation read on its own from further back", () => {
    const rows = [row("9", at(2025, 10, 12)), row("8", at(2025, 10, 3)), row("2", at(2025, 2, 3))];
    const l = layoutSpaces([space("a", rows, { hasMore: true, cursor: `${at(2025, 10, 3)}:8` })], NOW, "en-US");
    expect(l.items.map((i) => i.kind + (i.thread ? `:${i.thread.id}` : ""))).toEqual(["space", "label", "row:9", "label", "row:8", "loader", "label", "row:2"]);
  });

  it("shows skeletons while loading, an error row, the empty note, and only the row when folded", () => {
    const l = layoutSpaces(
      [space("a", [], { status: "loading" }), space("b", [], { status: "error" }), space("c", []), space("d", [row("1", NOW)], { collapsed: true })],
      NOW,
    );
    expect(l.items.map((i) => i.kind)).toEqual(["space", "skeleton", "skeleton", "skeleton", "space", "error", "space", "note", "space"]);
    expect(l.items.find((i) => i.kind === "note")!.text).toBe("No conversations yet");
  });

  it("indexes conversations by space and id, and keeps a 1500-row space cheap", () => {
    const rows = Array.from({ length: 1500 }, (_, i) => row(String(i), NOW - i * 3_600_000 * 5));
    const t = performance.now();
    const l = layoutSpaces([space("a", rows, { hasMore: true, cursor: `${rows[1499]!.updated}:1499` })], NOW, "en-US");
    expect(performance.now() - t).toBeLessThan(80);
    expect(l.items.filter((i) => i.kind === "row")).toHaveLength(1500);
    expect(l.items[l.items.length - 1]!.kind).toBe("loader");
    expect(l.items[l.index.get("row:a/700")!]!.thread!.id).toBe("700");
  });
});

describe("revealOffset", () => {
  const l = layoutSpaces(
    [{ id: "a", collapsed: false, status: "ready", rows: Array.from({ length: 200 }, (_, i) => row(String(i), NOW - i * 60_000)), hasMore: false, cursor: null, empty: "" }],
    NOW,
  );
  const item = (id: string) => l.items[l.index.get(`row:a/${id}`)!]!;

  it("leaves a row alone when it shows below the sticky rows", () => {
    expect(revealOffset(item("5"), 0, 400)).toBeNull();
  });
  it("scrolls the least to bring a nearby row out from under the sticky rows or up from below", () => {
    const r = item("20");
    expect(revealOffset(r, r.start - 10, 400)).toBe(r.start - STICKY);
    expect(revealOffset(r, r.start - 400 + 10, 400)).toBe(r.start + r.size - 400);
  });
  it("centres a row that is far away", () => {
    const r = item("150");
    expect(revealOffset(r, 0, 400)).toBe(Math.round(r.start - 200 + r.size / 2));
  });
});

describe("helpers", () => {
  it("reads a cursor and folds titles as the core does", () => {
    expect(cursorPosition("1700000000000:1700000000000")).toEqual({ updated: 1700000000000, id: "1700000000000" });
    expect(cursorPosition("-5:abc")).toEqual({ updated: -5, id: "abc" });
    expect(cursorPosition("nope")).toBeNull();
    expect(foldTitle("  Week   6\tNOTES ")).toBe("week 6 notes");
  });
});
