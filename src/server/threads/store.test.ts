import { canSymlinkFiles, symlink } from "../../../tests/fs.ts";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { call, tempHome } from "../../../tests/harness.ts";
import { claim, release, turnKey, whileIdle, BUSY } from "../core/runs.ts";
import { forProvider, recordBlock, stamped, threadKey, userMessage, type Block, type Message, type Record_ } from "../core/thread.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { reference } from "../attachments/attachments.ts";
import {
  STALE_EDIT,
  StoreError,
  addArchivedIn,
  createIn,
  cutAtIn,
  deleteThreadIn,
  denied,
  isUserBoundary,
  isValidThreadId,
  keptAttachments,
  listThreadsIn,
  loadConversationIn,
  loadIn,
  migrateIn,
  planForgetIn,
  readMetaIn,
  readPickRawIn,
  readSessionIn,
  saveIn,
  toUi,
  writeSessionIn,
} from "./store.ts";
import "./commands.ts";

const env = tempHome();
const S2 = "22222222-2222-2222-2222-222222222222";
const S1 = "11111111-1111-1111-1111-111111111111";
afterAll(() => env.cleanup());

let n = 0;
function tempSpace(): string {
  const d = path.join(env.home, `space-${n++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const text = (t: string): Block => ({ type: "text", text: t });
const userText = (t: string) => userMessage(t);
const reply = (t: string): Message => ({ role: "assistant", content: [text(t)] });
const chat = (q: string, a: string): Message[] => [userText(q), reply(a)];
const archiveDir = (d: string) => path.join(d, ".phaethon/threads");
const archiveFiles = (d: string) => (fs.existsSync(archiveDir(d)) ? fs.readdirSync(archiveDir(d)).sort() : []);
const legacyFile = (d: string) => path.join(d, ".phaethon/thread.json");
const archived = (d: string, id: string) => path.join(archiveDir(d), `${id}.json`);
const archivedSession = (d: string, id: string) => path.join(archiveDir(d), `${id}.session`);
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kindOf = (e: unknown) => (e as StoreError).kind;
function errorOf(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

describe("conversations", () => {
  it("are each their own file, created only by their first save", () => {
    const dir = tempSpace();
    const a = createIn(dir);
    const b = createIn(dir);
    expect(isValidThreadId(a) && isValidThreadId(b) && a !== b).toBe(true);
    // A new chat writes nothing until its first message.
    expect(archiveFiles(dir)).toEqual([]);
    expect(loadIn(dir, a)).toEqual([]);
    expect(listThreadsIn(dir)).toEqual([]);
    const first = chat("When is Test 1?", "Thursday.");
    saveIn(dir, a, first);
    saveIn(dir, b, chat("Other", "Yes."));
    expect(readJson(archived(dir, a))).toEqual(first);
    expect(loadIn(dir, a)).toEqual(first);
    expect(archiveFiles(dir)).toEqual([`${a}.json`, `${b}.json`].sort());
    // An id handed out is never handed out again, even before it is saved.
    const c = createIn(dir);
    expect([a, b]).not.toContain(c);
  });

  it("lists the newest first, with titles", async () => {
    const dir = tempSpace();
    expect(listThreadsIn(dir)).toEqual([]);
    const long = "Plan my week around Test 1 and the problem set, and leave Friday evening free please";
    saveIn(dir, "1000", chat(long, "Here is a plan."));
    await sleep(20);
    saveIn(dir, "2000", chat("  What is   due\nthis week? ", "Problem set 4."));
    await sleep(20);
    saveIn(dir, "3000", chat("Third", "Yes."));
    const l = listThreadsIn(dir);
    expect(l.map((t) => t.id)).toEqual(["3000", "2000", "1000"]);
    expect(l[0]).toEqual({ id: "3000", title: "Third", messages: 2, updated: l[0]!.updated });
    expect(l[1]!.title).toBe("What is due this week?");
    expect(l[2]!.title.endsWith("…") && [...l[2]!.title].length <= 60).toBe(true);
    expect(l[1]!.updated).toBeGreaterThanOrEqual(l[2]!.updated);
    fs.writeFileSync(path.join(archiveDir(dir), "notes.txt"), "x");
    fs.writeFileSync(path.join(archiveDir(dir), "..json"), "[]");
    fs.writeFileSync(path.join(archiveDir(dir), "12.json.tmp"), "[]");
    fs.writeFileSync(path.join(archiveDir(dir), "3000.session"), S1);
    expect(listThreadsIn(dir).length).toBe(3);
  });

  it("an unreadable conversation is listed, not deleted", () => {
    const dir = tempSpace();
    fs.mkdirSync(archiveDir(dir), { recursive: true });
    fs.writeFileSync(archived(dir, "1000"), "{ half a file");
    expect(() => loadIn(dir, "1000")).toThrow();
    expect(listThreadsIn(dir)[0]).toMatchObject({ id: "1000", title: "A conversation that couldn’t be read" });
    expect(fs.readFileSync(archived(dir, "1000"), "utf8")).toBe("{ half a file");
  });

  it.skipIf(!canSymlinkFiles)("refuses ids with path tricks", () => {
    for (const bad of ["", "..", "../thread", "../../etc/passwd", "1/2", "1\\2", "12.json", "-1", "1-", "1-2-3", "a1", " 1", "1 ", "current", "current/..", "１２"]) {
      expect(isValidThreadId(bad), bad).toBe(false);
    }
    for (const good of ["1760000000000", "1760000000000-2"]) expect(isValidThreadId(good)).toBe(true);
    const dir = tempSpace();
    saveIn(dir, "1000", chat("keep me", "kept"));
    fs.writeFileSync(path.join(dir, "secret.json"), JSON.stringify(chat("secret", "s")));
    for (const bad of ["../../secret", "../secret", "..", "/etc/passwd"]) {
      expect(kindOf(errorOf(() => loadIn(dir, bad))), bad).toBe("invalid");
      expect(kindOf(errorOf(() => saveIn(dir, bad, []))), bad).toBe("invalid");
      expect(kindOf(errorOf(() => loadConversationIn(dir, bad))), bad).toBe("invalid");
    }
    expect(fs.readFileSync(path.join(dir, "secret.json"), "utf8")).toBe(JSON.stringify(chat("secret", "s")));
    symlink(path.join(dir, "secret.json"), archived(dir, "1700000000000"));
    expect(listThreadsIn(dir).length).toBe(1);
    expect(kindOf(errorOf(() => loadConversationIn(dir, "1700000000000")))).toBe("notFound");
  });

  it.skipIf(!canSymlinkFiles)("saves through a fresh file, never through a link left at the name", () => {
    const dir = tempSpace();
    const outside = path.join(dir, "outside.json");
    fs.writeFileSync(outside, "untouched");
    fs.mkdirSync(archiveDir(dir), { recursive: true });
    symlink(outside, archived(dir, "1000"));
    saveIn(dir, "1000", chat("q", "a"));
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
    expect(fs.lstatSync(archived(dir, "1000")).isSymbolicLink()).toBe(false);
    symlink(outside, path.join(archiveDir(dir), "1000.session"));
    writeSessionIn(dir, "1000", S1);
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
    expect(readSessionIn(dir, "1000")).toBe(S1);
  });

  it("a busy conversation refuses and others in the same space don't", async () => {
    const turn = claim(turnKey("school", "1"))!;
    await expect(whileIdle(turnKey("school", "1"), () => 1)).rejects.toThrow(BUSY);
    expect(await whileIdle(turnKey("school", "2"), () => 2)).toBe(2);
    await expect(whileIdle("work", () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    const w = claim(turnKey("school", "3"));
    expect(w).toBeDefined();
    release(w!);
    release(turn);
    expect(await whileIdle(turnKey("school", "1"), () => 3)).toBe(3);
  });

  it("round-trips and gives the UI view", () => {
    const dir = tempSpace();
    expect(loadIn(dir, "1000")).toEqual([]);
    const msgs: Message[] = [
      userText("what's in notes?"),
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }, text("Let me look."), { type: "tool_use", id: "t1", name: "list_files", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.md" }] },
      reply("There is a.md."),
    ];
    saveIn(dir, "1000", msgs);
    expect(loadIn(dir, "1000")).toEqual(msgs);
    expect(toUi(msgs)).toEqual([
      { role: "user", text: "what's in notes?", attachments: [], index: 0, records: [] },
      { role: "assistant", text: "Let me look.\n\nThere is a.md.", attachments: [], index: 1, records: [] },
    ]);
    fs.writeFileSync(archived(dir, "1000"), `{"not": "a list"}`);
    expect(() => loadIn(dir, "1000")).toThrow();
  });

  it("times round-trip, old files load, and the provider never sees them", () => {
    const dir = tempSpace();
    fs.mkdirSync(archiveDir(dir), { recursive: true });
    fs.writeFileSync(archived(dir, "1000"), `[{"role":"user","content":[{"type":"text","text":"old"}]},{"role":"assistant","content":[{"type":"text","text":"reply"}]}]`);
    const old = loadIn(dir, "1000");
    expect(toUi(old).every((m) => m.at === undefined)).toBe(true);
    expect(threadKey(old)).toBeUndefined();
    expect("at" in toUi(old)[0]!).toBe(false);
    const msgs = [...old, stamped(userText("new"))];
    saveIn(dir, "1000", msgs);
    const back = loadIn(dir, "1000");
    expect(back).toEqual(msgs);
    const at = back[2]!.at!;
    expect(at).toBeGreaterThan(1_700_000_000_000);
    expect(toUi(back)[2]!.at).toBe(at);
    expect(threadKey([stamped(userText("x"))])!.length).toBe(13);
    expect(forProvider(back)[2]).toEqual({ role: "user", content: [text("new")] });
  });

  it("plan_forget keeps files other conversations name", () => {
    const dir = tempSpace();
    const f = (p: string) => reference(p, "text/plain", "x.md");
    const a: Message[] = [{ ...userMessage("a", [f("attachments/d/one.md"), f("attachments/d/two.md")]), at: 5 }];
    const aId = "1000";
    saveIn(dir, aId, a);
    saveIn(dir, "2000", [userMessage("b", [f("attachments/d/two.md")])]);
    expect(planForgetIn(dir, aId)).toEqual({ onlyHere: ["attachments/d/one.md"], shared: 1, key: "5" });
    fs.writeFileSync(archived(dir, "2000"), `{ broken "attachments/d/one.md"`);
    expect(planForgetIn(dir, aId).onlyHere).toEqual(["attachments/d/two.md"]);
    expect(planForgetIn(dir, "2000")).toEqual({ onlyHere: [], shared: 0, key: undefined });
    expect(kindOf(errorOf(() => planForgetIn(dir, "3000")))).toBe("notFound");
    expect(kindOf(errorOf(() => planForgetIn(dir, "../x")))).toBe("invalid");
  });

  const approval = (allowed: boolean): Record_ => ({ kind: "approval", path: "plan.md", action: "create", allowed });

  it("records show on their reply and never reach the provider", () => {
    const msgs: Message[] = [
      userText("plan my week"),
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "t1", name: "write_file", input: { path: "plan.md", contents: "x" } }, recordBlock(approval(false))],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "declined", is_error: true }] },
      reply("Okay, I won't."),
      userText("stop it"),
      { role: "assistant", content: [recordBlock({ kind: "stopped" })] },
      userText("hello"),
    ];
    const ui = toUi(msgs);
    expect(ui.length).toBe(5);
    expect([ui[1]!.index, ui[1]!.text, ui[1]!.records]).toEqual([1, "Okay, I won't.", [approval(false)]]);
    expect([ui[3]!.index, ui[3]!.text, ui[3]!.records]).toEqual([5, "", [{ kind: "stopped" }]]);
    expect([ui[4]!.role, ui[4]!.index]).toEqual(["user", 6]);
    const wire = forProvider(msgs);
    expect(JSON.stringify(wire)).not.toContain("phaethon_record");
    expect(wire.length).toBe(6);
    expect(wire[1]!.content.length).toBe(2);
    expect(wire[4]).toEqual(msgs[4]);
    expect(wire[5]).toEqual(msgs[6]);
  });

  it("a denial covers the path and everything inside it", () => {
    const deny = (space: string, p: string): Message => ({ role: "assistant", content: [recordBlock({ kind: "access", space, path: p, answer: "deny" })] });
    const msgs: Message[] = [userText("hi"), deny("work", "calendar"), { role: "assistant", content: [recordBlock({ kind: "access", space: "work", path: "notes", answer: "once" })] }];
    expect(denied(msgs, "work", "calendar")).toBe(true);
    expect(denied(msgs, "work", "calendar/oct.md")).toBe(true);
    expect(denied(msgs, "work", "calendar-old")).toBe(false);
    expect(denied(msgs, "home", "calendar")).toBe(false);
    expect(denied(msgs, "work", "notes")).toBe(false);
    expect(denied([deny("work", "calendar/oct.md")], "work", "calendar")).toBe(false);
  });

  it("cut_at keeps a copy and only cuts at user messages", () => {
    const dir = tempSpace();
    const msgs = chat("first", "one");
    msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] });
    msgs.push(...chat("second", "two"));
    saveIn(dir, "1000", msgs);
    const original = structuredClone(msgs);
    for (const bad of [1, 2, 5, 99]) expect(() => cutAtIn(dir, "1000", msgs, bad)).toThrow(STALE_EDIT);
    expect(msgs).toEqual(original);
    expect(archiveFiles(dir)).toEqual(["1000.json"]);
    cutAtIn(dir, "1000", msgs, 3);
    expect(msgs).toEqual(original.slice(0, 3));
    const files = archiveFiles(dir).filter((f) => f !== "1000.json");
    expect(files.length).toBe(1);
    expect(readJson(path.join(archiveDir(dir), files[0]!))).toEqual(original);
    expect(loadIn(dir, "1000")).toEqual(original);
  });

  it("a deny outlives the cut that drops it", () => {
    const dir = tempSpace();
    const rec = (space: string, p: string, answer: "deny" | "once"): Message => ({
      role: "assistant",
      content: [text("I can't, then."), recordBlock({ kind: "access", space, path: p, answer })],
    });
    const msgs: Message[] = [
      userText("first"),
      rec("work", "notes", "deny"),
      userText("second"),
      rec("work", "calendar", "deny"),
      userText("again"),
      rec("work", "calendar", "deny"),
      rec("home", "diary", "deny"),
      rec("work", "tasks", "once"),
    ];
    const beforeUi = toUi(msgs.slice(0, 2));
    cutAtIn(dir, "1000", msgs, 2);
    expect(msgs.length).toBe(3);
    const carried = msgs[2]!.content.map((b) => ({ ...b }));
    expect(carried).toEqual([
      { type: "phaethon_record", kind: "deniedEarlier", space: "work", path: "calendar" },
      { type: "phaethon_record", kind: "deniedEarlier", space: "home", path: "diary" },
    ]);
    expect(denied(msgs, "work", "calendar/oct.md") && denied(msgs, "home", "diary") && denied(msgs, "work", "notes")).toBe(true);
    expect(denied(msgs, "work", "tasks")).toBe(false);
    msgs.push(userText("second, reworded"));
    const wire = forProvider(msgs);
    expect(wire).toEqual([msgs[0], forProvider(msgs.slice(1, 2))[0], msgs[3]]);
    const ui = toUi(msgs);
    expect(ui.slice(0, 2)).toEqual(beforeUi);
    expect([ui.length, ui[2]!.role, ui[2]!.index]).toEqual([3, "user", 3]);
    expect(isUserBoundary(msgs, 3)).toBe(true);
    msgs.push(reply("ok"));
    cutAtIn(dir, "1000", msgs, 3);
    expect(msgs.length).toBe(3);
    const countDenied = (m: Message[]) => m.flatMap((x) => x.content).filter((b) => b.kind === "deniedEarlier").length;
    expect(countDenied(msgs)).toBe(2);
    msgs.push(userText("x"));
    cutAtIn(dir, "1000", msgs, 0);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.content.length).toBe(3);
    expect(forProvider(msgs)).toEqual([]);
    expect(toUi(msgs)).toEqual([]);
  });

  it.skipIf(!canSymlinkFiles)("delete removes one conversation and refuses bad ids", () => {
    const dir = tempSpace();
    saveIn(dir, "1000", chat("old", "one"));
    saveIn(dir, "2000", chat("keep", "two"));
    writeSessionIn(dir, "1000", S1);
    deleteThreadIn(dir, "1000");
    expect(listThreadsIn(dir).map((t) => t.title)).toEqual(["keep"]);
    expect(fs.existsSync(archived(dir, "1000")) || fs.existsSync(path.join(archiveDir(dir), "1000.session"))).toBe(false);
    expect(kindOf(errorOf(() => deleteThreadIn(dir, "1000")))).toBe("notFound");
    fs.writeFileSync(path.join(dir, "secret.json"), "[]");
    fs.writeFileSync(path.join(dir, ".phaethon/grants.json"), "{}");
    for (const bad of ["", "..", "../thread", "../../secret", "/etc/passwd", "1/2", "12.json", "Current", "current", "current/..", "thread"]) {
      expect(kindOf(errorOf(() => deleteThreadIn(dir, bad))), bad).toBe("invalid");
    }
    expect(fs.existsSync(path.join(dir, "secret.json")) && fs.existsSync(path.join(dir, ".phaethon/grants.json"))).toBe(true);
    symlink(path.join(dir, "secret.json"), archived(dir, "1700000000000"));
    expect(kindOf(errorOf(() => deleteThreadIn(dir, "1700000000000")))).toBe("notFound");
    expect(fs.existsSync(path.join(dir, "secret.json"))).toBe(true);
    expect(fs.existsSync(archived(dir, "2000"))).toBe(true);
  });



  it("each conversation keeps its own CLI session, and an edit's copy takes the cut one", () => {
    const dir = tempSpace();
    saveIn(dir, "1000", chat("first", "one"));
    saveIn(dir, "2000", chat("second", "two"));
    writeSessionIn(dir, "1000", S1);
    writeSessionIn(dir, "2000", S2);
    expect(readSessionIn(dir, "1000")).toBe(S1);
    expect(readSessionIn(dir, "2000")).toBe(S2);
    expect(readSessionIn(dir, "3000")).toBeNull();
    writeSessionIn(dir, "2000", null);
    expect(readSessionIn(dir, "2000")).toBeNull();
    expect(readSessionIn(dir, "1000")).toBe(S1);
    const msgs = loadIn(dir, "1000");
    cutAtIn(dir, "1000", msgs, 0);
    expect(readSessionIn(dir, "1000")).toBeNull();
    const copy = listThreadsIn(dir).find((t) => !["1000", "2000"].includes(t.id))!.id;
    expect(fs.readFileSync(archivedSession(dir, copy), "utf8").trim()).toBe(S1);
  });

  it("each CLI reads only its own session, and malformed ids are refused", () => {
    const dir = tempSpace();
    const id = "e06355fe-8387-4cb5-9fda-517b0d2b996a";
    const file = archivedSession(dir, "1000");
    writeSessionIn(dir, "1000", id, "codex");
    expect(readSessionIn(dir, "1000", "codex")).toBe(id);
    expect(readSessionIn(dir, "1000")).toBeNull();
    expect(readSessionIn(dir, "1000", "gemini")).toBeNull();
    writeSessionIn(dir, "1000", id);
    expect(readSessionIn(dir, "1000")).toBe(id);
    expect(fs.readFileSync(file, "utf8")).toBe(`${id}\n`);
    expect(readSessionIn(dir, "1000", "codex")).toBeNull();
    expect(() => writeSessionIn(dir, "1000", "--last", "codex")).toThrow("refusing to save a malformed session id");
    fs.writeFileSync(file, "codex:--dangerously-bypass-approvals-and-sandbox\n");
    expect(readSessionIn(dir, "1000", "codex")).toBeNull();
    fs.writeFileSync(file, `${id}\n--x`);
    expect(readSessionIn(dir, "1000")).toBeNull();
  });

  it("kept attachments come only from the replaced message", () => {
    const file = (p: string) => reference(p, "image/png", "photo.png");
    const msgs: Message[] = [
      userMessage("first", [file("attachments/2026-10-10/a.png"), file("attachments/2026-10-10/b.png")]),
      reply("ok"),
      userMessage("second", [file("attachments/2026-10-10/c.png")]),
    ];
    const paths = (v: Block[]) => v.map((b) => b.path);
    expect(paths(keptAttachments(msgs, 0, ["attachments/2026-10-10/b.png", "attachments/2026-10-10/a.png"]))).toEqual([
      "attachments/2026-10-10/a.png",
      "attachments/2026-10-10/b.png",
    ]);
    expect(paths(keptAttachments(msgs, 0, ["attachments/2026-10-10/b.png"]))).toEqual(["attachments/2026-10-10/b.png"]);
    expect(keptAttachments(msgs, 0, ["attachments/2026-10-10/c.png", "../../secret.txt"])).toEqual([]);
    expect(keptAttachments(msgs, 1, ["attachments/2026-10-10/a.png"])).toEqual([]);
    expect(keptAttachments(msgs, 9, ["attachments/2026-10-10/a.png"])).toEqual([]);
  });

  it("adds an imported conversation to the archive with its time and session", () => {
    const dir = tempSpace();
    const id = addArchivedIn(dir, chat("imported", "yes"), S1, 1_700_000_000_000);
    expect(isValidThreadId(id)).toBe(true);
    expect(fs.readFileSync(archivedSession(dir, id), "utf8")).toBe(`${S1}\n`);
    expect(listThreadsIn(dir)[0]).toMatchObject({ id, title: "imported", updated: 1_700_000_000_000, messages: 2 });
  });
});

describe("a space from before 0.3", () => {
  const oldThread = [{ ...userText("old question"), at: 1_760_000_000_000 }, reply("old answer")];

  function oldSpace(): string {
    const dir = tempSpace();
    fs.mkdirSync(path.join(dir, ".phaethon/threads"), { recursive: true });
    fs.writeFileSync(legacyFile(dir), JSON.stringify(oldThread, null, 2));
    fs.writeFileSync(path.join(dir, ".phaethon/session"), `codex:${S1}\n`);
    fs.writeFileSync(path.join(dir, ".phaethon/model"), `${JSON.stringify({ backend: "phaethon", model: "openai:gpt-5.5", effort: null })}\n`);
    fs.writeFileSync(path.join(dir, ".phaethon/meta"), `${JSON.stringify({ title: "Kept title", pinned: 5 })}\n`);
    fs.writeFileSync(archived(dir, "1700000000000"), JSON.stringify(chat("archived", "yes")));
    fs.writeFileSync(archivedSession(dir, "1700000000000"), `${S2}\n`);
    return dir;
  }

  it("moves its current conversation into threads/ with every sidecar, once", () => {
    const dir = oldSpace();
    const before = fs.readFileSync(legacyFile(dir), "utf8");
    const listed = listThreadsIn(dir);
    expect(listed.map((t) => t.title).sort()).toEqual(["Kept title", "archived"]);
    const moved = listed.find((t) => t.title === "Kept title")!;
    expect(moved).toMatchObject({ renamed: true, pinned: 5, messages: 2 });
    expect(isValidThreadId(moved.id) && moved.id !== "1700000000000").toBe(true);
    // By rename: the same bytes, and nothing left at the old names.
    expect(fs.readFileSync(archived(dir, moved.id), "utf8")).toBe(before);
    for (const old of ["thread.json", "session", "model", "meta"]) expect(fs.existsSync(path.join(dir, ".phaethon", old)), old).toBe(false);
    expect(readSessionIn(dir, moved.id, "codex")).toBe(S1);
    expect(readPickRawIn(dir, moved.id)).toEqual({ backend: "phaethon", model: "openai:gpt-5.5", effort: null });
    expect(readMetaIn(dir, moved.id)).toEqual({ title: "Kept title", pinned: 5 });
    // The archived one is untouched.
    expect(readSessionIn(dir, "1700000000000")).toBe(S2);
    // Nothing more to move.
    expect(migrateIn(dir)).toBeNull();
    expect(listThreadsIn(dir).map((t) => t.id).sort()).toEqual(listed.map((t) => t.id).sort());
  });

  it("moves on any read, not only the listing", () => {
    const dir = oldSpace();
    const moved = migrateIn(dir)!;
    expect(loadConversationIn(dir, moved)).toEqual(oldThread);
    const again = oldSpace();
    const planned = planForgetIn(again, "1700000000000");
    expect(planned.key).toBeUndefined();
    expect(fs.existsSync(legacyFile(again))).toBe(false);
  });

  it("removes an empty current conversation and its sidecars instead of keeping it", () => {
    const dir = tempSpace();
    fs.mkdirSync(path.join(dir, ".phaethon"), { recursive: true });
    fs.writeFileSync(legacyFile(dir), "[]");
    fs.writeFileSync(path.join(dir, ".phaethon/session"), `${S1}\n`);
    fs.writeFileSync(path.join(dir, ".phaethon/model"), "{}");
    expect(migrateIn(dir)).toBeNull();
    expect(listThreadsIn(dir)).toEqual([]);
    for (const old of ["thread.json", "session", "model"]) expect(fs.existsSync(path.join(dir, ".phaethon", old)), old).toBe(false);
  });

  it("keeps a damaged one, listed as unreadable", () => {
    const dir = tempSpace();
    fs.mkdirSync(path.join(dir, ".phaethon"), { recursive: true });
    fs.writeFileSync(legacyFile(dir), "{ half");
    const [t] = listThreadsIn(dir);
    expect(t).toMatchObject({ title: "A conversation that couldn’t be read" });
    expect(fs.readFileSync(archived(dir, t!.id), "utf8")).toBe("{ half");
  });

  it.skipIf(!canSymlinkFiles)("leaves a link at thread.json alone", () => {
    const dir = tempSpace();
    fs.mkdirSync(path.join(dir, ".phaethon"), { recursive: true });
    const outside = path.join(dir, "outside.json");
    fs.writeFileSync(outside, JSON.stringify(chat("secret", "s")));
    symlink(outside, legacyFile(dir));
    expect(migrateIn(dir)).toBeNull();
    expect(listThreadsIn(dir)).toEqual([]);
    expect(fs.existsSync(outside)).toBe(true);
  });
});

describe("thread commands", () => {
  it("create, load, list and delete through the command layer", async () => {
    ensureVault();
    const id = await call<string>("thread_create", { space: "school" });
    expect(isValidThreadId(id)).toBe(true);
    expect(await call("thread_load", { space: "school", thread: id })).toEqual([]);
    saveIn(spaceDir("school"), id, chat("hello", "hi"));
    expect(await call("thread_load", { space: "school", thread: id })).toEqual(toUi(chat("hello", "hi")));
    const list = await call<{ id: string }[]>("threads_list", { space: "school" });
    expect(list.map((t) => t.id)).toContain(id);
    await expect(call("thread_load", { space: "school", thread: "../x" })).rejects.toThrow("That isn’t a conversation Phaethon knows.");
    await expect(call("thread_load", { space: "school" })).rejects.toThrow("That isn’t a conversation Phaethon knows.");
    await expect(call("thread_delete", { space: "school", id: "../x" })).rejects.toThrow("That isn’t a conversation Phaethon knows.");
    const run = claim(turnKey("school", id))!;
    await expect(call("thread_delete", { space: "school", thread: id })).rejects.toThrow(BUSY);
    release(run);
    fs.writeFileSync(archived(spaceDir("school"), id), "{ bad");
    await expect(call("thread_load", { space: "school", thread: id })).rejects.toThrow("This conversation couldn’t be read: thread.json is not valid JSON");
    await call("thread_delete", { space: "school", thread: id });
    await expect(call("thread_load", { space: "nope", thread: id })).rejects.toThrow('space "nope" does not exist in this vault');
  });
});
