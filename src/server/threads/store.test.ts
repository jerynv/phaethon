import { canSymlinkFiles, symlink } from "../../../tests/fs.ts";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { call, tempHome } from "../../../tests/harness.ts";
import { claim, release, whileIdle, BUSY } from "../core/runs.ts";
import { forProvider, recordBlock, stamped, threadKey, userMessage, type Block, type Message, type Record_ } from "../core/thread.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { reference } from "../attachments/attachments.ts";
import {
  CURRENT_ID,
  STALE_EDIT,
  StoreError,
  addArchivedIn,
  cutAtIn,
  deleteThreadIn,
  denied,
  isUserBoundary,
  isValidThreadId,
  keptAttachments,
  listThreadsIn,
  loadIn,
  openThreadIn,
  planForgetIn,
  readSessionIn,
  saveIn,
  startNewIn,
  toUi,
  writeSessionIn,
} from "./store.ts";
import "./commands.ts";

const env = tempHome();
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
const currentFile = (d: string) => path.join(d, ".phaethon/thread.json");
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
  it("new archives a conversation with messages and starts empty", () => {
    const dir = tempSpace();
    startNewIn(dir);
    expect(archiveFiles(dir)).toEqual([]);
    const first = chat("When is Test 1?", "Thursday.");
    saveIn(dir, first);
    startNewIn(dir);
    expect(loadIn(dir)).toEqual([]);
    const files = archiveFiles(dir);
    expect(files.length).toBe(1);
    const id = files[0]!.replace(/\.json$/, "");
    expect(isValidThreadId(id)).toBe(true);
    expect(readJson(archived(dir, id))).toEqual(first);
    saveIn(dir, []);
    startNewIn(dir);
    expect(archiveFiles(dir).length).toBe(1);
    expect(fs.existsSync(currentFile(dir))).toBe(false);
  });

  it("lists the current one first, then the newest, with titles", async () => {
    const dir = tempSpace();
    const l0 = listThreadsIn(dir);
    expect(l0).toEqual([{ id: "current", title: "New conversation", updated: l0[0]!.updated, messages: 0, current: true }]);
    const long = "Plan my week around Test 1 and the problem set, and leave Friday evening free please";
    saveIn(dir, chat(long, "Here is a plan."));
    startNewIn(dir);
    await sleep(20);
    saveIn(dir, chat("  What is   due\nthis week? ", "Problem set 4."));
    startNewIn(dir);
    saveIn(dir, chat("Third", "Yes."));
    const l = listThreadsIn(dir);
    expect(l.length).toBe(3);
    expect(l[0]).toMatchObject({ id: "current", current: true, title: "Third", messages: 2 });
    expect(l[1]!.title).toBe("What is due this week?");
    expect(l[1]!.current).toBe(false);
    expect(l[2]!.title.endsWith("…") && [...l[2]!.title].length <= 60).toBe(true);
    expect(l[1]!.updated).toBeGreaterThanOrEqual(l[2]!.updated);
    fs.writeFileSync(path.join(archiveDir(dir), "notes.txt"), "x");
    fs.writeFileSync(path.join(archiveDir(dir), "..json"), "[]");
    fs.writeFileSync(path.join(archiveDir(dir), "12.json.tmp"), "[]");
    expect(listThreadsIn(dir).length).toBe(3);
  });

  it("open round-trips without losing anything", () => {
    const dir = tempSpace();
    const a = chat("first", "one");
    const b = chat("second", "two");
    saveIn(dir, a);
    startNewIn(dir);
    saveIn(dir, b);
    const aId = listThreadsIn(dir)[1]!.id;
    openThreadIn(dir, aId);
    expect(loadIn(dir)).toEqual(a);
    const l = listThreadsIn(dir);
    expect(l.length).toBe(2);
    expect(l[1]!.title).toBe("second");
    expect(fs.existsSync(archived(dir, aId))).toBe(false);
    openThreadIn(dir, l[1]!.id);
    expect(loadIn(dir)).toEqual(b);
    expect(listThreadsIn(dir)[1]!.title).toBe("first");
    openThreadIn(dir, "current");
    expect(() => openThreadIn(dir, "1234567890123")).toThrow();
    expect(loadIn(dir)).toEqual(b);
    expect(archiveFiles(dir).length).toBe(1);
    startNewIn(dir);
    const ids = listThreadsIn(dir).slice(1).map((t) => t.id);
    openThreadIn(dir, ids[0]!);
    expect(archiveFiles(dir).length).toBe(1);
  });

  it("an unreadable current conversation is moved aside, not deleted", () => {
    const dir = tempSpace();
    fs.mkdirSync(path.join(dir, ".phaethon"));
    fs.writeFileSync(currentFile(dir), "{ half a file");
    expect(() => loadIn(dir)).toThrow();
    expect(listThreadsIn(dir)[0]!.title).toBe("A conversation that couldn’t be read");
    startNewIn(dir);
    expect(loadIn(dir)).toEqual([]);
    const files = archiveFiles(dir);
    expect(files.length).toBe(1);
    expect(fs.readFileSync(path.join(archiveDir(dir), files[0]!), "utf8")).toBe("{ half a file");
  });

  it.skipIf(!canSymlinkFiles)("refuses ids with path tricks", () => {
    for (const bad of ["", "..", "../thread", "../../etc/passwd", "1/2", "1\\2", "12.json", "-1", "1-", "1-2-3", "a1", " 1", "1 ", "current/..", "１２"]) {
      expect(isValidThreadId(bad), bad).toBe(false);
    }
    for (const good of ["1760000000000", "1760000000000-2"]) expect(isValidThreadId(good)).toBe(true);
    const dir = tempSpace();
    saveIn(dir, chat("keep me", "kept"));
    fs.writeFileSync(path.join(dir, "secret.json"), JSON.stringify(chat("secret", "s")));
    for (const bad of ["../../secret", "../secret", "..", "/etc/passwd"]) expect(kindOf(errorOf(() => openThreadIn(dir, bad))), bad).toBe("invalid");
    expect(loadIn(dir)).toEqual(chat("keep me", "kept"));
    fs.mkdirSync(archiveDir(dir), { recursive: true });
    symlink(path.join(dir, "secret.json"), archived(dir, "1700000000000"));
    expect(listThreadsIn(dir).length).toBe(1);
    expect(kindOf(errorOf(() => openThreadIn(dir, "1700000000000")))).toBe("notFound");
    expect(loadIn(dir)).toEqual(chat("keep me", "kept"));
  });

  it("a busy space refuses and an idle one is released", async () => {
    const turn = claim("school")!;
    await expect(whileIdle("school", () => 1)).rejects.toThrow(BUSY);
    expect(await whileIdle("work", () => 2)).toBe(2);
    await expect(whileIdle("work", () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    const w = claim("work");
    expect(w).toBeDefined();
    release(w!);
    release(turn);
    expect(await whileIdle("school", () => 3)).toBe(3);
  });

  it("round-trips and gives the UI view", () => {
    const dir = tempSpace();
    expect(loadIn(dir)).toEqual([]);
    const msgs: Message[] = [
      userText("what's in notes?"),
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }, text("Let me look."), { type: "tool_use", id: "t1", name: "list_files", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.md" }] },
      reply("There is a.md."),
    ];
    saveIn(dir, msgs);
    expect(loadIn(dir)).toEqual(msgs);
    expect(toUi(msgs)).toEqual([
      { role: "user", text: "what's in notes?", attachments: [], index: 0, records: [] },
      { role: "assistant", text: "Let me look.\n\nThere is a.md.", attachments: [], index: 1, records: [] },
    ]);
    fs.writeFileSync(currentFile(dir), `{"not": "a list"}`);
    expect(() => loadIn(dir)).toThrow();
  });

  it("times round-trip, old files load, and the provider never sees them", () => {
    const dir = tempSpace();
    fs.mkdirSync(path.join(dir, ".phaethon"));
    fs.writeFileSync(currentFile(dir), `[{"role":"user","content":[{"type":"text","text":"old"}]},{"role":"assistant","content":[{"type":"text","text":"reply"}]}]`);
    const old = loadIn(dir);
    expect(toUi(old).every((m) => m.at === undefined)).toBe(true);
    expect(threadKey(old)).toBeUndefined();
    expect("at" in toUi(old)[0]!).toBe(false);
    const msgs = [...old, stamped(userText("new"))];
    saveIn(dir, msgs);
    const back = loadIn(dir);
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
    saveIn(dir, a);
    startNewIn(dir);
    saveIn(dir, [userMessage("b", [f("attachments/d/two.md")])]);
    const aId = listThreadsIn(dir)[1]!.id;
    expect(planForgetIn(dir, aId)).toEqual({ onlyHere: ["attachments/d/one.md"], shared: 1, key: "5" });
    fs.writeFileSync(currentFile(dir), `{ broken "attachments/d/one.md"`);
    expect(planForgetIn(dir, aId).onlyHere).toEqual(["attachments/d/two.md"]);
    expect(planForgetIn(dir, CURRENT_ID)).toEqual({ onlyHere: [], shared: 0, key: undefined });
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
    saveIn(dir, msgs);
    const original = structuredClone(msgs);
    for (const bad of [1, 2, 5, 99]) expect(() => cutAtIn(dir, msgs, bad)).toThrow(STALE_EDIT);
    expect(msgs).toEqual(original);
    expect(archiveFiles(dir)).toEqual([]);
    cutAtIn(dir, msgs, 3);
    expect(msgs).toEqual(original.slice(0, 3));
    const files = archiveFiles(dir);
    expect(files.length).toBe(1);
    expect(readJson(path.join(archiveDir(dir), files[0]!))).toEqual(original);
    expect(loadIn(dir)).toEqual(original);
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
    cutAtIn(dir, msgs, 2);
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
    cutAtIn(dir, msgs, 3);
    expect(msgs.length).toBe(3);
    const countDenied = (m: Message[]) => m.flatMap((x) => x.content).filter((b) => b.kind === "deniedEarlier").length;
    expect(countDenied(msgs)).toBe(2);
    msgs.push(userText("x"));
    cutAtIn(dir, msgs, 0);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.content.length).toBe(3);
    expect(forProvider(msgs)).toEqual([]);
    expect(toUi(msgs)).toEqual([]);
  });

  it.skipIf(!canSymlinkFiles)("delete removes one conversation and refuses bad ids", () => {
    const dir = tempSpace();
    saveIn(dir, chat("old", "one"));
    startNewIn(dir);
    saveIn(dir, chat("keep", "two"));
    startNewIn(dir);
    saveIn(dir, chat("now", "three"));
    let l = listThreadsIn(dir);
    const [keepId, oldId] = [l[1]!.id, l[2]!.id];
    expect(l[2]!.title).toBe("old");
    deleteThreadIn(dir, oldId);
    l = listThreadsIn(dir);
    expect(l.map((t) => t.title)).toEqual(["now", "keep"]);
    expect(fs.existsSync(archived(dir, oldId))).toBe(false);
    expect(kindOf(errorOf(() => deleteThreadIn(dir, oldId)))).toBe("notFound");
    expect(kindOf(errorOf(() => openThreadIn(dir, oldId)))).toBe("notFound");
    fs.writeFileSync(path.join(dir, "secret.json"), "[]");
    fs.writeFileSync(path.join(dir, ".phaethon/grants.json"), "{}");
    for (const bad of ["", "..", "../thread", "../../secret", "/etc/passwd", "1/2", "12.json", "Current", "current/..", "thread"]) {
      expect(kindOf(errorOf(() => deleteThreadIn(dir, bad))), bad).toBe("invalid");
    }
    expect(fs.existsSync(path.join(dir, "secret.json")) && fs.existsSync(path.join(dir, ".phaethon/grants.json")) && fs.existsSync(currentFile(dir))).toBe(true);
    symlink(path.join(dir, "secret.json"), archived(dir, "1700000000000"));
    expect(kindOf(errorOf(() => deleteThreadIn(dir, "1700000000000")))).toBe("notFound");
    expect(fs.existsSync(path.join(dir, "secret.json"))).toBe(true);
    deleteThreadIn(dir, CURRENT_ID);
    expect(fs.existsSync(currentFile(dir))).toBe(false);
    expect(loadIn(dir)).toEqual([]);
    expect(fs.existsSync(archived(dir, keepId))).toBe(true);
    deleteThreadIn(dir, CURRENT_ID);
  });

  const S1 = "11111111-1111-1111-1111-111111111111";
  const S2 = "22222222-2222-2222-2222-222222222222";

  it("each conversation keeps its own CLI session", () => {
    const dir = tempSpace();
    const session = () => readSessionIn(dir);
    writeSessionIn(dir, S1);
    saveIn(dir, chat("first", "one"));
    startNewIn(dir);
    expect(session()).toBeNull();
    let first = listThreadsIn(dir)[1]!.id;
    expect(fs.readFileSync(archivedSession(dir, first), "utf8").trim()).toBe(S1);
    writeSessionIn(dir, S2);
    saveIn(dir, chat("second", "two"));
    openThreadIn(dir, first);
    expect(session()).toBe(S1);
    let second = listThreadsIn(dir)[1]!.id;
    expect(fs.readFileSync(archivedSession(dir, second), "utf8").trim()).toBe(S2);
    expect(fs.existsSync(archivedSession(dir, first))).toBe(false);
    expect(listThreadsIn(dir).length).toBe(2);
    openThreadIn(dir, second);
    expect(session()).toBe(S2);
    first = listThreadsIn(dir).find((t) => t.title === "first")!.id;
    fs.rmSync(archivedSession(dir, first));
    openThreadIn(dir, first);
    expect(session()).toBeNull();
    second = listThreadsIn(dir)[1]!.id;
    expect(fs.existsSync(archivedSession(dir, second))).toBe(true);
    deleteThreadIn(dir, second);
    expect(fs.existsSync(archivedSession(dir, second))).toBe(false);
    writeSessionIn(dir, S1);
    deleteThreadIn(dir, CURRENT_ID);
    expect(session()).toBeNull();
    const msgs = chat("q", "a");
    saveIn(dir, msgs);
    writeSessionIn(dir, S2);
    cutAtIn(dir, msgs, 0);
    expect(session()).toBeNull();
    const copy = listThreadsIn(dir)[1]!.id;
    expect(fs.readFileSync(archivedSession(dir, copy), "utf8").trim()).toBe(S2);
  });

  it("each CLI reads only its own session, and malformed ids are refused", () => {
    const dir = tempSpace();
    const id = "e06355fe-8387-4cb5-9fda-517b0d2b996a";
    writeSessionIn(dir, id, "codex");
    expect(readSessionIn(dir, "codex")).toBe(id);
    expect(readSessionIn(dir)).toBeNull();
    expect(readSessionIn(dir, "gemini")).toBeNull();
    writeSessionIn(dir, id);
    expect(readSessionIn(dir)).toBe(id);
    expect(fs.readFileSync(path.join(dir, ".phaethon/session"), "utf8")).toBe(`${id}\n`);
    expect(readSessionIn(dir, "codex")).toBeNull();
    expect(() => writeSessionIn(dir, "--last", "codex")).toThrow("refusing to save a malformed session id");
    fs.writeFileSync(path.join(dir, ".phaethon/session"), "codex:--dangerously-bypass-approvals-and-sandbox\n");
    expect(readSessionIn(dir, "codex")).toBeNull();
    fs.writeFileSync(path.join(dir, ".phaethon/session"), `${id}\n--x`);
    expect(readSessionIn(dir)).toBeNull();
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
    expect(listThreadsIn(dir)[1]).toMatchObject({ id, title: "imported", updated: 1_700_000_000_000, messages: 2 });
  });
});

describe("thread commands", () => {
  it("load, list, new, open and delete through the command layer", async () => {
    ensureVault();
    saveIn(spaceDir("school"), chat("hello", "hi"));
    expect(await call("thread_load", { space: "school" })).toEqual(toUi(chat("hello", "hi")));
    expect(await call("thread_new", { space: "school" })).toBeNull();
    const list = await call<{ id: string }[]>("threads_list", { space: "school" });
    expect(list.length).toBe(2);
    await call("thread_open", { space: "school", id: list[1]!.id });
    expect(loadIn(spaceDir("school"))).toEqual(chat("hello", "hi"));
    await expect(call("thread_delete", { space: "school", id: "../x" })).rejects.toThrow("That conversation couldn’t be deleted: not a conversation id");
    const run = claim("school")!;
    await expect(call("thread_new", { space: "school" })).rejects.toThrow(BUSY);
    release(run);
    fs.writeFileSync(path.join(spaceDir("school"), ".phaethon/thread.json"), "{ bad");
    await expect(call("thread_load", { space: "school" })).rejects.toThrow("This space’s conversation couldn’t be read: thread.json is not valid JSON");
    await expect(call("thread_load", { space: "nope" })).rejects.toThrow('space "nope" does not exist in this vault');
  });
});
