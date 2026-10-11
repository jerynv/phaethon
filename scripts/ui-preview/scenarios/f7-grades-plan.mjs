// Grades, study plan and tutor modes (Grades-and-Plan team). Behaviour checks: check(...) fails the run.
//   f7-grades        each course's grade, trend, weights, items with their status in words, teacher's comments; what if
//   f7-refresh       Refresh grades streams, says what's new; signed out keeps the grades and offers Sign in again
//   f7-plan          add an exam (keyboard), the schedule spreads review before it, today's check-off and Save
//   f7-timer         the focus timer starts, moves to a break (said politely), and keeps going across views
//   f7-tutor         the composer's tutor mode: per space, said, saved; the palette's entries; Claude Code too
//   f7-fit           at 640x480 the views and the tutor menu fit
import { SETTINGS, check, park } from "../audit-fixtures.mjs";

const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const shown = "[data-space-pane][data-shown]";
const shellSaid = (page, re, timeout = 4000) =>
  page
    .waitForFunction((re) => new RegExp(re).test(document.querySelector("[data-shell-status]")?.textContent ?? ""), { timeout }, re.source)
    .then(() => true, () => false);
const shellStatus = (page) => page.evaluate(() => document.querySelector("[data-shell-status]")?.textContent ?? "");
const text = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, " ").trim());

/** Show a space's view with its tab in the space's view switcher. */
async function openView(page, view) {
  await page.click(`${shown} [data-view-tab="${view}"]`);
  await page.waitForSelector(`${shown} [data-${view}-view]`, { timeout: 5000 });
}

const LMS = {
  connections: {
    school: [{ id: "c1", kind: "canvas", address: "https://iu.instructure.com", schoolName: "Indiana University Bloomington", signedIn: true, courses: ["101", "102"] }],
  },
};
/** School's grades: two courses, weighted groups, late, missing, excused and ungraded items, comments. */
const day = (n) => new Date(Date.now() + n * 86400000).toISOString();
const it = (title, group, score, possible, extra = {}) => ({
  title, group, score, possible, percent: score != null && possible ? (score / possible) * 100 : undefined,
  due: day(extra.dueIn ?? -7), submitted: score != null, graded: score != null, late: false, missing: false, excused: false, comments: [], ...extra,
});
const GRADES = {
  school: [
    {
      connection: "c1", courseId: "101", course: "Discrete Structures for Computer Science", folder: "courses/Discrete Structures for Computer Science",
      updated: Date.now() - 3600000, current: { percent: 71.2, letter: "C-" },
      groups: [{ name: "Homework", weight: 30 }, { name: "Quizzes", weight: 20 }, { name: "Exams", weight: 50 }],
      items: [
        it("HW 1", "Homework", 9, 10, { dueIn: -35, comments: ["Nice proof by induction. Watch the base case next time."] }),
        it("HW 2", "Homework", 10, 10, { dueIn: -28 }),
        it("HW 3", "Homework", 7, 10, { dueIn: -21, late: true, comments: ["Submitted a day late: 10% off."] }),
        it("HW 4", "Homework", undefined, 10, { dueIn: -2, submitted: true }),
        it("HW 5", "Homework", undefined, 10, { dueIn: 5 }),
        it("Quiz 1", "Quizzes", 18, 20, { dueIn: -30 }),
        it("Quiz 2", "Quizzes", 0, 20, { dueIn: -16, missing: true, submitted: false }),
        it("Quiz 3", "Quizzes", undefined, 20, { dueIn: -9, excused: true, submitted: false }),
        it("Test 1", "Exams", undefined, 100, { dueIn: 5 }),
        it("Final exam", "Exams", undefined, 100, { dueIn: 60 }),
      ],
    },
    {
      connection: "c1", courseId: "102", course: "Calculus II", folder: "courses/Calculus II",
      updated: Date.now() - 86400000, current: { percent: 91.2, letter: "A-" },
      groups: [{ name: "Assignments" }, { name: "Exams" }],
      items: [it("Problem set 1", "Assignments", 46, 50, { dueIn: -20 }), it("Midterm", "Exams", 92, 100, { dueIn: -6 }), it("Problem set 2", "Assignments", undefined, 50, { dueIn: 3 })],
    },
  ],
};
const MOCK = {
  settings: SETTINGS,
  threads: {},
  lms: LMS,
  lmsGrades: GRADES,
  lmsGradesNewlyGraded: { course: "101", title: "HW 4", score: 8, comments: ["Good. Part (c) needed a counterexample."] },
};

async function setInput(page, sel, value) {
  await page.focus(sel);
  await page.$eval(sel, (el) => (el.value = ""));
  await page.keyboard.type(value);
}

export default [
  {
    name: "f7-grades",
    sizes: [[1100, 720]],
    mock: MOCK,
    async run(page, h) {
      await openView(page, "grades");
      await page.waitForSelector("[data-grades-course]", { timeout: 5000 });
      const cards = await page.$$eval("[data-grades-course] h3", (els) => els.map((e) => e.textContent));
      check(cards.length === 2 && cards[0] === "Discrete Structures for Computer Science", "a card per imported course", JSON.stringify(cards));
      const current = await text(page, '[data-grades-course="101"] [data-grades-current]');
      check(/71\.2% C-/.test(current) && /as your course site shows it/.test(current), "the course grade, percent and letter, from the site", current);
      check(/(Up|Down) [\d.]+ points after Quiz 2/.test(current), "and which way the latest graded item moved it", current);
      const groups = await text(page, '[data-grades-course="101"] [data-grades-groups]');
      check(/Homework 30% of the grade · average/.test(groups) && /Exams 50% of the grade · nothing graded/.test(groups), "groups with weights and averages", groups);
      const items = await text(page, '[data-grades-course="101"] [data-grades-items]');
      for (const w of ["Late", "Missing", "Excused", "Submitted, not graded yet", "Not graded yet", "9/10"]) check(items.includes(w), `item status in words: ${w}`, items.slice(0, 300));
      // Teacher's comments are folded under the item.
      const summary = await page.$('[data-grades-course="101"] [data-grades-items] summary');
      await summary.click();
      check((await text(page, '[data-grades-course="101"] [data-grades-items]')).includes("Watch the base case"), "a teacher's comment opens under its item");

      // What if, by keyboard.
      await page.focus('[data-what-if="101"] [data-what-if-toggle]');
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-what-if="101"] [data-what-if-score]', { timeout: 3000 });
      const projected0 = await text(page, '[data-what-if="101"] [data-what-if-projected]');
      await setInput(page, '[data-what-if="101"] [data-what-if-score="HW 5"]', "10");
      await setInput(page, '[data-what-if="101"] [data-what-if-score="Test 1"]', "90");
      const projected = await text(page, '[data-what-if="101"] [data-what-if-projected]');
      check(projected !== projected0 && /^\d+(\.\d)?% [A-D][+-]?$/.test(projected), "tried scores change the projected grade", `${projected0} -> ${projected}`);
      check(await shellSaid(page, /^With these scores: /), "and it is said once typing pauses", await shellStatus(page));
      const on = await page.$eval('[data-what-if="101"] [data-what-if-on]', (s) => s.selectedOptions[0].textContent);
      check(on === "Final exam", "What do I need? starts on the final exam", on);
      // HW 36/40, quizzes 18/40 (a missed 0), Test 1 90: 0.3*90 + 0.2*45 + 0.5*(90+x)/2.
      const answer = await text(page, '[data-what-if="101"] [data-what-if-answer]');
      check(answer === "B+ (87%) is out of reach through Final exam alone: even 100% there gives 83.5%.", "a B+ can't be reached, and it says what 100% gives", answer);
      await page.select('[data-what-if="101"] [data-what-if-target]', "B-");
      const a = await text(page, '[data-what-if="101"] [data-what-if-answer]');
      check(a === "You need at least 86% (86 out of 100) on Final exam for B- (80%).", "the score needed on the final for a B-", a);
      await setInput(page, '[data-what-if="101"] [data-what-if-score="HW 5"]', "-3");
      check(await page.$('[data-what-if="101"] [aria-invalid="true"]'), "a score that isn't one is marked, in words");
      await page.$eval('[data-what-if="101"]', (e) => e.scrollIntoView({ block: "start" }));
      await park(page);
      await h.shot("what-if");
      await page.$eval("[data-grades-view]", (e) => (e.scrollTop = 0));
    },
  },
  {
    name: "f7-refresh",
    sizes: [[1100, 720]],
    mock: MOCK,
    async run(page, h) {
      await openView(page, "grades");
      await page.waitForSelector("[data-grades-refresh]", { timeout: 5000 });
      check((await text(page, "[data-grades-refresh]")) === "Refresh grades", "one course site: Refresh grades");
      await page.click("[data-grades-refresh]");
      await page.waitForFunction(() => /Reading your grades from Indiana University Bloomington/.test(document.querySelector("[data-grades-status]")?.textContent ?? ""), { timeout: 3000 });
      check(true, "progress shows while it reads");
      await page.waitForFunction(() => /Grades updated/.test(document.querySelector("[data-grades-status]")?.textContent ?? ""), { timeout: 5000 });
      const said = await text(page, "[data-grades-status]");
      check(/New: HW 4 in Discrete Structures for Computer Science, 8\/10\./.test(said), "it says what's newly graded", said);
      check(await shellSaid(page, /^Grades updated from Indiana University Bloomington/), "and announces it", await shellStatus(page));
      const r = await calls(page, "lms_grades_refresh");
      check(r.length === 1 && r[0].space === "school" && r[0].connection === "c1", "lms_grades_refresh for this space's connection", JSON.stringify(r));
      check((await text(page, '[data-grades-course="101"] [data-grades-items]')).includes("8/10"), "the table shows the new score");

      await page.evaluate(() => (window.__MOCK__.lmsGradesSignedOut = true));
      await page.click("[data-grades-refresh]");
      await page.waitForSelector("[data-grades-signed-out]", { timeout: 5000 });
      check(await shellSaid(page, /signed out of Indiana University Bloomington/), "signed out is said", await shellStatus(page));
      check((await page.$$("[data-grades-course]")).length === 2, "the saved grades stay");
      const focus = await page.evaluate(() => document.activeElement?.hasAttribute("data-grades-signin"));
      check(focus, "focus goes to Sign in again");
      await park(page);
      await h.shot("signed-out");
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-signin-open]", { timeout: 5000 });
      check(true, "Sign in again opens the course import's sign-in step");
    },
  },
  {
    name: "f7-plan",
    sizes: [[1100, 720]],
    // Every day a study day, so today (whatever day it is) has room.
    mock: { ...MOCK, planState: { school: { studyDays: [0, 1, 2, 3, 4, 5, 6], sessionsPerDay: 3, sessionMinutes: 25, done: [] } } },
    async run(page, h) {
      await openView(page, "plan");
      await page.waitForSelector("[data-plan-upcoming] li", { timeout: 5000 });
      const up = await text(page, "[data-plan-upcoming]");
      check(/Reading: series/.test(up) && /Problem set 2/.test(up) && /HW 5/.test(up), "coming up from the imported courses", up.slice(0, 200));
      const today = await text(page, "[data-plan-today]");
      check(/Due today: Reading: series \(Calculus II\)/.test(today), "what's due today is in Today", today);
      check(/Work on Reading: series/.test(today), "with a work session for it", today);

      // Add an exam by keyboard.
      const date = await page.evaluate(() => {
        const d = new Date(Date.now() + 5 * 86400000);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      });
      await page.focus("[data-exam-add]");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-plan-exams] [role="alert"]', { timeout: 3000 });
      check(await page.evaluate(() => document.activeElement?.hasAttribute("data-exam-title")), "an empty name is said and focused");
      await page.keyboard.type("Test 1");
      await page.$eval("[data-exam-date]", (el, v) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, date);
      await page.select("[data-exam-course]", "Discrete Structures for Computer Science");
      await page.focus("[data-exam-add]");
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-plan-exams] [data-exam]", { timeout: 3000 });
      const set = await calls(page, "plan_exams_set");
      check(set.length === 1 && set[0].exams[0].title === "Test 1" && set[0].exams[0].date === date && set[0].exams[0].course === "Discrete Structures for Computer Science", "the exam is saved (plan_exams_set)", JSON.stringify(set));
      check(await shellSaid(page, /^Test 1 added for /), "and said", await shellStatus(page));
      const sched = await text(page, "[data-plan-schedule]");
      check(/Final review for Test 1/.test(sched) && /Review for Test 1/.test(sched), "the schedule spreads review sessions before it", sched.slice(0, 400));
      const perDay = await page.$$eval("[data-plan-days] > li", (els) => els.map((e) => e.querySelectorAll("[data-plan-session]").length));
      check(perDay.every((n) => n <= 3), "never more than 3 a day", JSON.stringify(perDay));

      // Fewer sessions a day: still within the limit.
      await page.select("[data-plan-per-day]", "1");
      await page.waitForFunction(() => [...document.querySelectorAll("[data-plan-days] > li")].every((e) => e.querySelectorAll("[data-plan-session]").length <= 1), { timeout: 3000 });
      const st = await calls(page, "plan_state_set");
      check(st.at(-1).planState.sessionsPerDay === 1, "the setting is kept (plan_state_set)", JSON.stringify(st.at(-1)));

      // Check off today's session.
      await page.click("[data-plan-today] input[type=checkbox]");
      await page.waitForFunction(() => window.__calls.filter(([c]) => c === "plan_state_set").at(-1)[1].planState.done.length === 1, { timeout: 3000 });
      check(await shellSaid(page, /: done\.$/), "checking off is said", await shellStatus(page));
      await page.click("[data-plan-save]");
      await page.waitForSelector("[data-plan-open]", { timeout: 3000 });
      const md = (await calls(page, "plan_save"))[0].markdown;
      check(md.startsWith("# Study plan") && /- \[x\] Work on Reading: series/.test(md) && /Test 1 \(Discrete Structures/.test(md), "Save writes the checklist as plan.md", md.slice(0, 300));
      await page.$eval("[data-plan-view]", (e) => (e.scrollTop = 0));
      await park(page);
    },
  },
  {
    name: "f7-timer",
    sizes: [[1100, 720]],
    mock: MOCK,
    async run(page, h) {
      await openView(page, "plan");
      await page.waitForSelector("[data-focus-timer]", { timeout: 5000 });
      check((await text(page, "[data-focus-clock]")).startsWith("25:00"), "25 minutes to start", await text(page, "[data-focus-clock]"));
      check(await page.$eval("[data-focus-clock]", (e) => e.getAttribute("role") === "timer" && e.getAttribute("aria-live") === "off"), "a timer that isn't read out every second");
      await page.click('[data-focus-toggle="start"]');
      await new Promise((r) => setTimeout(r, 2200));
      const c = await text(page, "[data-focus-clock]");
      check(/^24:5\d/.test(c), "it counts down", c);
      // Leave for Grades and come back: still running.
      await openView(page, "grades");
      await openView(page, "plan");
      check(await page.$('[data-focus-toggle="pause"]'), "it keeps running across views");
      await page.click("[data-focus-skip]");
      check(await shellSaid(page, /^Focus session done\. Take a 5-minute break\.$/), "the break is said politely", await shellStatus(page));
      check((await page.$eval("[data-focus-phase]", (e) => e.dataset.focusPhase)) === "short" && (await text(page, "[data-focus-rounds]")) === "1 focus session done", "a short break, one round done");
      await page.click("[data-focus-skip]");
      check(await shellSaid(page, /^Break over\./), "break over is said", await shellStatus(page));
      check(await page.$('[data-focus-toggle="start"]'), "the next focus waits for you");
      check((await page.$eval("[data-focus-sound]", (e) => e.checked)) === false, "no sound unless chosen");
      await page.$eval("[data-focus-timer]", (e) => e.scrollIntoView({ block: "start" }));
      await park(page);
    },
  },
  {
    name: "f7-tutor",
    sizes: [[1100, 720]],
    mock: { ...MOCK, tutorModes: { work: "cram" } },
    async run(page, h) {
      const btn = `${shown} [data-tutor-mode]`;
      await page.waitForSelector(btn, { timeout: 5000 });
      let b = await page.$eval(btn, (e) => ({ label: e.getAttribute("aria-label"), mode: e.dataset.mode, text: e.textContent.trim() }));
      check(b.mode === "normal" && b.label === "Tutor mode in School: Normal" && b.text === "", "normal: a quiet icon button with its name", JSON.stringify(b));
      await page.click(btn);
      await page.waitForSelector("[data-tutor-menu] [role=menuitemradio]", { timeout: 3000 });
      await h.idle();
      const opts = await page.$$eval("[data-tutor-menu] [role=menuitemradio]", (els) => els.map((e) => e.dataset.tutorOption));
      check(JSON.stringify(opts) === JSON.stringify(["normal", "quiz", "explain", "socratic", "cram"]), "five modes", JSON.stringify(opts));
      check(await page.evaluate(() => document.activeElement?.dataset.tutorOption === "normal"), "the menu opens on the mode in use");
      await park(page);
      await h.shot("menu");
      // (The pointer parked outside put focus on the menu itself, as Radix does.)
      await page.focus('[data-tutor-option="quiz"]');
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector("[data-tutor-menu]"), { timeout: 3000 });
      const sets = await calls(page, "space_tutor_mode_set");
      check(sets.length === 1 && sets[0].space === "school" && sets[0].mode === "quiz", "Quiz me is saved for School", JSON.stringify(sets));
      check(await shellSaid(page, /^Quiz me is on in School: one question at a time/), "and said", await shellStatus(page));
      b = await page.$eval(btn, (e) => ({ label: e.getAttribute("aria-label"), text: e.textContent.trim() }));
      check(b.text === "Quiz me" && b.label === "Tutor mode in School: Quiz me", "the button shows the mode is on", JSON.stringify(b));

      // Work keeps its own (cram, from its space.json).
      await page.keyboard.down("Meta");
      await page.keyboard.press("2");
      await page.keyboard.up("Meta");
      await page.waitForFunction(() => document.querySelector("[data-space-pane][data-shown]")?.dataset.spacePane === "work", { timeout: 5000 });
      check((await page.$eval(`${shown} [data-tutor-mode]`, (e) => e.dataset.mode)) === "cram", "Work shows its own mode, Exam cram");

      // The palette: Tutor mode: Socratic, in Work.
      await page.keyboard.down("Meta");
      await page.keyboard.press("k");
      await page.keyboard.up("Meta");
      await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
      await page.keyboard.type("socratic");
      await h.idle();
      const first = await page.$eval('[role="option"]', (e) => e.textContent);
      check(/Tutor mode: Socratic/.test(first), "the palette finds Tutor mode: Socratic", first);
      await page.keyboard.press("Enter");
      check(await shellSaid(page, /^Socratic is on in Work/), "and turns it on", await shellStatus(page));
      check((await calls(page, "space_tutor_mode_set")).at(-1).mode === "socratic", "saved for Work");
      await park(page);
    },
  },
  {
    name: "f7-tutor-cli",
    sizes: [[1100, 720]],
    mock: { ...MOCK, settings: { ...SETTINGS, backend: "claudeCli" }, tutorModes: { school: "socratic" } },
    async run(page) {
      const btn = `${shown} [data-tutor-mode]`;
      await page.waitForSelector(btn, { timeout: 5000 });
      check((await page.$eval(btn, (e) => e.dataset.mode)) === "socratic", "with Claude Code answering, the mode is shown and used too");
    },
  },
  {
    name: "f7-fit",
    sizes: [[640, 480]],
    sizesRequired: true,
    mock: MOCK,
    async run(page, h) {
      const overflow = (sel) => page.$eval(sel, (e) => e.scrollWidth - e.clientWidth);
      await page.click(`${shown} [data-tutor-mode]`);
      await page.waitForSelector("[data-tutor-menu]", { timeout: 3000 });
      const box = await page.$eval("[data-tutor-menu]", (e) => e.getBoundingClientRect().toJSON());
      check(box.left >= 0 && box.right <= 640 && box.top >= 0, "the tutor menu fits the window", JSON.stringify(box));
      await h.shot("tutor-menu");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("[data-tutor-menu]"), { timeout: 3000 });
      // Its tooltip (focus is back on the button) fades out before the next shot.
      await page.evaluate(() => document.activeElement?.blur());
      await page.waitForFunction(() => !document.querySelector('[data-slot="tooltip-content"]'), { timeout: 3000 });
      await openView(page, "grades");
      check((await overflow("[data-grades-view]")) <= 0, "Grades has no sideways scroll (the table scrolls in its own region)");
      await h.shot("grades");
      await openView(page, "plan");
      check((await overflow("[data-plan-view]")) <= 0, "Plan has no sideways scroll");
    },
  },
];
