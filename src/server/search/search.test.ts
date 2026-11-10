import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { call, tempHome } from "../../../tests/harness.ts";
import { userMessage, type Message } from "../core/thread.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { isValidThreadId, saveIn, startNewIn } from "../threads/store.ts";
import { MAX_CONVERSATIONS, MAX_QUERY_CHARS, MAX_SNIPPETS, findAll, fold, foldQuery, search, snippet } from "./search.ts";
import "./commands.ts";

const env = tempHome();
afterAll(() => env.cleanup());

let n = 0;
function temp(): string {
  const d = path.join(env.home, `search-${n++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const chat = (pairs: [string, string][]): Message[] =>
  pairs.flatMap(([q, a]) => [userMessage(q), { role: "assistant" as const, content: [{ type: "text", text: a }] }]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function saveArchived(space: string, msgs: Message[]) {
  saveIn(space, msgs);
  startNewIn(space);
  await sleep(15);
}

describe("conversation search", () => {
  it("folding ignores case, accents and spacing", () => {
    const q = foldQuery("resume CAFE");
    const hay = fold("My Résumé  \n café list");
    expect(findAll(hay.chars, foldQuery("résumé")).length).toBe(1);
    expect(findAll(hay.chars, foldQuery("RESUME")).length).toBe(1);
    expect(findAll(fold("Résumé café").chars, q).length).toBe(1);
    expect(findAll(fold("café").chars, foldQuery("café")).length).toBe(1);
    expect(fold("Straße").chars.join("")).toBe("strasse");
    expect(findAll(fold("Ελληνικά ΚΕΙΜΕΝΟ").chars, foldQuery("κειμενο")).length).toBe(1);
    expect(foldQuery("   ")).toEqual([]);
    expect(foldQuery("x".repeat(500)).length).toBe(MAX_QUERY_CHARS);
  });

  it("snippets point at the original text", () => {
    const text = "Before the test, re-read the Résumé notes.\n\nThen rest.";
    const f = fold(text);
    const hits = findAll(f.chars, foldQuery("resume notes"));
    expect(hits.length).toBe(1);
    const [a, b] = hits[0]!;
    const s = snippet(text, f.spans[a]![0], f.spans[b - 1]![1], 4, "assistant");
    expect(s).toEqual({ message: 4, role: "assistant", before: "Before the test, re-read the ", matched: "Résumé notes", after: ". Then rest." });
    const long = `${"a ".repeat(100)} needle ${"b ".repeat(100)}`;
    const lf = fold(long);
    const [la, lb] = findAll(lf.chars, foldQuery("needle"))[0]!;
    const ls = snippet(long, lf.spans[la]![0], lf.spans[lb - 1]![1], 0, "user");
    expect(ls.before.startsWith("…") && ls.after.endsWith("…")).toBe(true);
    expect([...ls.before].length).toBeLessThanOrEqual(49);
    expect([...ls.after].length).toBeLessThanOrEqual(97);
  });

  it("finds in current and past conversations, newest first", async () => {
    const school = temp();
    await saveArchived(school, chat([["When is the midterm?", "The Midterm is on Thursday."]]));
    await saveArchived(school, chat([["Plan my week", "Nothing about exams here."]]));
    saveIn(school, chat([["Remind me about the midterm", "Okay."]]));
    const r = search([["school", school]], "MIDTERM");
    expect(r.truncated).toBe(false);
    expect(r.conversations.length).toBe(2);
    const c = r.conversations[0]!;
    expect(c.current && c.threadId === "current" && c.space === "school" && c.matches === 1).toBe(true);
    expect(c.snippets[0]!.message).toBe(0);
    const old = r.conversations[1]!;
    expect(!old.current && isValidThreadId(old.threadId)).toBe(true);
    expect(old.title).toBe("When is the midterm?");
    expect(old.matches).toBe(2);
    expect(old.snippets.map((s) => [s.message, s.role])).toEqual([
      [0, "user"],
      [1, "assistant"],
    ]);
    expect(old.updated).toBeLessThanOrEqual(c.updated);
    expect(search([["school", school]], "nowhere to be found").conversations).toEqual([]);
    expect(search([["school", school]], "  ").conversations).toEqual([]);
  });

  it("searches only the spaces given", () => {
    const school = temp();
    const work = temp();
    saveIn(school, chat([["budget for books", "ok"]]));
    saveIn(work, chat([["quarterly budget", "ok"]]));
    expect(search([["school", school]], "budget").conversations.map((c) => c.space)).toEqual(["school"]);
    const both = search(
      [
        ["school", school],
        ["work", work],
      ],
      "budget",
    );
    expect(both.conversations.map((c) => c.space).sort()).toEqual(["school", "work"]);
  });

  it("caps snippets and conversations and skips unreadable files", () => {
    const dir = temp();
    saveIn(dir, chat(Array.from({ length: 5 }, () => ["cap cap", "cap"] as [string, string])));
    const r = search([["s", dir]], "cap");
    expect(r.conversations[0]!.matches).toBe(15);
    expect(r.conversations[0]!.snippets.length).toBe(MAX_SNIPPETS);
    fs.writeFileSync(path.join(dir, ".phaethon/thread.json"), "{ half");
    expect(search([["s", dir]], "cap").conversations).toEqual([]);
    const archive = path.join(dir, ".phaethon/threads");
    fs.mkdirSync(archive, { recursive: true });
    const body = JSON.stringify(chat([["cap", "x"]]));
    for (let i = 0; i < MAX_CONVERSATIONS + 5; i++) fs.writeFileSync(path.join(archive, `${1_700_000_000_000 + i}.json`), body);
    const capped = search([["s", dir]], "cap");
    expect(capped.truncated).toBe(true);
    expect(capped.conversations.length).toBe(MAX_CONVERSATIONS);
    expect(capped.conversations.every((c, i, all) => i === 0 || all[i - 1]!.updated >= c.updated)).toBe(true);
  });

  it("searches only the text the conversation shows", () => {
    const dir = temp();
    saveIn(dir, [
      userMessage("what's in notes?"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secretword in thinking", signature: "s" },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "secretword.md" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "secretword in a file" }] },
      { role: "assistant", content: [{ type: "text", text: "Nothing much." }] },
    ]);
    expect(search([["s", dir]], "secretword").conversations).toEqual([]);
    expect(search([["s", dir]], "nothing much").conversations.length).toBe(1);
  });

  it("conversations_search covers one space or every space", async () => {
    ensureVault();
    saveIn(spaceDir("school"), chat([["algebra homework", "ok"]]));
    saveIn(spaceDir("work"), chat([["algebra of shifts", "ok"]]));
    const one = await call<{ conversations: { space: string }[] }>("conversations_search", { space: "school", query: "algebra", allSpaces: false });
    expect(one.conversations.map((c) => c.space)).toEqual(["school"]);
    const all = await call<{ conversations: { space: string }[] }>("conversations_search", { space: "school", query: "algebra", allSpaces: true });
    expect(all.conversations.map((c) => c.space).sort()).toEqual(["school", "work"]);
    await expect(call("conversations_search", { space: "../x", query: "a", allSpaces: false })).rejects.toThrow("is not a valid space name");
  });
});
