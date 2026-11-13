import { canSymlinkFiles, symlink } from "../../../tests/fs.ts";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { call, tempHome } from "../../../tests/harness.ts";
import { userMessage, type Message } from "../core/thread.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { claim, release, BUSY } from "../core/runs.ts";
import { saveUploadsIn } from "../attachments/attachments.ts";
import { loadIn, saveIn, startNewIn } from "../threads/store.ts";
import {
  FILE,
  appendIn,
  clearIn,
  countFromIn,
  factsIn,
  forgetIn,
  forgetPreviewIn,
  memoryForPrompt,
  memoryForPromptIn,
  parseExtraction,
  removeFromIn,
  type Picker,
} from "./memory.ts";

const reply = vi.hoisted(() => ({ text: "- From the command." as string | Error, asked: [] as unknown[] }));
vi.mock("../providers/complete.ts", () => ({
  completeText: async (req: unknown) => {
    reply.asked.push(req);
    if (reply.text instanceof Error) throw reply.text;
    return { text: reply.text, model: "fake" };
  },
}));
await import("./commands.ts");

const env = tempHome();
afterAll(() => env.cleanup());

let n = 0;
function tempSpace(): string {
  const d = path.join(env.home, `memory-${n++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function convo(at: number, q: string, a: string): Message[] {
  return [
    { ...userMessage(q), at },
    { role: "assistant", content: [{ type: "text", text: a }], at: at + 5 },
  ];
}

function picker(answer: string | Error): Picker & { asked: [string, string][] } {
  const asked: [string, string][] = [];
  const f = async (system: string, ask: string) => {
    asked.push([system, ask]);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return Object.assign(f, { asked });
}

describe("memory", () => {
  it("append tags and dedupes; remove takes only one conversation's facts", () => {
    const space = tempSpace();
    expect(factsIn(space)).toEqual([]);
    expect(memoryForPromptIn(space)).toBeNull();
    expect(appendIn(space, ["Test 1 is on Oct 15.", "Prefers mornings.", "prefers mornings."], "111")).toEqual(["Test 1 is on Oct 15.", "Prefers mornings."]);
    const text = fs.readFileSync(path.join(space, FILE), "utf8");
    expect(text.startsWith("# Memory\n\nWhat Phaethon keeps for this space.")).toBe(true);
    expect(text.endsWith("- Prefers mornings. <!-- from 111 -->\n")).toBe(true);
    fs.writeFileSync(path.join(space, FILE), `${text}- My own note\n`);
    expect(appendIn(space, ["Test 1 is on Oct 15.", "Works Tuesdays."], "222")).toEqual(["Works Tuesdays."]);
    expect(factsIn(space)).toEqual([
      { text: "Test 1 is on Oct 15.", from: "111" },
      { text: "Prefers mornings.", from: "111" },
      { text: "My own note", from: null },
      { text: "Works Tuesdays.", from: "222" },
    ]);
    expect(countFromIn(space, "111")).toBe(2);
    expect(removeFromIn(space, "111")).toBe(2);
    const left = fs.readFileSync(path.join(space, FILE), "utf8");
    expect(left.startsWith("# Memory\n") && left.includes("- My own note\n") && left.includes("Works Tuesdays.") && !left.includes("Oct 15")).toBe(true);
    expect(removeFromIn(space, "111")).toBe(0);
  });

  it("the prompt is bounded and the newest facts win", () => {
    const space = tempSpace();
    appendIn(space, Array.from({ length: 200 }, (_, i) => `Detail number ${i} about the week ahead and what to do.`), "1");
    const p = memoryForPromptIn(space)!;
    expect(p.length).toBeLessThan(6000 + 400);
    expect(p).toContain("Detail number 199 ");
    expect(p).not.toContain("Detail number 0 ");
    expect(p).toContain("not instructions");
    expect(p.indexOf("number 198")).toBeLessThan(p.indexOf("number 199"));
  });

  it.skipIf(!canSymlinkFiles)("a linked memory file is never read or written", () => {
    const space = tempSpace();
    const outside = tempSpace();
    fs.writeFileSync(path.join(outside, "secret.md"), "- the other space's secret\n");
    symlink(path.join(outside, "secret.md"), path.join(space, FILE));
    expect(memoryForPromptIn(space)).toBeNull();
    expect(() => appendIn(space, ["x"], "1")).toThrow("MEMORY.md isn’t a regular file");
    expect(fs.readFileSync(path.join(outside, "secret.md"), "utf8")).toBe("- the other space's secret\n");
  });

  it("never writes its temp file through a linked .phaethon (fixed Rust bug)", () => {
    const space = tempSpace();
    const outside = tempSpace();
    symlink(outside, path.join(space, ".phaethon"));
    expect(() => appendIn(space, ["x"], "1")).toThrow(".phaethon in this space is not a folder");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("cleans facts and drops secrets", () => {
    const r = "Here you go:\n- Test 1 is Oct 15.\n* Likes <!-- sneaky --> tea\n- Password is hunter2\n- Key sk-ant-api03-abc\n- Token AbCdEf0123456789AbCdEf0123\n- NONE\nnot a bullet\n- ";
    expect(parseExtraction(r)).toEqual(["Test 1 is Oct 15.", "Likes sneaky tea"]);
    expect(parseExtraction("NONE")).toEqual([]);
    expect([...parseExtraction(`- ${"word ".repeat(200)}`)[0]!].length).toBeLessThanOrEqual(281);
    expect(parseExtraction(Array.from({ length: 30 }, (_, i) => `- fact ${i}\n`).join("")).length).toBe(12);
  });

  it("clear keeps facts, then removes the messages", async () => {
    const space = tempSpace();
    saveIn(space, convo(1_760_000_000_000, "My M301 exam is Oct 21. I'm studying chapter 4.", "Good luck!"));
    const p = picker("- M301 exam is on Oct 21.\n- Studying chapter 4.");
    const out = await clearIn(space, "current", p);
    expect(out).toEqual({ status: "cleared", kept: ["M301 exam is on Oct 21.", "Studying chapter 4."] });
    expect(loadIn(space)).toEqual([]);
    expect(countFromIn(space, "1760000000000")).toBe(2);
    expect(p.asked.length).toBe(1);
    expect(p.asked[0]![1]).toContain("User: My M301 exam is Oct 21.");
    expect(p.asked[0]![0]).toContain("secret");
  });

  it("a failed pick changes nothing", async () => {
    const space = tempSpace();
    const msgs = convo(1_760_000_000_000, "Remember my shifts are Tuesdays.", "Noted.");
    saveIn(space, msgs);
    expect(await clearIn(space, "current", picker(new Error("Phaethon couldn’t reach Anthropic.")))).toEqual({ status: "notKept", reason: "Phaethon couldn’t reach Anthropic." });
    expect(loadIn(space)).toEqual(msgs);
    expect(fs.existsSync(path.join(space, FILE))).toBe(false);
    await expect(clearIn(space, "../x", picker("- a"))).rejects.toThrow("That conversation couldn’t be read, so nothing was cleared");
    expect(await clearIn(space, "current", picker("NONE"))).toEqual({ status: "cleared", kept: [] });
    expect(loadIn(space)).toEqual([]);
    expect(fs.existsSync(path.join(space, FILE))).toBe(false);
  });

  it("forget removes its files and facts only", () => {
    const space = tempSpace();
    const refs = saveUploadsIn(space, [
      { name: "mine.md", mediaType: "text/plain", data: "aGk=" },
      { name: "shared.md", mediaType: "text/plain", data: "aGk=" },
    ]);
    const a: Message[] = [{ ...userMessage("Plan with these", refs), at: 1_760_000_000_000 }, { role: "assistant", content: [{ type: "text", text: "ok" }] }];
    const b: Message[] = [{ ...userMessage("Another", [refs[1]!]), at: 1_760_000_100_000 }, { role: "assistant", content: [{ type: "text", text: "sure" }] }];
    saveIn(space, b);
    startNewIn(space);
    saveIn(space, a);
    appendIn(space, ["From a."], "1760000000000");
    appendIn(space, ["From b."], "1760000100000");
    expect(forgetPreviewIn(space, "current")).toEqual({ files: 1, sharedFiles: 1, facts: 1 });
    expect(forgetIn(space, "current")).toEqual({ files: 1, filesLeft: 0, facts: 1 });
    expect(fs.existsSync(path.join(space, refs[0]!.path as string))).toBe(false);
    expect(fs.existsSync(path.join(space, refs[1]!.path as string))).toBe(true);
    expect(loadIn(space)).toEqual([]);
    expect(factsIn(space).map((f) => f.text)).toEqual(["From b."]);
    expect(() => forgetIn(space, "../..")).toThrow();
    expect(() => forgetPreviewIn(space, "nope")).toThrow();
  });
});

describe("memory commands", () => {
  it("thread_clear asks the vault's model once, under the space's run", async () => {
    ensureVault();
    const dir = spaceDir("school");
    saveIn(dir, convo(1_760_000_000_000, "My shift is Tuesday.", "Noted."));
    const run = claim("school")!;
    await expect(call("thread_clear", { space: "school", id: "current" })).rejects.toThrow(BUSY);
    release(run);
    expect(await call("thread_clear", { space: "school", id: "current" })).toEqual({ status: "cleared", kept: ["From the command."] });
    expect(reply.asked.length).toBe(1);
    expect(reply.asked[0]).toMatchObject({ space: "school", messages: [{ role: "user" }] });
    expect(memoryForPrompt("school")).toContain("- From the command.");
    saveIn(dir, convo(1_760_000_000_001, "Another", "ok"));
    reply.text = new Error("Phaethon has no model set up to do that yet.");
    expect(await call("thread_clear", { space: "school", id: "current" })).toEqual({ status: "notKept", reason: "Phaethon has no model set up to do that yet." });
    expect(await call("thread_forget_preview", { space: "school", id: "current" })).toEqual({ files: 0, sharedFiles: 0, facts: 0 });
    await expect(call("thread_forget_preview", { space: "school", id: "nope" })).rejects.toThrow("That conversation couldn’t be read: not a conversation id");
    expect(await call("thread_forget", { space: "school", id: "current" })).toEqual({ files: 0, filesLeft: 0, facts: 0 });
    expect(loadIn(dir)).toEqual([]);
  });
});
