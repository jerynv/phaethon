import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, tempHome } from "../../../tests/harness.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { userMessage } from "../core/thread.ts";
import { cleanTitle, listThreadsIn, saveIn, type ThreadSummary } from "./store.ts";
import "./commands.ts";

const env = tempHome();
beforeAll(() => ensureVault());
afterAll(() => env.cleanup());

const dir = () => spaceDir("school");
const state = (...p: string[]) => path.join(dir(), ".phaethon", ...p);
const list = () => call<ThreadSummary[]>("threads_list", { space: "school" });
const rename = (id: string, title: unknown) => call("thread_rename", { space: "school", id, title });
const pin = (id: string, pinned: boolean) => call("thread_pin", { space: "school", id, pinned });

describe("a conversation's title and pin", () => {
  it("renames and pins the current conversation, and clears both", async () => {
    saveIn(dir(), [userMessage("What is due this week?")]);
    await rename("current", "  Week 6\n  deadlines ");
    await pin("current", true);
    const [cur] = await list();
    expect(cur).toMatchObject({ id: "current", title: "Week 6 deadlines", renamed: true });
    expect(cur!.pinned).toBeGreaterThan(0);

    await rename("current", "");
    await pin("current", false);
    const [after] = await list();
    expect(after).toMatchObject({ title: "What is due this week?" });
    expect(after!.renamed).toBeUndefined();
    expect(after!.pinned).toBeUndefined();
    // Nothing set leaves no file behind.
    expect(fs.existsSync(state("meta"))).toBe(false);
  });

  it("travels with its conversation through new, open and delete", async () => {
    await rename("current", "Deadlines");
    await pin("current", true);
    await call("thread_new", { space: "school" });
    const archived = listThreadsIn(dir()).find((t) => !t.current)!;
    expect(archived).toMatchObject({ title: "Deadlines", renamed: true });
    expect(fs.existsSync(state("threads", `${archived.id}.meta`))).toBe(true);
    expect(fs.existsSync(state("meta"))).toBe(false);
    // The sidecar is never listed as a conversation.
    expect(listThreadsIn(dir())).toHaveLength(2);

    saveIn(dir(), [userMessage("Second")]);
    await call("thread_open", { space: "school", id: archived.id });
    expect((await list())[0]).toMatchObject({ id: "current", title: "Deadlines" });
    const second = (await list()).find((t) => !t.current)!;
    expect(second).toMatchObject({ title: "Second" });
    expect(second.renamed).toBeUndefined();

    await rename(second.id, "Archived one");
    expect(fs.existsSync(state("threads", `${second.id}.meta`))).toBe(true);
    await call("thread_delete", { space: "school", id: second.id });
    expect(fs.existsSync(state("threads", `${second.id}.meta`))).toBe(false);
    await call("thread_delete", { space: "school", id: "current" });
    expect(fs.existsSync(state("meta"))).toBe(false);
  });

  it("refuses ids that aren't conversations and ignores a damaged file", async () => {
    await expect(rename("../x", "a")).rejects.toThrow(/couldn’t be renamed/);
    await expect(pin("123", true)).rejects.toThrow(/couldn’t be pinned/);
    await expect(rename("current", 5)).rejects.toThrow(/has to be text/);
    saveIn(dir(), [userMessage("x")]);
    fs.writeFileSync(state("meta"), "{nope");
    expect((await list())[0]).toMatchObject({ title: "x" });
    await rename("current", "Fixed");
    expect((await list())[0]).toMatchObject({ title: "Fixed" });
    await call("thread_delete", { space: "school", id: "current" });
  });

  it("keeps titles to one line of at most 120 characters", () => {
    expect(cleanTitle("a\n\tb   c")).toBe("a b c");
    expect([...cleanTitle("é".repeat(200))]).toHaveLength(120);
  });
});
