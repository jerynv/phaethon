// Feature round 16: which test a quiz or deck is for, chosen in the make wizard (study/make-dialog.tsx), after the
// courses. The step lists the course's tests (from its scope map, what the person said, and the plan's calendar),
// shows what the chosen one covers with what is not on it and the course's own words one fold below, asks what it
// covers when it wasn't found (kept for the course as the person's word), and the review says it. Behaviour checks:
// check(...) fails the run.
//   f16-exam-known      keyboard: Test 1's scope, what is not on it and where it says so; the review; exam goes to the core;
//                       progress says each step in words
//   f16-exam-unknown    a test whose scope wasn't found: Next asks, with focus in the answer; the answer is kept for the
//                       course and shown as the person's in the review and when coming back
//   f16-exam-unchecked  a course not mapped yet: it is looked for first; not found there, the dialog asks and makes it
//                       from the answer
//   f16-exam-many       two courses: a test belongs to one, so everything so far, and no exam is sent
import { SETTINGS, check } from "../audit-fixtures.mjs";

const SHOWN = "[data-space-pane][data-shown]";
const D = "[data-make-dialog]";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (page, fn, arg, timeout = 5000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter((c) => c[0] === cmd).map((c) => c[1]), cmd);
const text = (page, sel) => page.evaluate((sel) => document.querySelector(sel)?.innerText.replace(/\s+/g, " ").trim() ?? null, sel);

const C241 = "courses/CSCI-C 241 Fall 2026 (All Sections)";
const CALC = "courses/MATH-M 212 Calculus II";
const ANN = `${C241}/announcements.md`;
const SCOPE_QUOTE = "The test will cover everything up through and including HW 6.";
const EXCL_QUOTE = "Test 1 will not cover graphs or combinatorics.";
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const topic = (id, title, sections) => ({ id, title, sections, terms: [], weight: 2, homework: [], evidence: [] });
const MAP = {
  course: "CSCI-C 241 Fall 2026 (All Sections)",
  name: "CSCI-C 241 Discrete Structures",
  built: 1,
  topics: [topic("t1", "Sets", "2.1–2.5"), topic("t2", "Logic and proofs", "3.1–3.13"), topic("t3", "Functions", "5.1–5.4"), topic("t4", "Graphs", "6.1–6.3"), topic("t5", "Combinatorics", "7.1–7.2")],
  notation: [],
  exams: [
    {
      title: "Test 1",
      date: day(5),
      known: true,
      summary: "through HW 6; not graphs or combinatorics",
      includes: ["t1", "t2", "t3"],
      excludes: ["t4", "t5"],
      excludedWords: ["graphs", "combinatorics"],
      homework: [],
      evidence: [
        { source: ANN, quote: SCOPE_QUOTE },
        { source: ANN, quote: EXCL_QUOTE },
      ],
      fromUser: false,
    },
    { title: "Final", date: day(60), known: false, summary: "", includes: [], excludes: [], excludedWords: [], homework: [], evidence: [], fromUser: false },
  ],
  dropped: 0,
};
const COURSES = [
  { course: "CSCI-C 241 Discrete Structures", folder: C241 },
  { course: "MATH-M 212 Calculus II", folder: CALC },
];
const STUDY = {
  step: 70,
  courses: COURSES,
  // C241 is mapped as it is now; Calculus II isn't mapped yet.
  scopeViews: {
    [C241]: { course: C241, name: "CSCI-C 241 Discrete Structures", state: "fresh", map: MAP, stated: [] },
    [CALC]: { course: CALC, name: "MATH-M 212 Calculus II", state: "none", stated: [] },
  },
  unknownScopes: ["Midterm"],
};
// The plan's calendar: a C241 test the map doesn't know, and Calculus II's midterm.
const EXAMS = {
  school: [
    { id: "e1", title: "Test 2", course: "CSCI-C 241", date: day(30) },
    { id: "e2", title: "Midterm", course: "MATH-M 212 Calculus II", date: day(12) },
  ],
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const mock = () => ({ settings: SETTINGS, threads: {}, study: clone(STUDY), exams: clone(EXAMS) });

async function openMake(page, kind) {
  await page.waitForSelector(`${SHOWN} [data-view-tab="study"]`, { timeout: 5000 });
  await page.click(`${SHOWN} [data-view-tab="study"]`);
  await page.waitForSelector(`${SHOWN} [data-study-hub] [data-make="${kind}"]`, { timeout: 5000 });
  await page.focus(`${SHOWN} [data-study-hub] [data-make="${kind}"]`);
  await page.keyboard.press("Enter");
  await page.waitForSelector(`[data-make-dialog="${kind}"]`, { timeout: 3000 });
  await sleep(300);
}
/** Choose `folder` (all of it) on the first step and go on to the test step, its tests listed. */
async function toExamStep(page, folders) {
  for (const f of folders) await page.click(`[data-source-course="${f}"] input`);
  await page.click("[data-step-next]");
  const ok = await waitFor(page, () => document.querySelector("[data-make-form]")?.getAttribute("data-make-at") === "exam" && document.activeElement?.matches("[data-make-title]"));
  check(ok, "Next goes to the test step, its heading focused", await text(page, "[data-make-title]"));
  check((await text(page, "[data-step-label]")) === "Step 2 of 5" || (await text(page, "[data-step-label]")) === "Step 2 of 4", "the test is step 2", await text(page, "[data-step-label]"));
  await waitFor(page, () => !document.querySelector("[data-exam-loading]"));
}
const choices = (page) => page.$$eval("[data-exam-choice]", (els) => els.map((e) => e.closest("label").innerText.replace(/\s+/g, " ").trim()));
/** Next, and wait for `step`. */
async function nextTo(page, step) {
  await page.click("[data-step-next]");
  return waitFor(page, (s) => document.querySelector("[data-make-form]")?.getAttribute("data-make-at") === s, step);
}

export default [
  {
    name: "f16-exam-known",
    sizes: [[1100, 720], [640, 480]],
    mock: mock(),
    async run(page, h) {
      await openMake(page, "quiz");
      await toExamStep(page, [C241]);
      const list = await choices(page);
      check(
        list.length === 5 && list[0] === "Everything so far" && /^Test 1 \(\w+ \d+\)$/.test(list[1]) && /^Test 2 \(/.test(list[2]) && /^Final \(/.test(list[3]) && list[4] === "Another test",
        "the course's tests by date (the map's and the calendar's), everything so far first, another test last; not another course's",
        JSON.stringify(list),
      );
      check(await page.$eval('[data-exam-choice=""]', (e) => e.checked), "everything so far is chosen to start with");
      check(/anything CSCI-C 241 Discrete Structures has taught so far/.test((await text(page, '[data-exam-scope="everything"]')) ?? ""), "and says what that means");
      // By keyboard: into the radios, then down to Test 1.
      await page.focus('[data-exam-choice=""]');
      await page.keyboard.press("ArrowDown");
      check(await waitFor(page, () => document.activeElement?.matches('[data-exam-choice="Test 1"]') && document.activeElement.checked), "arrow down chooses Test 1");
      const known = await page.evaluate(() => {
        const r = document.activeElement;
        const panel = document.querySelector('[data-exam-scope="known"]');
        return {
          described: document.getElementById(r.getAttribute("aria-describedby") ?? "")?.textContent ?? "",
          off: panel?.querySelector("[data-exam-off]")?.textContent ?? "",
          text: panel?.innerText ?? "",
        };
      });
      check(/Test 1: through HW 6; not graphs or combinatorics\. Only that is used/.test(known.described), "Test 1's scope in words, and the choice is described by it", JSON.stringify(known));
      check(/Not on it: Graphs \(6\.1–6\.3\); Combinatorics \(7\.1–7\.2\)\./.test(known.off), "what isn't on it, by the course's topics", known.off);
      // Where it says so: the course's own words, one fold below.
      await page.click('[data-exam-scope="known"] details:last-of-type summary');
      const quotes = await page.$$eval('[data-exam-scope="known"] [data-scope-evidence="file"]', (els) => els.map((e) => e.innerText.replace(/\s+/g, " ")));
      check(quotes.length === 2 && quotes[0].includes(SCOPE_QUOTE) && quotes[1].includes(EXCL_QUOTE) && /Open announcements\.md/.test(quotes[0]), "where it comes from: the announcement's words, with the file a click away", JSON.stringify(quotes));
      await h.shot("known");
      // Enter on a radio is Next.
      await page.focus('[data-exam-choice="Test 1"]');
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => document.querySelector("[data-make-form]")?.getAttribute("data-make-at") === "questions"), "Enter goes on");
      check(await nextTo(page, "details"), "to the details");
      check(await nextTo(page, "review"), "to the review");
      const row = await text(page, '[data-review-item="exam"]');
      check(/Test Test 1: through HW 6; not graphs or combinatorics \(found in CSCI-C 241 Discrete Structures\)/.test(row ?? ""), "the review says the test and where its scope comes from", row);
      await h.shot("review");
      // Change goes back to it, the choice kept.
      await page.click('[data-review-change="exam"]');
      check(await waitFor(page, () => document.querySelector("[data-make-form]")?.getAttribute("data-make-at") === "exam" && document.querySelector('[data-exam-choice="Test 1"]')?.checked), "Change goes back to the test, still chosen");
      check(await nextTo(page, "questions"), "on again");
      await nextTo(page, "details");
      await nextTo(page, "review");
      await page.click("[data-make-submit]");
      // Each step in words, never a raw code.
      check(await waitFor(page, () => /Checking each question against your notes \(\d+ of 10\): \d+ kept, \d+ dropped so far/.test(document.querySelector("[data-make-step]")?.textContent ?? "")), "checking is said in words", await text(page, "[data-make-step]"));
      check(await waitFor(page, () => !!document.querySelector("[data-make-done]")), "it is made");
      const sent = (await calls(page, "study_make_quiz"))[0];
      check(sent?.options.exam === "Test 1" && JSON.stringify(sent.sources) === JSON.stringify([C241]), "the core is told the test", JSON.stringify(sent?.options));
      check((await calls(page, "study_scope_state")).length === 0, "nothing is said for a test whose scope was found");
    },
  },
  {
    name: "f16-exam-unknown",
    sizes: [[1100, 720], [640, 480]],
    mock: mock(),
    async run(page, h) {
      await openMake(page, "deck");
      await toExamStep(page, [C241]);
      await page.click('[data-exam-choice="Final"]');
      const unknown = await text(page, '[data-exam-scope="unknown"]');
      check(/I couldn’t find what Final covers in your CSCI-C 241 Discrete Structures materials, and I won’t guess/.test(unknown ?? "") && /What does Final cover\?/.test(unknown ?? ""), "not found: said, and asked", unknown);
      // Next without an answer: said beside it, focus in it.
      await page.click("[data-step-next]");
      const err = await page.evaluate(() => ({ text: document.querySelector("[data-field-error]")?.textContent ?? "", focus: document.activeElement?.matches("[data-exam-scope-text]"), invalid: document.activeElement?.getAttribute("aria-invalid") }));
      check(/Say what Final covers, in a few words\. Or choose everything so far\./.test(err.text) && err.focus && err.invalid === "true", "Next asks what it covers, focus in the answer", JSON.stringify(err));
      // In a small window the step scrolls: the answer and what is said beside it are both in view.
      const seen = await waitFor(page, () => {
        const body = document.querySelector("[data-wizard-body]").getBoundingClientRect();
        const e = document.querySelector("[data-field-error]").getBoundingClientRect();
        const f = document.querySelector("[data-exam-scope-text]").getBoundingClientRect();
        return f.top >= body.top - 1 && e.bottom <= body.bottom + 1;
      }, null, 2000);
      check(seen, "the answer and the problem with it are in view");
      await h.shot("asked");
      await page.keyboard.type("Chapters 1 to 9, not graphs");
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => document.querySelector("[data-make-form]")?.getAttribute("data-make-at") === "details"), "the answer takes it on");
      const said = await calls(page, "study_scope_state");
      check(said.length === 1 && said[0].course === C241 && said[0].exam === "Final" && said[0].text === "Chapters 1 to 9, not graphs", "the answer is kept for the course", JSON.stringify(said));
      await nextTo(page, "review");
      const row = await text(page, '[data-review-item="exam"]');
      check(/Final: Chapters 1 to 9, not graphs \(as you said\)/.test(row ?? ""), "the review says it is theirs", row);
      // Back at the test: now the person's word, kept in the field.
      await page.click('[data-review-change="exam"]');
      await waitFor(page, () => document.querySelector("[data-make-form]")?.getAttribute("data-make-at") === "exam");
      const back = await page.evaluate(() => ({ state: document.querySelector("[data-exam-scope]")?.getAttribute("data-exam-scope"), value: document.querySelector("[data-exam-scope-text]")?.value }));
      check(back.state === "stated" && back.value === "Chapters 1 to 9, not graphs", "coming back, it is theirs and in the field", JSON.stringify(back));
      await h.shot("stated");
      await nextTo(page, "details");
      check((await calls(page, "study_scope_state")).length === 1, "unchanged, it isn't saved again");
      await nextTo(page, "review");
      await page.click("[data-make-submit]");
      check(await waitFor(page, () => !!document.querySelector("[data-make-done]")), "it is made");
      check((await calls(page, "study_make_deck"))[0]?.options.exam === "Final", "for the Final");
    },
  },
  {
    name: "f16-exam-unchecked",
    sizes: [[1100, 720], [640, 480]],
    mock: mock(),
    async run(page, h) {
      await openMake(page, "quiz");
      await toExamStep(page, [CALC]);
      const list = await choices(page);
      check(list.length === 3 && /^Midterm \(/.test(list[1]), "Calculus II's test from the calendar", JSON.stringify(list));
      await page.click('[data-exam-choice="Midterm"]');
      const p = await text(page, '[data-exam-scope="unchecked"]');
      check(/Phaethon will first read your MATH-M 212 Calculus II materials to see what Midterm covers/.test(p ?? "") && /\(optional\)/.test(p ?? ""), "not looked for yet: said, and the answer is optional", p);
      await h.shot("unchecked");
      await nextTo(page, "questions");
      await nextTo(page, "details");
      await nextTo(page, "review");
      check(/Midterm: Phaethon looks for what it covers first/.test((await text(page, '[data-review-item="exam"]')) ?? ""), "the review says it is looked for first");
      await page.click("[data-make-submit]");
      check(await waitFor(page, () => /Reading MATH-M 212 Calculus II to see what it teaches and what Midterm covers \(part \d of 2\)/.test(document.querySelector("[data-make-step]")?.textContent ?? "")), "mapping is said in words", await text(page, "[data-make-step]"));
      // Not found there: the dialog asks, focus in the answer.
      check(await waitFor(page, () => !!document.querySelector("[data-make-error] [data-scope-form]") && document.activeElement?.closest("[data-scope-form]")), "not found: asked in the dialog, focus in the answer");
      const e = await text(page, "[data-make-error]");
      check(/I couldn’t find what Midterm covers/.test(e ?? "") && /What does Midterm cover\?/.test(e ?? ""), "in words", e);
      await h.shot("needs-scope");
      await page.keyboard.type("Series and sequences, sections 11.1 to 11.6");
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => !!document.querySelector("[data-make-done]"), null, 8000), "saved, it is made from that", JSON.stringify(await page.evaluate(() => window.__calls.filter((c) => /study_make|scope_state/.test(c[0])).map((c) => [c[0], c[1].options?.exam ?? c[1].text]))));
      const said = await calls(page, "study_scope_state");
      check(said.length === 1 && said[0].course === CALC && said[0].exam === "Midterm", "kept for Calculus II", JSON.stringify(said));
      const sent = await calls(page, "study_make_quiz");
      check(sent.length === 2 && sent.every((s) => s.options.exam === "Midterm"), "asked again for the Midterm", JSON.stringify(sent.map((s) => s.options)));
    },
  },
  {
    name: "f16-exam-many",
    sizes: [[1100, 720]],
    mock: mock(),
    async run(page, h) {
      await openMake(page, "deck");
      await toExamStep(page, [C241, CALC]);
      const t = await text(page, "[data-exam-many]");
      check(/A test belongs to one course/.test(t ?? "") && !(await page.$("[data-exam-choice]")), "two courses: a test belongs to one, nothing to choose", t);
      await h.shot("many");
      await nextTo(page, "details");
      await nextTo(page, "review");
      check(/Everything so far \(more than one course\)/.test((await text(page, '[data-review-item="exam"]')) ?? ""), "the review says so");
      await page.click("[data-make-submit]");
      check(await waitFor(page, () => !!document.querySelector("[data-make-done]")), "it is made");
      check(!("exam" in ((await calls(page, "study_make_deck"))[0]?.options ?? {})), "no exam is sent");
    },
  },
];
