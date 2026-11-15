import { describe, expect, it } from "vitest";
import type { ThreadRow } from "../store";
import { mergeRefresh, nextResults, type FilterList } from "./paging";

const row = (n: number, extra: Partial<ThreadRow> = {}): ThreadRow => ({ id: String(1000 + n), title: `Chat ${n}`, updated: 10_000 - n * 10, messages: 2, ...extra });
const rows = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => row(from + i));
const cursorOf = (t: ThreadRow) => `${t.updated}:${t.id}`;
const ids = (list: ThreadRow[] | undefined) => (list ?? []).map((t) => Number(t.id) - 1000);

describe("mergeRefresh", () => {
  it("keeps the loaded rows past a shorter refresh, and pages on from where the list had got to", () => {
    // 900 loaded (pages of 50 as far as row 899), a refresh reloads the newest 500.
    const loaded = rows(0, 900);
    const cur = { loading: false, data: loaded, hasMore: true, cursor: cursorOf(loaded[899]!) };
    const page = { items: rows(0, 500), hasMore: true, nextCursor: cursorOf(loaded[499]!) };
    const out = mergeRefresh(cur, page);
    expect(ids(out.data)).toEqual(ids(loaded));
    expect(out.cursor).toBe(cur.cursor);
    expect(out.hasMore).toBe(true);
  });

  it("takes the refresh's rows and cursor when it reloads everything that was loaded", () => {
    const loaded = rows(0, 100);
    const cur = { loading: false, data: loaded, hasMore: true, cursor: cursorOf(loaded[99]!) };
    const fresh = [row(-1), ...rows(0, 100)];
    const out = mergeRefresh(cur, { items: fresh, hasMore: true, nextCursor: cursorOf(fresh[100]!) });
    expect(ids(out.data)).toEqual(ids(fresh));
    expect(out.cursor).toBe(cursorOf(fresh[100]!));
  });

  it("keeps a fully loaded list whole, with nothing more to load", () => {
    const loaded = rows(0, 700);
    const cur = { loading: false, data: loaded, hasMore: false, cursor: null };
    const out = mergeRefresh(cur, { items: rows(0, 500), hasMore: true, nextCursor: cursorOf(loaded[499]!) });
    expect(out.data).toHaveLength(700);
    expect(out.hasMore).toBe(false);
    expect(out.cursor).toBeNull();
  });

  it("keeps rows the UI added and drops ones the refresh no longer lists within its range", () => {
    const loaded = [row(-5, { optimistic: true }), ...rows(0, 10)];
    const cur = { loading: false, data: loaded, hasMore: false, cursor: null };
    const fresh = rows(0, 10).filter((t) => t.id !== "1003");
    const out = mergeRefresh(cur, { items: fresh, hasMore: false, nextCursor: null });
    expect(ids(out.data)).toEqual([-5, 0, 1, 2, 4, 5, 6, 7, 8, 9]);
  });
});

describe("nextResults", () => {
  const done = (items: ThreadRow[], more = false): FilterList => ({ items, total: items.length + (more ? 100 : 0), hasMore: more, cursor: more ? "1:1" : null, loading: false, loadingMore: false });

  it("answers a narrowing query from a complete answer at once", () => {
    const prev = { a: done([row(1), row(12), row(123)]) };
    const out = nextResults(prev, ["a"], "chat 1", "chat 12");
    expect(out.a!.loading).toBe(false);
    expect(ids(out.a!.items)).toEqual([12, 123]);
    expect(out.a!.total).toBe(2);
  });

  it("asks again when the last answer was partial, or the query widens or changes", () => {
    const prev = { a: done([row(1)], true), b: done([row(12)]) };
    const narrowed = nextResults(prev, ["a", "b"], "chat 1", "chat 12");
    expect(narrowed.a!.loading).toBe(true);
    // The last answer stays for the list to re-filter while the core answers.
    expect(ids(narrowed.a!.items)).toEqual([1]);
    expect(nextResults(prev, ["b"], "chat 12", "chat 1").b!.loading).toBe(true);
    expect(nextResults(prev, ["b"], "chat 12", "notes").b!.loading).toBe(true);
    expect(nextResults({}, ["c"], "", "chat").c).toMatchObject({ items: [], loading: true });
  });
});
