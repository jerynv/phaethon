import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canSymlinkFiles, symlink } from "../../../tests/fs.ts";
import { call, tempHome } from "../../../tests/harness.ts";
import { prettyJson } from "../core/fsx.ts";
import { recordBlock, userMessage, type Block, type Message } from "../core/thread.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { reference } from "../attachments/attachments.ts";
import { setWritesAllowed, writePermissions, writesAllowed } from "../grants/writes.ts";
import { forgetIndexes, indexStats, INDEX_NAME } from "./listing.ts";
import { cursorOf, pageOf, parseCursor } from "./page.ts";
import { deleteThreadIn, listThreadsIn, saveIn, threadSummaryIn, UNREADABLE_TITLE, updateMetaIn, type ThreadSummary } from "./store.ts";
import "./commands.ts";
import "../spaces/commands.ts";

const env = tempHome();
beforeAll(() => ensureVault());
afterAll(() => env.cleanup());
afterEach(() => vi.restoreAllMocks());

let n = 0;
function tempSpace(): string {
  const d = path.join(env.home, `listing-${n++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const threadsOf = (d: string) => path.join(d, ".phaethon", "threads");
const indexOf = (d: string) => path.join(threadsOf(d), INDEX_NAME);
const fileOf = (d: string, id: string) => path.join(threadsOf(d), `${id}.json`);
const text = (t: string): Block => ({ type: "text", text: t });
const chat = (q: string, a: string): Message[] => [userMessage(q), { role: "assistant", content: [text(a)] }];
const setTime = (d: string, id: string, ms: number) => fs.utimesSync(fileOf(d, id), new Date(ms), new Date(ms));

/** What one listing read: conversation files and meta files the index didn't hold. */
function reads<T>(f: () => T): { result: T; content: number; meta: number; indexReads: number; indexWrites: number } {
  const before = { ...indexStats };
  const result = f();
  return {
    result,
    content: indexStats.contentReads - before.contentReads,
    meta: indexStats.metaReads - before.metaReads,
    indexReads: indexStats.indexReads - before.indexReads,
    indexWrites: indexStats.indexWrites - before.indexWrites,
  };
}

/** A listing that starts from nothing: no index on disk and nothing remembered. */
function coldList(d: string): ThreadSummary[] {
  fs.rmSync(indexOf(d), { force: true });
  forgetIndexes();
  return listThreadsIn(d);
}

describe("the conversation index", () => {
  it("is written beside the conversations, never named like one, and spares unchanged ones on the next listing", () => {
    const d = tempSpace();
    saveIn(d, "100", chat("first question", "a"));
    saveIn(d, "200", chat("second question", "b"));
    const first = reads(() => listThreadsIn(d));
    expect(first.content).toBe(2);
    expect(first.indexWrites).toBe(1);
    expect(fs.lstatSync(indexOf(d)).isFile()).toBe(true);
    expect(INDEX_NAME.endsWith(".json")).toBe(false);
    const again = reads(() => listThreadsIn(d));
    expect(again).toMatchObject({ content: 0, meta: 0, indexWrites: 0 });
    expect(again.result).toEqual(first.result);
    // Another process (or a restart) reads the file instead of the memo, and still reads no conversation.
    forgetIndexes();
    const restarted = reads(() => listThreadsIn(d));
    expect(restarted).toMatchObject({ content: 0, indexReads: 1, indexWrites: 0 });
    expect(restarted.result).toEqual(first.result);
  });

  it("keeps summaries exactly as a full read gives them", () => {
    const d = tempSpace();
    saveIn(d, "1", chat("  What   is\n due  this week? ", "Two things."));
    saveIn(d, "2", [userMessage("", [reference("attachments/x/notes.md", "text/markdown", "notes.md")])]);
    saveIn(d, "3", [{ role: "assistant", content: [recordBlock({ kind: "imported", from: "claude", session: "s", title: "  An imported chat " })] }, ...chat("hello", "hi")]);
    saveIn(d, "4", []);
    saveIn(d, "5", chat("x".repeat(300), "long"));
    fs.writeFileSync(fileOf(d, "6"), "{ damaged");
    saveIn(d, "7", chat("renamed and pinned", "ok"));
    updateMetaIn(d, "7", { title: "  My  title ", pinned: 1234 });
    for (const [i, id] of ["1", "2", "3", "4", "5", "6", "7"].entries()) setTime(d, id, 1_700_000_000_000 + i * 1000);

    const warmFirst = listThreadsIn(d);
    const warm = listThreadsIn(d);
    const cold = coldList(d);
    expect(warm).toEqual(cold);
    expect(warmFirst).toEqual(cold);
    const byId = Object.fromEntries(cold.map((t) => [t.id, t]));
    expect(byId["1"]).toMatchObject({ title: "What is due this week?", messages: 2, updated: 1_700_000_000_000 });
    expect(byId["2"]).toMatchObject({ title: "notes.md", messages: 1 });
    expect(byId["3"]).toMatchObject({ title: "An imported chat", messages: 2 });
    expect(byId["4"]).toMatchObject({ title: "New conversation", messages: 0 });
    expect(byId["5"]!.title.length).toBeLessThan(300);
    expect(byId["6"]).toMatchObject({ title: UNREADABLE_TITLE, messages: 0 });
    expect(byId["7"]).toEqual({ id: "7", title: "My title", renamed: true, pinned: 1234, messages: 2, updated: 1_700_000_006_000 });
    expect(cold.map((t) => t.id)).toEqual(["7", "6", "5", "4", "3", "2", "1"]);
  });

  it("follows renames, pins and deletes through the commands, reading only what changed", async () => {
    const space = "school";
    const d = spaceDir(space);
    saveIn(d, "5000", chat("pin me", "ok"));
    saveIn(d, "5001", chat("leave me", "ok"));
    await call("threads_list", { space });
    const renamed = reads(() => call("thread_rename", { space, thread: "5000", title: "Pinned one" }));
    await renamed.result;
    await call("thread_pin", { space, thread: "5000", pinned: true });
    const after = reads(() => listThreadsIn(d));
    expect(after).toMatchObject({ content: 0, meta: 1 });
    expect(after.result.find((t) => t.id === "5000")).toMatchObject({ title: "Pinned one", renamed: true, pinned: expect.any(Number) });

    await call("thread_rename", { space, thread: "5000", title: "" });
    await call("thread_pin", { space, thread: "5000", pinned: false });
    const cleared = listThreadsIn(d).find((t) => t.id === "5000")!;
    expect(cleared.title).toBe("pin me");
    expect(cleared.renamed).toBeUndefined();
    expect(cleared.pinned).toBeUndefined();

    await call("thread_delete", { space, thread: "5001" });
    const gone = reads(() => listThreadsIn(d));
    expect(gone.result.map((t) => t.id)).not.toContain("5001");
    expect(gone.content).toBe(0);
    const index = JSON.parse(fs.readFileSync(indexOf(d), "utf8")) as { threads: { id: string }[] };
    expect(index.threads.map((t) => t.id)).not.toContain("5001");
    deleteThreadIn(d, "5000");
  });

  it("notices edits made by another process, even ones that keep the size and the time", () => {
    const d = tempSpace();
    saveIn(d, "10", chat("before", "a"));
    saveIn(d, "11", chat("other", "b"));
    setTime(d, "10", 1_700_000_000_000);
    listThreadsIn(d);
    const file = fileOf(d, "10");
    const same = prettyJson(chat("BEFORE", "a"));
    expect(same.length).toBe(fs.readFileSync(file, "utf8").length);
    // Rewritten in place by another program, then its time put back the way a sync tool might.
    execFileSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], process.argv[2]); require('fs').utimesSync(process.argv[1], 1700000000, 1700000000)", file, same]);
    const seen = reads(() => listThreadsIn(d));
    expect(seen.content).toBe(1);
    expect(seen.result.find((t) => t.id === "10")).toMatchObject({ title: "BEFORE", updated: 1_700_000_000_000 });

    // Added and removed behind its back.
    execFileSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], process.argv[2]); require('fs').rmSync(process.argv[3])", fileOf(d, "12"), prettyJson(chat("added elsewhere", "c")), fileOf(d, "11")]);
    const changed = reads(() => listThreadsIn(d));
    expect(changed.content).toBe(1);
    expect(changed.result.map((t) => t.id).sort()).toEqual(["10", "12"]);
    expect(changed.result.find((t) => t.id === "12")!.title).toBe("added elsewhere");

    // A meta file edited by hand.
    fs.writeFileSync(path.join(threadsOf(d), "12.meta"), JSON.stringify({ title: "Hand edited", pinned: 77 }));
    expect(listThreadsIn(d).find((t) => t.id === "12")).toMatchObject({ title: "Hand edited", pinned: 77, renamed: true });
    fs.rmSync(path.join(threadsOf(d), "12.meta"));
    expect(listThreadsIn(d).find((t) => t.id === "12")).toMatchObject({ title: "added elsewhere" });
  });

  it("rebuilds silently from a damaged, foreign or missing index", () => {
    const d = tempSpace();
    saveIn(d, "20", chat("one", "a"));
    saveIn(d, "21", chat("two", "b"));
    const good = listThreadsIn(d);
    for (const junk of ["{ not json", "null", "[]", JSON.stringify({ v: 99, threads: [] }), JSON.stringify({ v: 1, threads: "x" }), ""]) {
      fs.writeFileSync(indexOf(d), junk);
      forgetIndexes();
      const r = reads(() => listThreadsIn(d));
      expect(r.result).toEqual(good);
      expect(r.content).toBe(2);
      expect(r.indexWrites).toBe(1);
      expect(JSON.parse(fs.readFileSync(indexOf(d), "utf8")).v).toBe(1);
    }
    // One bad entry is read again; the rest are trusted to their stamps.
    const idx = JSON.parse(fs.readFileSync(indexOf(d), "utf8")) as { threads: Record<string, unknown>[] };
    idx.threads[0]!.title = 42;
    fs.writeFileSync(indexOf(d), JSON.stringify(idx));
    forgetIndexes();
    const partial = reads(() => listThreadsIn(d));
    expect(partial.result).toEqual(good);
    expect(partial.content).toBe(1);
    // A missing one.
    fs.rmSync(indexOf(d));
    forgetIndexes();
    expect(listThreadsIn(d)).toEqual(good);
    expect(fs.existsSync(indexOf(d))).toBe(true);
  });

  it("a stale entry with the wrong stamp is never used", () => {
    const d = tempSpace();
    saveIn(d, "30", chat("real title", "a"));
    listThreadsIn(d);
    const idx = JSON.parse(fs.readFileSync(indexOf(d), "utf8")) as { threads: Record<string, unknown>[] };
    idx.threads[0]!.title = "Forged";
    (idx.threads[0] as { size: number }).size += 1;
    fs.writeFileSync(indexOf(d), JSON.stringify(idx));
    forgetIndexes();
    expect(listThreadsIn(d)[0]!.title).toBe("real title");
  });

  it("decides nothing about permissions: a forged writes entry isn't granted or shown", () => {
    ensureVault();
    const space = "school";
    const d = spaceDir(space);
    saveIn(d, "6000", chat("no writes here", "ok"));
    updateMetaIn(d, "6000", { title: "Has meta" });
    listThreadsIn(d);
    const idx = JSON.parse(fs.readFileSync(indexOf(d), "utf8")) as { threads: { id: string; meta?: Record<string, unknown> }[] };
    idx.threads.find((t) => t.id === "6000")!.meta!.allowWrites = 123;
    fs.writeFileSync(indexOf(d), JSON.stringify(idx));
    forgetIndexes();
    expect(writesAllowed(space, "6000")).toBe(null);
    expect(writePermissions(space).conversations.map((c) => c.thread)).not.toContain("6000");
    // A real grant still shows.
    setWritesAllowed(space, "6000", "conversation", true);
    expect(writePermissions(space).conversations.map((c) => c.thread)).toContain("6000");
    setWritesAllowed(space, "6000", "conversation", false);
    deleteThreadIn(d, "6000");
  });

  it.skipIf(!canSymlinkFiles)("refuses a linked index: never read through, never written through", () => {
    const d = tempSpace();
    saveIn(d, "40", chat("genuine", "a"));
    listThreadsIn(d);
    const forged = fs.readFileSync(indexOf(d), "utf8").replace("genuine", "planted");
    const outside = path.join(env.home, `outside-index-${n}`);
    fs.writeFileSync(outside, forged);
    fs.rmSync(indexOf(d));
    symlink(outside, indexOf(d), "file");
    forgetIndexes();
    const r = reads(() => listThreadsIn(d));
    expect(r.result[0]!.title).toBe("genuine");
    expect(r.content).toBe(1);
    expect(fs.readFileSync(outside, "utf8")).toBe(forged);
    expect(fs.lstatSync(indexOf(d)).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(indexOf(d)).isFile()).toBe(true);
  });

  it.skipIf(!canSymlinkFiles)("never lists a linked conversation or meta file through the index", () => {
    const d = tempSpace();
    saveIn(d, "50", chat("mine", "a"));
    const elsewhere = path.join(env.home, `elsewhere-${n}.json`);
    fs.writeFileSync(elsewhere, prettyJson(chat("someone else's", "b")));
    symlink(elsewhere, fileOf(d, "51"), "file");
    expect(listThreadsIn(d).map((t) => t.id)).toEqual(["50"]);
  });

  it("refuses to list (or write an index) when the threads folder is a link", () => {
    const d = tempSpace();
    const other = tempSpace();
    saveIn(other, "60", chat("other space", "a"));
    fs.mkdirSync(path.join(d, ".phaethon"), { recursive: true });
    symlink(threadsOf(other), threadsOf(d), "dir");
    expect(() => listThreadsIn(d)).toThrow("not a folder");
    expect(fs.existsSync(indexOf(other))).toBe(false);
  });

  it("a space with no conversations gets no folder and no index", () => {
    const d = tempSpace();
    expect(listThreadsIn(d)).toEqual([]);
    expect(fs.existsSync(path.join(d, ".phaethon"))).toBe(false);
  });

  it("one conversation's summary comes from its own files", () => {
    const d = tempSpace();
    saveIn(d, "70", chat("a single row", "a"));
    updateMetaIn(d, "70", { pinned: 5 });
    expect(threadSummaryIn(d, "70")).toEqual(listThreadsIn(d)[0]);
    expect(threadSummaryIn(d, "71")).toBeNull();
    expect(() => threadSummaryIn(d, "../x")).toThrow("not a conversation id");
  });
});

// ---- Paging ----------------------------------------------------------------------

type T = { id: string; title: string; updated: number; pinned?: number };
const sorted = (l: T[]) => [...l].sort((a, b) => b.updated - a.updated || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

describe("pages", () => {
  const list = sorted([
    ...Array.from({ length: 23 }, (_, i) => ({ id: String(100 + i), title: `Chat ${i}`, updated: 1000 + Math.floor(i / 3) })),
    { id: "900", title: "Pinned late", updated: 5, pinned: 20 },
    { id: "901", title: "Pinned early", updated: 9999, pinned: 10 },
  ]);

  it("put every pinned conversation first on the first page only, then walk the rest without gaps or repeats", () => {
    const first = pageOf(list, { limit: 5, before: null, query: "" });
    expect(first.items.slice(0, 2).map((t) => t.id)).toEqual(["901", "900"]);
    expect(first.items).toHaveLength(7);
    expect(first.total).toBe(25);
    expect(first.hasMore).toBe(true);
    const seen = first.items.slice(2).map((t) => t.id);
    let cursor = first.nextCursor;
    let pages = 1;
    while (cursor) {
      const page = pageOf(list, { limit: 5, before: parseCursor(cursor), query: "" });
      expect(page.items.some((t) => t.pinned)).toBe(false);
      seen.push(...page.items.map((t) => t.id));
      cursor = page.nextCursor;
      expect(page.hasMore).toBe(cursor !== null);
      pages++;
    }
    expect(pages).toBe(5);
    expect(seen).toEqual(list.filter((t) => !t.pinned).map((t) => t.id));
  });

  it("break ties in time by id, so a cursor inside a tie still continues exactly", () => {
    const first = pageOf(list, { limit: 4, before: null, query: "" });
    const last = first.items[first.items.length - 1]!;
    expect(first.nextCursor).toBe(cursorOf(last));
    const next = pageOf(list, { limit: 4, before: parseCursor(first.nextCursor), query: "" });
    expect(next.items[0]!.updated).toBe(last.updated);
    expect(next.items[0]!.id < last.id).toBe(true);
  });

  it("filter by title words, ignoring case and spacing, and count only what matches", () => {
    const page = pageOf(list, { limit: 50, before: null, query: "pinned" });
    expect(page.items.map((t) => t.id)).toEqual(["901", "900"]);
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(pageOf(list, { limit: 50, before: null, query: "chat 2" }).items.map((t) => t.title).sort()).toEqual(["Chat 2", "Chat 20", "Chat 21", "Chat 22"]);
  });

  it("refuse cursors that aren't ones", () => {
    for (const bad of ["", "x", "12", "12:../x", ":5", "1:2:3", 5, null, "99999999999999999:1"]) expect(parseCursor(bad)).toBeNull();
    expect(parseCursor("17:100-2")).toEqual({ updated: 17, id: "100-2" });
  });
});

describe("threads_list paging through the command", () => {
  it("keeps the plain array without paging arguments, and pages with them", async () => {
    ensureVault();
    const space = "paging";
    await call("space_create", { name: "Paging" });
    const d = spaceDir(space);
    for (let i = 0; i < 12; i++) {
      saveIn(d, String(7000 + i), chat(`question ${i}`, "a"));
      setTime(d, String(7000 + i), 1_700_000_000_000 + i * 1000);
    }
    updateMetaIn(d, "7000", { pinned: 1 });
    const plain = await call<ThreadSummary[]>("threads_list", { space });
    expect(Array.isArray(plain)).toBe(true);
    expect(plain).toHaveLength(12);

    type P = { items: ThreadSummary[]; total: number; hasMore: boolean; nextCursor: string | null };
    const first = await call<P>("threads_list", { space, limit: 5 });
    expect(first.total).toBe(12);
    expect(first.items.map((t) => t.id)).toEqual(["7000", "7011", "7010", "7009", "7008", "7007"]);
    expect(first.hasMore).toBe(true);
    const second = await call<P>("threads_list", { space, limit: 5, before: first.nextCursor });
    expect(second.items.map((t) => t.id)).toEqual(["7006", "7005", "7004", "7003", "7002"]);
    const third = await call<P>("threads_list", { space, limit: 5, before: second.nextCursor });
    expect(third.items.map((t) => t.id)).toEqual(["7001"]);
    expect(third).toMatchObject({ hasMore: false, nextCursor: null });
    const found = await call<P>("threads_list", { space, query: "QUESTION 1" });
    expect(found.items.map((t) => t.id).sort()).toEqual(["7001", "7010", "7011"]);

    await expect(call("threads_list", { space, before: "nope" })).rejects.toThrow("That place in the list isn’t one Phaethon knows.");
    await expect(call("threads_list", { space, limit: 0 })).rejects.toThrow("A page size has to be a whole number above zero.");
    await expect(call("threads_list", { space, query: 5 })).rejects.toThrow("A search has to be text.");

    expect(await call("threads_count", { space })).toEqual({ total: 12, pinned: 1 });
    expect(await call("thread_summary", { space, thread: "7003" })).toMatchObject({ id: "7003", title: "question 3", messages: 2 });
    expect(await call("thread_summary", { space, thread: "123" })).toBeNull();
  });
});

// ---- Scale -----------------------------------------------------------------------

describe("at scale", () => {
  it("lists 1500 conversations from the index fast, and re-reads only the one that changed", () => {
    const d = tempSpace();
    const dir = threadsOf(d);
    fs.mkdirSync(dir, { recursive: true });
    const COUNT = 1500;
    for (let i = 0; i < COUNT; i++) {
      const msgs: Message[] = [];
      for (let k = 0; k < 10; k++) msgs.push({ ...userMessage(`question ${i}.${k} `.repeat(20)), at: 1 }, { role: "assistant", content: [text(`answer ${k} `.repeat(80))], at: 2 });
      const id = String(1_600_000_000_000 + i);
      fs.writeFileSync(fileOf(d, id), prettyJson(msgs));
      setTime(d, id, 1_700_000_000_000 + i * 1000);
      if (i % 50 === 0) fs.writeFileSync(path.join(dir, `${id}.meta`), JSON.stringify({ pinned: 1000 + i }));
    }
    const page = () => pageOf(listThreadsIn(d), { limit: 50, before: null, query: "" });
    const time = (f: () => unknown) => {
      const a = performance.now();
      f();
      return performance.now() - a;
    };
    forgetIndexes();
    const cold = time(page);
    const warm: number[] = [];
    for (let r = 0; r < 5; r++) warm.push(time(page));
    forgetIndexes();
    const restart = time(page);
    const best = Math.min(...warm);
    const median = [...warm].sort((a, b) => a - b)[2]!;
    console.log(`1500 conversations: cold ${cold.toFixed(1)} ms, warm median ${median.toFixed(1)} ms (best ${best.toFixed(1)}), after restart ${restart.toFixed(1)} ms`);
    expect(median).toBeLessThan(100);

    const p = page();
    expect(p.total).toBe(COUNT);
    expect(p.items).toHaveLength(30 + 50);
    expect(p.items.slice(0, 30).every((t) => t.pinned)).toBe(true);

    // One conversation changes: only it is read again (counted by the index and by every file read).
    const changed = String(1_600_000_000_000 + 7);
    saveIn(d, changed, chat("changed just now", "a"));
    const spy = vi.spyOn(fs, "readFileSync");
    const r = reads(() => listThreadsIn(d));
    const conversationReads = spy.mock.calls.filter(([f]) => typeof f === "string" && f.endsWith(".json")).length;
    spy.mockRestore();
    expect(r.content).toBe(1);
    expect(r.meta).toBe(0);
    expect(conversationReads).toBe(1);
    expect(r.result[0]).toMatchObject({ id: changed, title: "changed just now" });
    const refreshed = time(() => listThreadsIn(d));
    console.log(`after one change: ${refreshed.toFixed(1)} ms for the next listing`);
  });
});
