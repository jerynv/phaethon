import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { call, tempHome } from "../../../../tests/harness.ts";
import { forProvider, load, save, threadKey, userMessage, type Message } from "../../core/thread.ts";
import { ensureVault, spaceDir } from "../../core/vault.ts";
import { toUi } from "../../threads/store.ts";
import "../commands.ts";
import { importConversations, importOnce, knownSessions, offered, projectDirName, readTranscript, remember, timeMs, transcripts } from "../import.ts";
import { readCliSession, writeCliSession } from "../session.ts";

const env = tempHome("phaethon-cli-import-");
afterAll(() => env.cleanup());

const FULL = "11111111-1111-4111-8111-111111111111";
const TOOL_ONLY = "22222222-2222-4222-8222-222222222222";
const ELSEWHERE = "33333333-3333-4333-8333-333333333333";
const KNOWN = "44444444-4444-4444-8444-444444444444";
const WRAPPED = "55555555-5555-4555-8555-555555555555";
const ALL = [FULL, TOOL_ONLY, ELSEWHERE, KNOWN, WRAPPED];
const FIXTURES = path.join(import.meta.dirname, "fixtures");

let space: string;
let claudeHome: string;
const project = () => path.join(claudeHome, "projects", projectDirName(space));
const fixture = (id: string) => fs.readFileSync(path.join(FIXTURES, `${id}.jsonl`), "utf8").replaceAll("@SPACE@", space);
const texts = (m: Message) => m.content.filter((b) => b.type === "text").map((b) => b.text);

function setup(ids: string[]) {
  fs.rmSync(path.join(env.home, "Phaethon"), { recursive: true, force: true });
  ensureVault();
  space = spaceDir("school");
  claudeHome = path.join(env.home, "claude-home");
  fs.rmSync(claudeHome, { recursive: true, force: true });
  fs.mkdirSync(project(), { recursive: true });
  for (const id of ids) fs.writeFileSync(path.join(project(), `${id}.jsonl`), fixture(id));
}

function archived(): { id: string; msgs: Message[]; mtime: number }[] {
  const dir = path.join(space, ".phaethon", "threads");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ id: f.slice(0, -5), msgs: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), mtime: fs.statSync(path.join(dir, f)).mtimeMs }));
}

beforeEach(() => setup([]));

describe("reading Claude Code transcripts", () => {
  it("use Claude Code's folder names", () => {
    expect(projectDirName("/Users/student/Phaethon/default/spaces/school")).toBe("-Users-student-Phaethon-default-spaces-school");
    expect(projectDirName("/a b/c_d.e/ü")).toBe("-a-b-c-d-e--");
  });

  it("keep timestamps' milliseconds and refuse bad ones", () => {
    expect(timeMs("2026-10-10T00:05:56.945Z")).toBe(1_791_590_756_945);
    expect(timeMs("2026-10-10T00:05:56Z")).toBe(1_791_590_756_000);
    expect(timeMs("2026-10-10T00:05:56.9Z")).toBe(1_791_590_756_900);
    expect(timeMs("yesterday")).toBeNull();
    expect(timeMs(12)).toBeNull();
  });

  it("read the user's words and the replies' text, in order", () => {
    setup([FULL]);
    const t = readTranscript(path.join(project(), `${FULL}.jsonl`), space)!;
    expect(t.session).toBe(FULL);
    expect(t.title).toBe("C241 Test 1 date and scope");
    expect(t.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(texts(t.messages[0])).toEqual(["When is Test 1?"]);
    expect(texts(t.messages[1])).toEqual(["Let me check the syllabus.", "Test 1 is on **Thursday, Oct 15** at 10:00.\n\n- Bring a pencil"]);
    expect(texts(t.messages[2])).toEqual(["And what does it cover?  Sets, functions, “relations”?"]);
    expect(texts(t.messages[3])).toEqual(["Sets, functions and relations — chapters 1–3."]);
    expect(t.messages[0].at).toBe(1_791_590_756_945);
    expect(t.messages[1].at).toBe(1_791_590_765_500);
    expect(t.messages[2].at).toBe(1_791_590_880_000);
    expect(t.lastAt).toBe(1_791_590_889_000);
    const raw = JSON.stringify(t.messages);
    for (const leftOut of ["thinking", "tool_use", "tool_result", "syllabus.md", "subagent", "API Error", "/cost", "Caveat", "iVBOR"]) expect(raw).not.toContain(leftOut);
  });

  it("skip transcripts with nothing the user wrote, from another folder, or not a session's", () => {
    setup([TOOL_ONLY, ELSEWHERE]);
    expect(readTranscript(path.join(project(), `${TOOL_ONLY}.jsonl`), space)).toBeNull();
    expect(readTranscript(path.join(project(), `${ELSEWHERE}.jsonl`), space)).toBeNull();
    fs.writeFileSync(path.join(project(), "notes.jsonl"), fixture(KNOWN));
    expect(readTranscript(path.join(project(), "notes.jsonl"), space)).toBeNull();
    fs.writeFileSync(path.join(project(), `${KNOWN}.txt`), "x");
    expect(transcripts(claudeHome, space).some((p) => p.endsWith(".txt"))).toBe(false);
    expect(importConversations("school", claudeHome)).toEqual([]);
    expect(archived()).toEqual([]);
  });

  it("keep only the user's new words from Phaethon's fresh-session prompt", () => {
    setup([WRAPPED]);
    const t = readTranscript(path.join(project(), `${WRAPPED}.jsonl`), space)!;
    expect(texts(t.messages[0])).toEqual(["Move the essay to Friday"]);
    expect(t.title).toBeNull();
  });

  it("skip unreadable lines, never the file", () => {
    setup([KNOWN]);
    const file = path.join(project(), `${KNOWN}.jsonl`);
    const raw = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(' not utf-8\n{"type":\n'), fs.readFileSync(file), Buffer.from('{"type":"user","message":{"role":"user","content":42}}\n{"type":"assistant"}\n')]);
    fs.writeFileSync(file, raw);
    const t = readTranscript(file, space)!;
    expect(t.messages).toHaveLength(2);
    expect(texts(t.messages[1])).toEqual(["Hi! What do you need?"]);
  });

  it("never follow links", () => {
    const outside = path.join(env.home, "outside.jsonl");
    fs.writeFileSync(outside, fixture(KNOWN));
    fs.symlinkSync(outside, path.join(project(), `${KNOWN}.jsonl`));
    expect(transcripts(claudeHome, space)).toEqual([]);
    expect(offered("school", claudeHome, false)).toBe(false);
    expect(offered("school", claudeHome, true)).toBe(true);
    expect(offered("school", null, false)).toBe(false);
  });
});

describe("bringing them in", () => {
  it("brings each unknown conversation in once, resumable, dated, oldest first, the current one untouched", () => {
    setup(ALL);
    save("school", [userMessage("hi"), { role: "assistant", content: [{ type: "text", text: "Hi! What do you need?" }] }]);
    writeCliSession(space, null, KNOWN);
    const before = fs.readFileSync(path.join(space, ".phaethon", "thread.json"));
    fs.mkdirSync(path.join(space, ".phaethon", "threads"), { recursive: true });
    fs.writeFileSync(path.join(space, ".phaethon", "threads", "1.session"), "codex:01a12cac-8974-7110-be05-b08f8161e7fa\n");

    expect(importConversations("school", claudeHome)).toEqual(["Move the essay to Friday", "C241 Test 1 date and scope"]);
    expect(fs.readFileSync(path.join(space, ".phaethon", "thread.json"))).toEqual(before);
    expect(readCliSession(space, null)).toBe(KNOWN);
    const list = archived();
    expect(list).toHaveLength(2);
    const full = list.find((t) => JSON.stringify(t.msgs).includes(FULL))!;
    expect(Math.round(full.mtime)).toBe(1_791_590_889_000);
    expect(fs.readFileSync(path.join(space, ".phaethon", "threads", `${full.id}.session`), "utf8")).toBe(`${FULL}\n`);
    const ui = toUi(full.msgs);
    expect(ui).toHaveLength(4);
    expect(ui[1].text).toBe("Let me check the syllabus.\n\nTest 1 is on **Thursday, Oct 15** at 10:00.\n\n- Bring a pencil");
    expect(ui.every((m) => m.records.length === 0)).toBe(true);
    expect(JSON.stringify(forProvider(full.msgs))).not.toContain("phaethon_record");
    expect(threadKey(full.msgs)).toBe("1791590756945");
    expect(full.msgs[1].content.at(-1)).toEqual({ type: "phaethon_record", kind: "imported", from: "claude-code", session: FULL, title: "C241 Test 1 date and scope" });
    expect(importConversations("school", claudeHome)).toEqual([]);
    expect(archived()).toHaveLength(2);
  });

  it("never bring back a deleted conversation", () => {
    setup([FULL, KNOWN]);
    remember("school", KNOWN);
    expect(importConversations("school", claudeHome)).toEqual(["C241 Test 1 date and scope"]);
    for (const t of archived()) {
      fs.rmSync(path.join(space, ".phaethon", "threads", `${t.id}.json`));
      fs.rmSync(path.join(space, ".phaethon", "threads", `${t.id}.session`));
    }
    expect(importConversations("school", claudeHome)).toEqual([]);
  });

  it("know conversations a named Claude Code connection recorded, and remember their tagged sessions", () => {
    setup([FULL, KNOWN, WRAPPED]);
    // The current conversation was had through a named connection: its session line is tagged.
    writeCliSession(space, "claude-claude-work", KNOWN);
    fs.mkdirSync(path.join(space, ".phaethon", "threads"), { recursive: true });
    fs.writeFileSync(path.join(space, ".phaethon", "threads", "1.session"), `claude-claude-work:${WRAPPED}\n`);
    expect(knownSessions("school").has(KNOWN)).toBe(true);
    expect(knownSessions("school").has(WRAPPED)).toBe(true);
    expect(importConversations("school", claudeHome)).toEqual(["C241 Test 1 date and scope"]);
    // Deleting such a conversation remembers its session too.
    fs.rmSync(path.join(space, ".phaethon", "threads", "1.session"));
    remember("school", `claude-claude-work:${WRAPPED}`);
    expect(importConversations("school", claudeHome)).toEqual([]);
  });

  it("look once per space at launch; later transcripts are left to the menu", () => {
    setup([FULL]);
    expect(importOnce("school", claudeHome)).toEqual(["C241 Test 1 date and scope"]);
    fs.writeFileSync(path.join(project(), `${WRAPPED}.jsonl`), fixture(WRAPPED));
    expect(importOnce("school", claudeHome)).toBeNull();
    expect(importConversations("school", claudeHome)).toEqual(["Move the essay to Friday"]);
    expect(JSON.parse(fs.readFileSync(path.join(space, ".phaethon", "cli-import.json"), "utf8"))).toEqual({ checked: true, sessions: [FULL, WRAPPED] });
  });

  it("never duplicate even without the ledger or the session files", () => {
    setup([FULL]);
    importConversations("school", claudeHome);
    fs.rmSync(path.join(space, ".phaethon", "cli-import.json"));
    expect(importConversations("school", claudeHome)).toEqual([]);
    for (const f of fs.readdirSync(path.join(space, ".phaethon", "threads"))) if (f.endsWith(".session")) fs.rmSync(path.join(space, ".phaethon", "threads", f));
    expect(importConversations("school", claudeHome)).toEqual([]);
    expect(archived()).toHaveLength(1);
  });

  it("are offered and run through their commands with the selected connection's home", async () => {
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    setup([FULL]);
    expect(await call("cli_import_offered", { space: "school" })).toBe(true);
    expect(await call("cli_import_run", { space: "school" })).toEqual(["C241 Test 1 date and scope"]);
    expect(await call("cli_import_run", { space: "school" })).toEqual([]);
    await expect(call("cli_import_run", { space: "../x" })).rejects.toThrow('"../x" is not a valid space name');
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(load("school")).toEqual([]);
  });
});
