import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { STUDY_CHAT_PROMPT, STUDY_FENCE, scopePromptSection, studyPromptForCli, studyPromptSection } from "./prompt.ts";
import { ALL, fixture, put } from "./testing.ts";

const env = tempHome();
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());

describe("study prompt sections", () => {
  it("allow a check question in chat but route practice sets through a study block", () => {
    expect(STUDY_CHAT_PROMPT).toContain("```" + STUDY_FENCE + "\n{");
    expect(STUDY_CHAT_PROMPT).toContain("you may ask a quick check question");
    expect(STUDY_CHAT_PROMPT).toContain("Never write one in the chat yourself");
    expect(STUDY_CHAT_PROMPT).not.toContain("never write practice questions, a practice test, quiz questions or flashcards in the chat yourself, not even one or two");
  });

  it("is empty without courses or study files, and CLI backends get the same sections as Phaethon's own loop", () => {
    expect(studyPromptSection("work")).toBeNull();
    expect(scopePromptSection("work")).toBeNull();
    expect(studyPromptForCli("work")).toBe(STUDY_CHAT_PROMPT);

    fixture("school", [["CSCI-C 241", ALL]]);
    put("courses/CSCI-C 241/syllabus.md", "# Syllabus\n\nWe study logic.\n");
    fs.mkdirSync(path.join(spaceDir("school"), "study"), { recursive: true });
    fs.writeFileSync(path.join(spaceDir("school"), "study", "exams.json"), JSON.stringify([{ course: "CSCI-C 241", title: "Test 1", date: "2999-10-15" }]));

    const study = studyPromptSection("school")!;
    expect(study).toContain("study/decks/<Title>.md");
    expect(study).toContain("Upcoming exams: Test 1 (CSCI-C 241) on 2999-10-15.");
    const scope = scopePromptSection("school")!;
    expect(scope).toContain("## CSCI-C 241");
    expect(scope).toContain("Not mapped yet");

    const cli = studyPromptForCli("school");
    expect(cli.indexOf(scope)).toBe(0);
    expect(cli).toContain(study);
    expect(cli.endsWith(STUDY_CHAT_PROMPT)).toBe(true);
  });
});
