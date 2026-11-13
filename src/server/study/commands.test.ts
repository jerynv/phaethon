import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, channel, tempHome } from "../../../tests/harness.ts";
import { spaceDir, vaultRoot } from "../core/vault.ts";
import "./commands.ts";
import { origin } from "./chat.ts";
import { ALL, fixture, put, Scripted } from "./testing.ts";
import { build, seenCourse } from "./scope.ts";
import { visibleFor } from "./visible.ts";
import type { StudyEvent } from "./types.ts";

const env = tempHome();
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-fake-claude-"));
afterAll(() => {
  env.cleanup();
  fs.rmSync(bin, { recursive: true, force: true });
});

const SRC = "courses/CSCI-C 241/files/HW/Test 1 Review.pdf";
const Q1 = "A conditional p → q is false only when p is true and q is false.";
const unix = process.platform !== "win32";

/** A fake Claude Code: each call prints the next canned `--output-format json` result (or sleeps, when told to). */
function fakeClaude(replies: string[], sleep = false) {
  for (const f of fs.readdirSync(bin)) fs.rmSync(path.join(bin, f));
  replies.forEach((r, i) => fs.writeFileSync(path.join(bin, `out-${i + 1}.json`), JSON.stringify({ type: "result", subtype: "success", is_error: false, result: r })));
  if (sleep) fs.writeFileSync(path.join(bin, "sleep"), "");
  const script = path.join(bin, "claude");
  fs.writeFileSync(
    script,
    `#!/bin/sh\ncat > /dev/null\nd='${bin}'\nn=$(cat "$d/count" 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > "$d/count"\nif [ -f "$d/sleep" ]; then exec sleep 30; fi\ncat "$d/out-$n.json"\n`,
    { mode: 0o755 },
  );
  process.env.PHAETHON_CLAUDE_BIN = script;
}

const calls = () => Number(fs.readFileSync(path.join(bin, "count"), "utf8").trim() || 0);

beforeAll(() => {
  put("courses/CSCI-C 241/files/HW/Test 1 Review.pdf", "%PDF");
  put("courses/CSCI-C 241/files/HW/Test 1 Review.pdf.md", `# Text of Test 1 Review.pdf\n\n${Q1}\n`);
  fixture("s", [["CSCI-C 241", ALL]]);
  put(".phaethon/settings.json", JSON.stringify({ backend: "claude-cli" }));
});

const mapReply = JSON.stringify({ topics: [{ id: "t1", title: "Conditionals", terms: ["conditional"], weight: 3, evidence: [{ source: SRC, quote: Q1 }] }], exams: [] });
const quizReply = JSON.stringify({
  title: "Logic",
  questions: [{ topic: "t1", kind: "truefalse", prompt: "If p is false, p → q is true.", explanation: "Only a true p with a false q fails.", answer: "true", citations: [{ source: SRC, quote: Q1 }] }],
});
const yes = JSON.stringify({ verdicts: [{ id: "i1", verdict: "yes", missing: "", answerOk: true }] });

const finals = (ms: StudyEvent[]) => ms.filter((m) => m.type === "done" || m.type === "error" || m.type === "cancelled");

describe("study commands", () => {
  it("save, list, study, rate and delete a deck", async () => {
    const p = await call<string>("study_deck_save", { space: "s", path: null, title: "Sets: basics", cards: [{ front: "What is a set?", back: "A collection of members." }] });
    expect(p).toBe("study/decks/Sets- basics.md");
    const o = await call<{ decks: { path: string; new: number }[] }>("study_overview", { space: "s" });
    expect(o.decks.map((d) => [d.path, d.new])).toEqual([[p, 1]]);
    const cards = await call<{ id: string; deck: string }[]>("study_session", { space: "s", paths: null, limit: null });
    expect(cards).toHaveLength(1);
    const rated = await call<{ due: number; again: boolean }>("study_rate", { space: "s", deck: p, card: cards[0]!.id, confidence: 5 });
    expect(rated.again).toBe(false);
    await expect(call("study_rate", { space: "s", deck: p, card: cards[0]!.id, confidence: 1.5 })).rejects.toThrow("invalid args `confidence`");
    await expect(call("study_rate", { space: "s", deck: p, card: cards[0]!.id, confidence: 6 })).rejects.toThrow("Rate how well you knew it from 1 to 5.");
    expect(await call("study_delete", { space: "s", path: p })).toBeNull();
    await expect(call("study_deck", { space: "s", path: p })).rejects.toThrow("That deck isn’t in this space any more.");
  });

  it.skipIf(!unix)("makes a quiz through the space's CLI and ends with exactly one done", async () => {
    fakeClaude([mapReply, quizReply, yes]);
    const ch = channel<StudyEvent>();
    expect(await call("study_make_quiz", { space: "s", sources: ["courses/CSCI-C 241"], options: { count: 1, kinds: ["truefalse"] }, onEvent: ch })).toBeNull();
    expect(calls()).toBe(3);
    expect(ch.messages.some((m) => m.type === "progress" && m.step === "making")).toBe(true);
    const end = finals(ch.messages);
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ type: "done", path: "study/quizzes/Logic.json", questions: 1 });
    expect(ch.messages[ch.messages.length - 1]).toBe(end[0]);
    const quiz = await call<{ questions: { prompt: string }[] }>("study_quiz", { space: "s", path: "study/quizzes/Logic.json" });
    expect(quiz.questions[0]!.prompt).toBe("If p is false, p → q is true.");
  });

  it("a bad space is one error event", async () => {
    const ch = channel<StudyEvent>();
    expect(await call("study_make_quiz", { space: "Bad", sources: [], options: {}, onEvent: ch })).toBeNull();
    expect(ch.messages).toEqual([{ type: "error", message: '"Bad" is not a valid space name' }]);
  });

  it.skipIf(!unix)("a chat block being made can be stopped, and nothing is saved", async () => {
    fs.rmSync(path.join(spaceDir("s"), "study/quizzes"), { recursive: true, force: true });
    fakeClaude([], true);
    const block = '{"kind":"quiz","title":"Stopped","count":1,"kinds":["truefalse"],"sources":["courses/CSCI-C 241"]}';
    const question = "quiz me on conditionals";
    const ch = channel<StudyEvent>();
    const making = call("study_chat_make", { space: "s", block, question, reply: "Here it is.", onEvent: ch });
    for (let i = 0; i < 200 && !fs.existsSync(path.join(bin, "count")); i++) await new Promise((r) => setTimeout(r, 25));
    const p = await call<{ running: boolean; origin: string }>("study_chat_plan", { space: "s", block, question });
    expect(p.running).toBe(true);
    expect(p.origin).toBe(origin(question, block));
    expect(await call("study_chat_cancel", { space: "s", origin: p.origin })).toBe(true);
    expect(await making).toBeNull();
    expect(finals(ch.messages)).toEqual([{ type: "cancelled" }]);
    expect(fs.existsSync(path.join(spaceDir("s"), "study/quizzes/Stopped.json"))).toBe(false);
    expect((await call<{ running: boolean }>("study_chat_plan", { space: "s", block, question })).running).toBe(false);
    expect(await call("study_chat_cancel", { space: "s", origin: p.origin })).toBe(false);
  });

  it("scope views and stated scopes", async () => {
    const visible = visibleFor("s");
    await build(visible, seenCourse(visible, "CSCI-C 241"), [], new Scripted([mapReply]), Date.now(), () => {});
    const v = await call<{ course: string; state: string; stated: unknown[] }>("study_scope", { space: "s", course: "CSCI-C 241" });
    expect([v.course, v.state]).toEqual(["courses/CSCI-C 241", "fresh"]);
    expect(await call("study_scope_state", { space: "s", course: "courses/CSCI-C 241", exam: "Test 1", text: "through HW 6" })).toBeNull();
    const after = await call<{ stated: { exam: string; text: string }[] }>("study_scope", { space: "s", course: "courses/CSCI-C 241" });
    expect(after.stated.map((x) => [x.exam, x.text])).toEqual([["Test 1", "through HW 6"]]);
    await expect(call("study_scope", { space: "s", course: "Secret" })).rejects.toThrow("That course isn’t one this space can see.");
    expect(fs.existsSync(path.join(vaultRoot(), ".phaethon/scope/CSCI-C 241.json"))).toBe(true);
  });
});
