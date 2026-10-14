// Making flashcards or a quiz is step by step (the shared wizard, ui/stepper.tsx). Behaviour checks: check(...) fails the run.
//   f14-make-quiz-keys   keyboard only: Step n of 5 with the step list, Enter is Next, a missing choice said in words with
//                        focus there, each heading focused, Back keeps what was typed, the review shows all of it, and
//                        nothing is made until Make the quiz; no step scrolls at 1100x720 (at 640x480 the courses and the review may, Next in view)
//   f14-make-discard     Escape on a fresh dialog closes it; with something chosen it asks (Keep going is focused,
//                        Escape keeps the work), and Discard closes without making anything
//   f14-make-deck-steps  flashcards have four steps (no kinds of question), and the review's Change goes straight back to a step
import { SETTINGS, check } from "../audit-fixtures.mjs";

const SHOWN = "[data-space-pane][data-shown]";
const D = "[data-make-dialog]";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (page, fn, arg, timeout = 4000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter((c) => c[0] === cmd).map((c) => c[1]), cmd);
const STUDY = {
  step: 60,
  courses: [
    { course: "CSCI-C 241 Discrete Structures", folder: "courses/C241" },
    { course: "MATH-M 212 Calculus II", folder: "courses/Calculus II" },
  ],
  decks: { "study/decks/Graph theory.md": { title: "Graph theory", course: "CSCI-C 241 Discrete Structures", cards: [{ front: "What is a tree?", back: "A connected graph with no cycles." }] } },
};
const MOCK = { settings: SETTINGS, threads: {}, study: STUDY };

/** Where the wizard is: its step, the label, the heading (and whether it has focus), the current item in the step list, and how far it scrolls. */
const at = (page) =>
  page.evaluate((D) => {
    const d = document.querySelector(D);
    if (!d) return null;
    const t = d.querySelector("[data-make-title]");
    const body = d.querySelector("[data-wizard-body]");
    return {
      step: d.querySelector("[data-make-form]")?.getAttribute("data-make-at") ?? d.getAttribute("data-phase"),
      label: d.querySelector("[data-step-label]")?.textContent ?? null,
      title: t?.textContent ?? "",
      focused: document.activeElement === t,
      described: t && document.getElementById(t.getAttribute("aria-describedby") ?? "")?.textContent,
      current: d.querySelector('[data-wizard-steps] [aria-current="step"]')?.getAttribute("data-wizard-step") ?? null,
      over: body ? body.scrollHeight - body.clientHeight : null,
      dialogOver: d.scrollHeight - d.clientHeight,
    };
  }, D);
/** Wait for `step` with its heading focused, and check what it says. */
async function expectStep(page, step, n, total) {
  const ok = await waitFor(page, ([D, s]) => document.querySelector(`${D} [data-make-form]`)?.getAttribute("data-make-at") === s && document.activeElement?.matches("[data-make-title]"), [D, step]);
  const s = await at(page);
  check(ok && s.label === `Step ${n} of ${total}` && s.current === step && /Step \d of \d/.test(s.described ?? ""), `step ${n} (${step}): “Step ${n} of ${total}”, marked current, heading focused and described by it`, JSON.stringify(s));
  return s;
}
// At the default text size every step fits; with larger text (--scale) a step may scroll, and the dialog with it when even
// its header and footer don't fit: then nothing may be cut off (the dialog scrolls to all of it).
const textScale = (page) => page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue("--ph-text-scale")) || 1);
const fits = async (page, s, what) =>
  (await textScale(page)) > 1
    ? check(await page.$eval("[role=dialog]", (d) => getComputedStyle(d).overflowY === "auto"), `${what}: with large text the dialog scrolls to all of it`)
    : check(s.over <= 1 && s.dialogOver <= 1, `${what}: the step fits without scrolling`, JSON.stringify({ over: s.over, dialog: s.dialogOver }));
const tabTo = async (page, sel, max = 40) => {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate((s) => !!document.activeElement?.matches(s), sel)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached ${sel}`);
};
async function openMake(page, kind) {
  await page.waitForSelector(`${SHOWN} [data-view-tab="study"]`, { timeout: 5000 });
  await page.click(`${SHOWN} [data-view-tab="study"]`);
  await page.waitForSelector(`${SHOWN} [data-study-hub] [data-make="${kind}"]`, { timeout: 5000 });
  await page.focus(`${SHOWN} [data-study-hub] [data-make="${kind}"]`);
  await page.keyboard.press("Enter");
  await page.waitForSelector(`[data-make-dialog="${kind}"]`, { timeout: 3000 });
  await sleep(300);
}

export default [
  {
    name: "f14-make-quiz-keys",
    sizes: [[1100, 720], [640, 480]],
    mock: MOCK,
    async run(page, h) {
      await openMake(page, "quiz");
      let s = await at(page);
      check(s.label === "Step 1 of 5" && s.current === "sources", "it opens on step 1 of 5: the courses", JSON.stringify(s));
      // Radix puts focus on the first field: a course's box.
      check(await page.evaluate(() => !!document.activeElement?.closest("[data-source-course]")), "focus starts on the first course");
      // Enter with nothing chosen: said in words, beside the courses, focus stays there.
      await page.keyboard.press("Enter");
      const err = await page.evaluate(() => ({ text: document.querySelector("[data-field-error]")?.textContent ?? "", focus: !!document.activeElement?.closest("[data-source-course]") }));
      check(/Choose at least one course/.test(err.text) && err.focus, "Next with nothing chosen says what is missing, focus on the choices", JSON.stringify(err));
      check((await at(page)).step === "sources", "and stays on the step");
      await page.keyboard.press("Space");
      await h.shot("1-courses");
      // Courses are a list: in a small window it may scroll between the header and the footer, Next always in view.
      if (page.viewport().width >= 1100) await fits(page, await at(page), "courses");
      else if ((await textScale(page)) === 1) check(await page.$eval("[data-step-next]", (b) => b.getBoundingClientRect().bottom <= innerHeight), "Next stays in view while the courses scroll");
      await page.keyboard.press("Enter");
      // Which test (f16-exam has the whole of it): one course, so its tests; Enter on the heading takes everything so far.
      s = await expectStep(page, "exam", 2, 5);
      check(await waitFor(page, () => !!document.querySelector('[data-exam-choice=""]')?.checked), "everything so far is chosen to start with");
      await page.keyboard.press("Enter");
      s = await expectStep(page, "questions", 3, 5);
      await fits(page, s, "kinds of question");
      await h.shot("2-questions");
      // Every kind off: Next says so.
      await tabTo(page, '[data-quiz-kind="choice"]');
      for (const k of ["choice", "truefalse", "short"]) {
        await page.focus(`[data-quiz-kind="${k}"]`);
        await page.keyboard.press("Space");
      }
      await page.keyboard.press("Enter");
      check((await page.$eval("[data-field-error]", (e) => e.textContent)).includes("at least one kind"), "no kind of question: said in words");
      await page.focus('[data-quiz-kind="cloze"]');
      await page.keyboard.press("Space");
      await page.keyboard.press("Enter");
      s = await expectStep(page, "details", 4, 5);
      await fits(page, s, "focus and number");
      await tabTo(page, "[data-make-focus]");
      await page.keyboard.type("Test 1");
      await tabTo(page, "[data-make-count]");
      // Replace the number (its text selected, as a double-click or select-all would).
      const retype = async (v) => {
        await page.$eval("[data-make-count]", (e) => e.select());
        await page.keyboard.type(v);
      };
      await retype("99");
      await page.keyboard.press("Enter");
      const count = await page.evaluate(() => ({ text: document.querySelector("[data-field-error]")?.textContent ?? "", focus: document.activeElement?.matches("[data-make-count]") }));
      check(/from 3 to 60/.test(count.text) && count.focus, "a number out of range is said, focus on it", JSON.stringify(count));
      await retype("12");
      await h.shot("3-details");
      await page.keyboard.press("Enter");
      s = await expectStep(page, "review", 5, 5);
      // The quiz's review has a row per choice (seven): in a small window it scrolls between the header and the footer,
      // Make the quiz always in view, as the courses do.
      if (page.viewport().width >= 1100) await fits(page, s, "review");
      else if ((await textScale(page)) === 1) check(await page.$eval("[data-step-next]", (b) => b.getBoundingClientRect().bottom <= innerHeight), "Make the quiz stays in view while the review scrolls");
      const review = await page.$eval("[data-wizard-review]", (e) => e.innerText.replace(/\s+/g, " "));
      check(/CSCI-C 241 Discrete Structures \(all of it\)/.test(review) && /Fill in the blank/.test(review) && /12/.test(review) && /Test 1/.test(review) && /Test Everything so far/.test(review), "the review shows every choice", review);
      check((await calls(page, "study_make_quiz")).length === 0, "nothing is made before the last step");
      await h.shot("4-review");
      // Back keeps what was typed.
      await tabTo(page, "[data-step-back]");
      await page.keyboard.press("Enter");
      await expectStep(page, "details", 4, 5);
      const kept = await page.evaluate(() => ({ focus: document.querySelector("[data-make-focus]").value, count: document.querySelector("[data-make-count]").value }));
      check(kept.focus === "Test 1" && kept.count === "12", "Back keeps what was typed", JSON.stringify(kept));
      await page.keyboard.press("Enter");
      await expectStep(page, "review", 5, 5);
      // Enter on the review makes it.
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => !!document.querySelector("[data-make-done]"), null, 5000), "Make the quiz makes it");
      const sent = (await calls(page, "study_make_quiz"))[0];
      check(sent?.options.count === 12 && sent.options.focus === "Test 1" && sent.options.kinds.join() === "cloze" && !("exam" in sent.options), "the core gets what was chosen (no test: no exam)", JSON.stringify(sent?.options));
      check(await waitFor(page, () => document.activeElement?.matches("[data-make-title]")), "the result's heading has focus");
    },
  },
  {
    name: "f14-make-discard",
    sizes: [[1100, 720]],
    mock: MOCK,
    async run(page, h) {
      await openMake(page, "deck");
      // Nothing entered yet: Escape just closes.
      await page.keyboard.press("Escape");
      check(await waitFor(page, () => !document.querySelector("[data-make-dialog]")), "Escape on an untouched dialog closes it");
      await openMake(page, "deck");
      await page.keyboard.press("Space");
      await page.keyboard.press("Escape");
      check(await waitFor(page, () => document.activeElement?.matches("[data-wizard-keep]")), "with a course chosen, Escape asks first, Keep going focused");
      const ask = await page.$eval("[data-wizard-discard]", (e) => ({ role: e.getAttribute("role"), text: e.innerText.replace(/\s+/g, " ") }));
      check(ask.role === "alertdialog" && /Discard these flashcards\?/.test(ask.text), "an alert dialog that says what would be lost", JSON.stringify(ask));
      await h.shot("asking");
      await page.keyboard.press("Escape");
      check(await waitFor(page, () => !document.querySelector("[data-wizard-discard]") && !!document.querySelector("[data-make-dialog]")), "Escape there keeps the work");
      check(await page.evaluate(() => document.querySelector("[data-source-course] input")?.checked), "with the course still chosen");
      // Cancel asks too; Discard closes, nothing made.
      await page.click("[data-wizard-cancel]");
      await page.waitForSelector("[data-wizard-discard-confirm]", { timeout: 3000 });
      await page.click("[data-wizard-discard-confirm]");
      check(await waitFor(page, () => !document.querySelector("[data-make-dialog]")), "Discard closes it");
      check((await calls(page, "study_make_deck")).length === 0, "and nothing was made");
      check(await waitFor(page, () => document.activeElement?.matches("[data-make]")), "focus goes back to what opened it", await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160)));
    },
  },
  {
    name: "f14-make-deck-steps",
    sizes: [[1100, 720], [640, 480]],
    mock: MOCK,
    async run(page, h) {
      await openMake(page, "deck");
      let s = await at(page);
      check(s.label === "Step 1 of 4", "flashcards: four steps", JSON.stringify(s));
      await page.keyboard.press("Space");
      await page.keyboard.press("Enter");
      await expectStep(page, "exam", 2, 4);
      await page.keyboard.press("Enter");
      await expectStep(page, "details", 3, 4);
      await page.keyboard.press("Enter");
      s = await expectStep(page, "review", 4, 4);
      await fits(page, s, "deck review");
      await h.shot("review");
      await page.click('[data-review-change="name"]');
      await expectStep(page, "details", 3, 4);
      check(await page.$("[data-make-name]"), "Change goes back to the step that has it");
    },
  },
];
