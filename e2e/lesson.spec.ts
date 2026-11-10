import fs from "node:fs";
import path from "node:path";
import { expect, startCore, test } from "./core.ts";

const check = {
  name: "check",
  input: {
    role: "check",
    question: "To prove f(x) = 3x − 7 is injective, what is the first line?",
    options: [
      { value: "a", label: "Let y be real; find x with f(x) = y." },
      { value: "b", label: "Suppose f(a) = f(b) for some real a, b." },
      { value: "c", label: "Check that f(0) ≠ f(1)." },
    ],
    explanation: "Injective means equal outputs force equal inputs, so start from f(a) = f(b). (a) starts a surjectivity proof; (c) checks one pair only.",
    correctAnswer: "b",
  },
};

test("a tutor-mode question waits for the student, survives a reload, and the answer continues the lesson", async ({ page }) => {
  const core = await startCore({
    script: {
      steps: [
        { text: "Let's check the first step before we write the proof.", tools: [check] },
        { text: "Right: starting from f(a) = f(b) is what injective asks for. Now subtract 7 from both sides." },
      ],
    },
    setup: (home) => {
      const dir = path.join(home, "Phaethon/default/spaces/school/.phaethon");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "space.json"), JSON.stringify({ name: "School", educationEnabled: true, tutorMode: "quiz" }, null, 2) + "\n");
    },
  });
  try {
    await core.open(page);
    const box = page.getByRole("textbox", { name: /message/i });
    await box.fill("Teach me how to prove a function is injective.");
    await box.press("Enter");
    const option = page.getByRole("radio", { name: /Suppose f\(a\) = f\(b\)/ });
    await expect(option).toBeVisible();
    // The question survives a reload with no answer key in the page.
    await page.reload();
    await expect(page.getByRole("radio", { name: /Suppose f\(a\) = f\(b\)/ })).toBeVisible();
    expect(await page.content()).not.toContain("correctAnswer");
    await page.getByRole("radio", { name: /Suppose f\(a\) = f\(b\)/ }).check();
    await page.getByRole("slider").first().focus();
    await page.keyboard.press("ArrowRight");
    await page.screenshot({ path: "test-results/lesson-question.png" });
    await page.getByRole("button", { name: /submit/i }).click();
    await expect(page.getByLabel("Phaethon replied").getByText("Now subtract 7 from both sides.")).toBeVisible();
    await expect(page.getByLabel("Phaethon replied").getByText("Right", { exact: true })).toBeVisible();
    // The model saw the student's answer, graded, as the tool result.
    const second = JSON.stringify(core.requests()[1] ?? {});
    expect(second).toMatch(/correct/);
    expect(core.requests()[0]).toMatchObject({ effort: "high" });
    await page.screenshot({ path: "test-results/lesson-continued.png" });
  } finally {
    await core.stop();
  }
});
