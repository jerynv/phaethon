import fs from "node:fs";
import path from "node:path";
import { expect, startCore, test, type Core } from "./core";

/**
 * Study and Grades against the real core with the scripted model: making a
 * quiz for a test from the dialog (scope found in the course, with its
 * source), taking it one question at a time with keys, the results by
 * topic and a retake of the misses; and Grades putting what needs attention
 * above the full tables. The course is invented.
 */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

const COURSE = "Logic and Proof";
const SRC = `courses/${COURSE}/files/HW/Test 1 Review.pdf`;
const Q1 = "A conditional p → q is false only when p is true and q is false.";
const Q2 = "The power set of a set with n members has 2^n members.";
const QA = "Test 1 covers conditionals and power sets. It will not cover graphs.";

/** A vault whose "school" space sees one imported course, with grades. */
function vault(home: string, grades?: object) {
  const root = path.join(home, "Phaethon", "default");
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  put(SRC, "%PDF");
  put(`${SRC}.md`, `# Text of Test 1 Review.pdf\n\n${Q1}\n${Q2}\n`);
  put(`courses/${COURSE}/announcements.md`, `# Announcements\n\n## Test 1\n\n${QA}\n`);
  put(
    ".phaethon/lms.json",
    JSON.stringify({ connections: [{ id: "canvas-x", kind: "canvas", address: "https://canvas.example", signedIn: false, courses: { "1": { name: COURSE, folder: COURSE, files: {}, links: {}, due: [] } } }] }),
  );
  put(".phaethon/course-access.json", JSON.stringify({ school: { "canvas-x/1": ["overview", "syllabus", "assignments", "announcements", "files", "grades"] } }));
  put("spaces/school/.phaethon/space.json", JSON.stringify({ name: "School", educationEnabled: true }));
  if (grades) put(".phaethon/grades.json", JSON.stringify(grades));
}

const cite = (q: string) => [{ source: SRC, quote: q }];
const mapReply = JSON.stringify({
  topics: [
    { id: "t1", title: "Conditionals", terms: ["conditional"], weight: 3, evidence: [{ source: SRC, quote: Q1 }] },
    { id: "t2", title: "Power sets", terms: ["power set"], weight: 2, evidence: [{ source: SRC, quote: Q2 }] },
  ],
  exams: [{ title: "Test 1", includes: ["t1", "t2"], excludes: [], excludedWords: ["graphs"], summary: "conditionals and power sets", evidence: [{ source: `courses/${COURSE}/announcements.md`, quote: QA }] }],
});
const quizReply = JSON.stringify({
  title: "Test 1 practice",
  questions: [
    { topic: "t1", kind: "choice", prompt: "When is p → q false?", choices: ["p true, q false", "p false, q true", "both false", "both true"], answer: "p true, q false", explanation: "Only a true premise with a false conclusion fails.", citations: cite(Q1) },
    { topic: "t2", kind: "truefalse", prompt: "A set with 3 members has 6 subsets.", answer: false, explanation: "It has 2^3 = 8.", citations: cite(Q2) },
    { topic: "t1", kind: "truefalse", prompt: "If p is false, p → q is true.", answer: "true", explanation: "The only false case needs p true.", citations: cite(Q1) },
    { topic: "t2", kind: "cloze", prompt: "The power set of a set with n members has ___ members.", answer: "2^n", explanation: "One subset per in-or-out pattern.", citations: cite(Q2) },
  ],
});
const verdicts = JSON.stringify({ verdicts: [1, 2, 3, 4].map((i) => ({ id: `i${i}`, verdict: "yes", missing: "", answerOk: true })) });

test("make a quiz for a test from the dialog, take it with keys, and read the results", async ({ page }) => {
  core = await startCore({ script: { claude: true, steps: [{ text: mapReply }, { text: quizReply, delayMs: 3000 }, { text: verdicts }] }, setup: (home) => vault(home) });
  await core.open(page);
  await page.getByRole("list", { name: "Views" }).getByRole("button", { name: /^Study/ }).click();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: /Quiz from course/ }).click();
  const dialog = page.getByRole("dialog");

  // Step 1: the only course is chosen; the test isn't mapped yet, so its scope is looked up in place.
  await expect(dialog.getByRole("radiogroup", { name: "Course" }).getByRole("radio", { name: COURSE })).toBeChecked();
  await dialog.getByRole("textbox", { name: "Test name" }).fill("Test 1");
  await dialog.getByRole("button", { name: "Look it up" }).click();
  // Mapped: the scope comes from the course, with its source shown.
  const known = dialog.getByTestId("scope-known");
  await expect(known).toContainText("conditionals and power sets");
  await expect(known).toContainText("announcements.md");
  await dialog.getByRole("button", { name: "Next" }).click();

  // Step 2: size and kinds, then make it.
  await dialog.getByRole("textbox", { name: "Exact number" }).fill("4");
  await dialog.getByRole("switch", { name: /Fill in the blank/ }).click();
  await expect(dialog.getByRole("switch", { name: /Fill in the blank/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Make 4 questions" }).click();
  const progress = dialog.getByTestId("make-progress");
  await expect(progress).toBeVisible();
  await expect(progress.locator('[data-state="active"]')).toHaveCount(1);
  await expect(dialog.getByText("Made a quiz of 4 questions")).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText("For Test 1");
  await dialog.getByRole("button", { name: "Take the quiz" }).click();

  // One question at a time; keys answer and move on. (The question slides; wait for the one leaving to go.)
  const question = page.getByTestId("quiz-question");
  const settled = () => expect(question).toHaveCount(1);
  await expect(page.getByTestId("quiz-position")).toHaveText("1 of 4");
  await question.getByRole("radio", { name: /p true, q false/ }).click();
  await page.keyboard.press("s");
  await expect(question.getByRole("button", { name: /Sure/ })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("quiz-position")).toHaveText("2 of 4");
  await settled();
  await expect(question).toContainText("6 subsets");
  await page.keyboard.press("1"); // True: wrong
  await page.keyboard.press("f");
  await expect(question.getByRole("button", { name: "Flagged" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("quiz-position")).toHaveText("3 of 4");
  await settled();
  await page.keyboard.press("1"); // True: right
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("quiz-position")).toHaveText("4 of 4");
  await settled();
  await question.getByRole("textbox", { name: "Your answer" }).fill("2^n");
  await page.getByRole("button", { name: "Finish" }).click();

  // The check before grading lists the flagged question.
  const check = page.getByTestId("quiz-check");
  await expect(check).toContainText("4 of 4 answered");
  await expect(check).toContainText("Flagged for review");
  await check.getByRole("button", { name: "Check answers" }).click();

  // Results: score, per topic, what to go over with its source, and a retake of the miss.
  const results = page.getByTestId("quiz-results");
  await expect(results).toBeVisible();
  await expect(page.getByTestId("quiz-score")).toHaveText("75%");
  const topics = page.getByTestId("quiz-topics");
  await expect(topics).toContainText("Power sets");
  await expect(topics).toContainText("50%");
  await expect(topics).toContainText("Conditionals");
  const review = page.getByTestId("quiz-review");
  await expect(review).toContainText("6 subsets");
  await expect(review).toContainText("Test 1 Review.pdf");
  await results.getByRole("button", { name: "Retake 1 miss" }).click();
  await expect(page.getByTestId("quiz-position")).toHaveText("1 of 1");
  await expect(page.getByText("Retaking misses")).toBeVisible();
  await settled();
  await expect(question).toContainText("6 subsets");

  // The model the dialog used is the scripted one, asked three times (map, write, check).
  expect(core.requests().length).toBe(3);
});

test("a test the course doesn't scope is asked about in place, with its topics as suggestions", async ({ page }) => {
  const map = JSON.parse(mapReply);
  map.exams.push({ title: "Test 2", includes: [], excludes: [], excludedWords: [], summary: "", evidence: [] });
  const resolve = JSON.stringify({ includes: ["t2"], excludes: [], summary: "power sets" });
  const write = JSON.stringify({
    questions: [
      { topic: "t2", kind: "truefalse", prompt: "A set with 3 members has 6 subsets.", answer: false, explanation: "It has 2^3 = 8.", citations: cite(Q2) },
      { topic: "t2", kind: "choice", prompt: "How many subsets has a set with 3 members?", choices: ["8", "6", "3", "9"], answer: "8", explanation: "2^3.", citations: cite(Q2) },
    ],
  });
  const check = JSON.stringify({ verdicts: [1, 2].map((i) => ({ id: `i${i}`, verdict: "yes", missing: "", answerOk: true })) });
  core = await startCore({ script: { claude: true, steps: [{ text: JSON.stringify(map) }, { text: resolve }, { text: write }, { text: check }] }, setup: (home) => vault(home) });
  await core.open(page);
  await page.getByRole("list", { name: "Views" }).getByRole("button", { name: /^Study/ }).click();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: /Quiz from course/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Test name" }).fill("Test 2");
  await dialog.getByRole("button", { name: "Look it up" }).click();

  // The course doesn't say: no refusal, a question with the course's topics to tap.
  const ask = dialog.getByTestId("scope-ask");
  await expect(ask).toContainText("What does Test 2 cover?");
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(ask.getByRole("alert")).toContainText("Say what Test 2 covers");
  await ask.getByRole("button", { name: "Power sets" }).click();
  await expect(ask.getByRole("textbox")).toHaveValue("Power sets");
  await dialog.getByRole("button", { name: "Next" }).click();
  await dialog.getByRole("textbox", { name: "Exact number" }).fill("2");
  await dialog.getByRole("button", { name: "Make 2 questions" }).click();
  await expect(dialog.getByText("Made a quiz of 2 questions")).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText("For Test 2");
  // What was said is kept for the course, so the next quiz for Test 2 knows it.
  const scopeDir = path.join(core.home, "Phaethon", "default", ".phaethon", "scope");
  const said = fs.readdirSync(scopeDir).map((f) => fs.readFileSync(path.join(scopeDir, f), "utf8")).join("");
  expect(said).toContain("Power sets");
});

test("grades: what needs attention comes before the full tables, in order", async ({ page }) => {
  const now = Date.now();
  const at = (d: number) => new Date(now + d * 86_400_000).toISOString();
  const item = (title: string, extra: Record<string, unknown>) => ({ title, group: "Sets", possible: 10, submitted: false, graded: false, late: false, missing: false, excused: false, comments: [], ...extra });
  const items = [
    ...Array.from({ length: 30 }, (_, i) => item(`Weekly set ${i + 1}`, { score: 8, percent: 80, graded: true, submitted: true, due: at(-90 + i * 2) })),
    item("Set due later", { due: at(5) }),
    item("Set due tomorrow", { due: at(1) }),
    item("Set never handed in", { due: at(-4), missing: true, score: 0 }),
    item("Final exam", { group: "Exams", possible: 100, due: at(30) }),
  ];
  const grades = {
    courses: {
      "canvas-x/1": { connection: "canvas-x", courseId: "1", course: COURSE, folder: `courses/${COURSE}`, updated: now, current: {}, groups: [{ name: "Sets", weight: 50 }, { name: "Exams", weight: 50 }], items },
    },
  };
  core = await startCore({ setup: (home) => vault(home, grades) });
  await core.open(page);
  await page.getByRole("list", { name: "Views" }).getByRole("button", { name: /^Grades/ }).click();

  const due = page.getByTestId("grades-due");
  await expect(due).toBeVisible();
  // Soonest first; nothing graded or missing among them.
  const dueTitles = await due.getByRole("button").allTextContents();
  expect(dueTitles[0]).toContain("Set due tomorrow");
  expect(dueTitles[1]).toContain("Set due later");
  expect(dueTitles.join(" ")).not.toContain("Weekly set");
  await expect(page.getByTestId("grades-missing")).toContainText("Set never handed in");
  await expect(page.getByTestId("grades-levers").getByRole("button").first()).toContainText("Final exam");
  await expect(page.getByTestId("grades-courses")).toContainText(COURSE);

  // The attention panels sit above the fold; the long table starts below them.
  const fold = page.viewportSize()!.height;
  expect((await due.boundingBox())!.y).toBeLessThan(fold);
  expect((await page.getByTestId("grades-levers").boundingBox())!.y).toBeLessThan(fold);
  const table = page.getByTestId("grades-course");
  expect((await table.boundingBox())!.y).toBeGreaterThan((await due.boundingBox())!.y);

  // Tables sort and filter; a course collapses.
  // Score sorts highest first, then lowest first.
  await table.getByRole("button", { name: "Score" }).click();
  await table.getByRole("button", { name: "Score" }).click();
  await expect(table.locator("tbody tr").first()).toContainText("Set never handed in");
  await page.getByRole("searchbox", { name: "Filter assignments" }).fill("tomorrow");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await table.getByRole("button", { name: COURSE }).click();
  await expect(table.locator("table")).toHaveCount(0);
});
