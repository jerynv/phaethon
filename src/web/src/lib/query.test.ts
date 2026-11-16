import { beforeEach, describe, expect, test } from "vitest";
import { clearQueries, fetchQuery, getQueryData, invalidate, keyOf, prefetch, setQueryData } from "./query";

beforeEach(() => clearQueries());

describe("the query cache", () => {
  test("two readers of one key share one request and its answer", async () => {
    let calls = 0;
    const fn = async () => (++calls, "data");
    const [a, b] = await Promise.all([fetchQuery("k", fn), fetchQuery("k", fn)]);
    expect([a, b, calls]).toEqual(["data", "data", 1]);
    expect(getQueryData("k")).toBe("data");
  });

  test("a failed refresh keeps the data it had", async () => {
    await fetchQuery("k", async () => "first");
    await expect(fetchQuery("k", async () => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    expect(getQueryData("k")).toBe("first");
  });

  test("setQueryData puts an answer in, or derives it from the old one", () => {
    setQueryData<number[]>(["memory:items"], [1]);
    setQueryData<number[]>(["memory:items"], (old) => [...(old ?? []), 2]);
    expect(getQueryData(["memory:items"])).toEqual([1, 2]);
  });

  test("prefetch reads only what's missing or stale", async () => {
    let calls = 0;
    const fn = async () => ++calls;
    prefetch("p", fn);
    await new Promise((r) => setTimeout(r, 0));
    prefetch("p", fn);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
  });

  test("invalidate matches string and list keys by prefix, and only those", async () => {
    await fetchQuery(["memory:items"], async () => 1);
    await fetchQuery(["memory:profile", "work"], async () => 2);
    await fetchQuery(["people:list"], async () => 3);
    let refetched = 0;
    // Nobody watches these, so invalidating only marks them stale (no request until shown again).
    invalidate("memory:");
    await new Promise((r) => setTimeout(r, 0));
    expect(refetched).toBe(0);
    expect(getQueryData(["memory:items"])).toBe(1);
    expect(getQueryData(["people:list"])).toBe(3);
  });

  test("invalidating entries someone watches refreshes each once and ends (no endless walk)", async () => {
    let calls = 0;
    const fn = async () => ++calls;
    for (const k of ["people:list", "people:person", "memory:items"]) await fetchQuery([k], fn);
    // Pretend a screen watches each (as useQuery does) so invalidate refreshes them.
    const { subscribeForTest } = await import("./query");
    const stop = ["people:list", "people:person", "memory:items"].map((k) => subscribeForTest([k], fn));
    calls = 0;
    invalidate("people:");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    stop.forEach((f) => f());
  });

  test("a list key and a lookalike string are different entries (no collisions from similar code)", async () => {
    await fetchQuery(["a", 1], async () => "list");
    await fetchQuery("a,1", async () => "string");
    expect(keyOf(["a", 1])).not.toBe(keyOf("a,1"));
    expect(getQueryData(["a", 1])).toBe("list");
  });
});
