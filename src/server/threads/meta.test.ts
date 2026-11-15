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
  it("renames and pins a conversation, and clears both", async () => {
    saveIn(dir(), "1000", [userMessage("What is due this week?")]);
    await rename("1000", "  Week 6\n  deadlines ");
    await pin("1000", true);
    const [cur] = await list();
    expect(cur).toMatchObject({ id: "1000", title: "Week 6 deadlines", renamed: true });
    expect(cur!.pinned).toBeGreaterThan(0);
    expect(fs.existsSync(state("threads", "1000.meta"))).toBe(true);

    await rename("1000", "");
    await pin("1000", false);
    const [after] = await list();
    expect(after).toMatchObject({ title: "What is due this week?" });
    expect(after!.renamed).toBeUndefined();
    expect(after!.pinned).toBeUndefined();
    // Nothing set leaves no file behind.
    expect(fs.existsSync(state("threads", "1000.meta"))).toBe(false);
  });

  it("stays beside its own conversation and goes with it", async () => {
    saveIn(dir(), "2000", [userMessage("Second")]);
    await rename("1000", "Deadlines");
    await call("thread_rename", { space: "school", thread: "2000", title: "By the new name" });
    const all = await list();
    expect(all.map((t) => [t.id, t.title])).toEqual(
      expect.arrayContaining([
        ["1000", "Deadlines"],
        ["2000", "By the new name"],
      ]),
    );
    // The sidecar is never listed as a conversation.
    expect(listThreadsIn(dir())).toHaveLength(2);
    await call("thread_delete", { space: "school", id: "2000" });
    expect(fs.existsSync(state("threads", "2000.meta"))).toBe(false);
    expect(fs.existsSync(state("threads", "1000.meta"))).toBe(true);
    await call("thread_delete", { space: "school", thread: "1000" });
    expect(fs.existsSync(state("threads", "1000.meta"))).toBe(false);
  });

  it("refuses ids that aren't conversations and ignores a damaged file", async () => {
    await expect(rename("../x", "a")).rejects.toThrow(/isn’t a conversation/);
    await expect(rename("current", "a")).rejects.toThrow(/isn’t a conversation/);
    await expect(pin("123", true)).rejects.toThrow(/couldn’t be pinned/);
    saveIn(dir(), "3000", [userMessage("x")]);
    await expect(rename("3000", 5)).rejects.toThrow(/has to be text/);
    fs.writeFileSync(state("threads", "3000.meta"), "{nope");
    expect((await list())[0]).toMatchObject({ title: "x" });
    await rename("3000", "Fixed");
    expect((await list())[0]).toMatchObject({ title: "Fixed" });
    await call("thread_delete", { space: "school", id: "3000" });
  });

  it("never writes through a link left at the sidecar's name", async () => {
    saveIn(dir(), "4000", [userMessage("y")]);
    const target = path.join(env.home, "elsewhere.txt");
    fs.writeFileSync(target, "untouched");
    try {
      fs.symlinkSync(target, state("threads", "4000.meta"));
    } catch {
      return; // no symlinks here
    }
    await rename("4000", "Linked");
    expect(fs.readFileSync(target, "utf8")).toBe("untouched");
    expect(fs.lstatSync(state("threads", "4000.meta")).isSymbolicLink()).toBe(false);
    await call("thread_delete", { space: "school", id: "4000" });
  });

  it("keeps titles to one line of at most 120 characters", () => {
    expect(cleanTitle("a\n\tb   c")).toBe("a b c");
    expect([...cleanTitle("é".repeat(200))]).toHaveLength(120);
  });
});
