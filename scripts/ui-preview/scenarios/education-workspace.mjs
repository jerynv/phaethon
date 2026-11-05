import { SETTINGS, check } from "../audit-fixtures.mjs";

const NAV = ":is(#spaces-sidebar:not([hidden]), [data-space-pane][data-shown])";
const C = "courses/Discrete mathematics";
const PATH = "study/quizzes/Functions.json";
const quiz = { title: "Functions", course: "Discrete mathematics", sources: [`${C}/notes.md`], created: 42, questions: [1, 2, 3].map((n) => ({ id: `q${n}`, kind: "choice", prompt: `Question ${n}: which function is injective?`, choices: ["f(x)=x", "f(x)=0"], answer: "f(x)=x", explanation: "Distinct inputs have distinct outputs." })) };
const spaces = [
  { id: "school", name: "School", description: "", hue: 240, educationEnabled: true },
  { id: "work", name: "Work", description: "", hue: 50, educationEnabled: false },
];
const grade = (id, name, percent) => ({ connection: "c1", courseId: id, course: name, folder: `courses/${name}`, updated: Date.now(), current: { percent }, groups: [{ name: "Assignments" }], items: [{ title: "Problem set", group: "Assignments", score: percent, possible: 100, percent, graded: true, submitted: true, late: false, missing: false, excused: false, comments: [] }] });

export default [
  {
    name: "education-course-quiz",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, spaces, threads: {}, study: { courses: [{ course: "Discrete mathematics", folder: C }], decks: {}, quizzes: { [PATH]: quiz } } },
    async run(page, h) {
      await page.waitForSelector(`${NAV} [data-view-tab="study"]`);
      await page.click(`${NAV} [data-view-tab="study"]`);
      await page.waitForSelector(`[data-open-course="${C}"]`);
      check(!(await page.$("[data-quiz-row]")), "Study overview shows courses before activities");
      await h.shot("study-courses");
      await page.click(`[data-open-course="${C}"]`);
      await page.waitForSelector(`[data-take-quiz="${PATH}"]`);
      check(!(await page.$('[data-study-due]')), "a course without flashcards has no disabled review action");
      await h.shot("study-course");
      await page.click(`[data-take-quiz="${PATH}"]`);
      await page.waitForSelector('[data-question="q1"]');
      await page.focus('[aria-label="Question layout"] [role="tab"]');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelectorAll('[data-question]').length === 3);
      await page.keyboard.press('Home');
      await page.waitForFunction(() => document.querySelectorAll('[data-question]').length === 1);
      check(await page.$eval('[data-go-question="q1"]', (node) => node.getAttribute('aria-current') === 'step' && getComputedStyle(node).borderStyle !== 'dotted'), "question layout uses keyboard tabs and current position has no focus-like border");
      check(await page.$eval('[data-quiz-next]', (button) => button.getBoundingClientRect().bottom <= button.closest('[data-space-view="study"]').getBoundingClientRect().bottom), "a standard single question keeps Next visible without scrolling");
      await h.shot("quiz-single");
      await page.click('[data-question="q1"] input');
      await page.click('[data-flag-question="q1"]');
      await page.click('[data-quiz-layout="all"]');
      check((await page.$$("[data-question]")).length === 3, "all-question mode shows every question");
      await page.click('[data-question="q2"] input');
      const before = await page.evaluate(() => window.__calls.filter(([name]) => name === "study_overview").length);
      await page.click(`${NAV} [data-view-tab="chat"]`);
      await page.click(`${NAV} [data-view-tab="study"]`);
      check((await page.$$("[data-question]")).length === 3, "layout survives tab changes");
      check(await page.$eval('[data-go-question="q1"]', (node) => node.hasAttribute("data-flagged")), "flag survives tab changes");
      check(await page.$eval('[data-question="q2"] input', (node) => node.checked), "answer survives tab changes");
      check(await page.evaluate((before) => window.__calls.filter(([name]) => name === "study_overview").length === before, before), "switching tabs does not reload Study");
      await page.click('[data-question-help="q2"]');
      await page.waitForFunction(() => document.querySelector('[data-space-pane="school"] [data-composer-input]')?.value.includes("Question 2"));
      const context = await page.$eval('[data-space-pane="school"] [data-composer-input]', (node) => node.value);
      check(context.includes("Discrete mathematics") && context.includes("My current answer") && context.includes("courses/Discrete mathematics/notes.md"), "AI help includes actual course, question, answer and sources");
      check(!context.includes("Distinct inputs have distinct outputs."), "AI help does not leak grading explanation");
      await page.click(`${NAV} [data-view-tab="study"]`);
      check(await page.$eval('[data-question="q2"] input', (node) => node.checked), "AI help preserves the quiz draft");
      await page.click('[data-back-to-study]');
      await page.waitForSelector(`[data-take-quiz="${PATH}"]`);
      await page.click(`[data-take-quiz="${PATH}"]`);
      await page.waitForSelector('[data-question="q2"]');
      check((await page.$$("[data-question]")).length === 3 && await page.$eval('[data-flag-question="q1"]', (node) => node.getAttribute("aria-pressed") === "true"), "quiz layout and flags restore after leaving the quiz");
      check(await page.$eval('[data-question="q2"] input', (node) => node.checked), "answers restore after leaving the quiz");
    },
  },
  {
    name: "education-grades-plan-courses",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, spaces, threads: {}, lmsGrades: { school: [grade("101", "Discrete mathematics", 84), grade("102", "Calculus", 92)] }, upcoming: { school: [{ course: "Discrete mathematics", folder: C, title: "Functions problem set", dueIn: 1, link: `${C}/assignments.md` }, { course: "Calculus", folder: "courses/Calculus", title: "Derivatives", dueIn: 2, link: "courses/Calculus/assignments.md" }, { course: "Discrete mathematics", folder: C, title: "Functions project", dueIn: 9, link: `${C}/assignments.md#project` }] } },
    async run(page, h) {
      await page.waitForSelector(`${NAV} [data-view-tab="grades"]`);
      await page.click(`${NAV} [data-view-tab="grades"]`);
      await page.waitForSelector('[data-grades-view] [data-course-grid]');
      check((await page.$$('[data-grades-view] [data-open-course]')).length === 2, "grades begins with compact course tiles");
      check(!(await page.$('[data-grades-course]')), "grade details wait for a selected course");
      await h.shot("grades-courses");
      await page.click('[data-grades-view] [data-open-course="c1:101"]');
      await page.waitForSelector('[data-grades-course="101"]');
      check(!(await page.$('[data-grades-course="102"]')), "grade detail shows only selected course");
      check(await page.$eval('[data-grades-current]', (node) => node.textContent.includes("84%")), "course score is shown");
      await h.shot("grades-course");
      await page.click(`${NAV} [data-view-tab="plan"]`);
      await page.waitForSelector('[data-plan-week]');
      check((await page.$$('[data-plan-week] button')).length === 7, "plan opens with a usable week strip");
      check(!(await page.$('[data-focus-timer]')), "timer occupies no agenda space until requested");
      await page.waitForFunction(() => document.querySelector('[data-plan-upcoming]')?.textContent.includes('Functions problem set'));
      check(await page.$eval('[data-plan-upcoming] li', (row) => row.getBoundingClientRect().bottom <= row.closest('[data-plan-view]').getBoundingClientRect().bottom), "the first agenda deadline is visible without scrolling");
      await h.shot("plan-agenda");
      await page.click('[aria-label="Next week"]');
      await page.waitForFunction(() => document.querySelector('[data-plan-upcoming]')?.textContent.includes('Functions project'));
      check(await page.$eval('[data-plan-upcoming]', (node) => !node.textContent.includes('Functions problem set') && !node.textContent.includes('Derivatives')), "Next week replaces the agenda with that week’s deadlines");
      await page.click('[aria-label="Previous week"]');
      await page.waitForFunction(() => document.querySelector('[data-plan-upcoming]')?.textContent.includes('Functions problem set'));
      check(await page.$eval('[data-plan-upcoming]', (node) => !node.textContent.includes('Functions project')), "Previous week restores the earlier agenda");
      await page.click('[data-plan-course-filter] [role=combobox]');
      await page.waitForSelector('[role=option]');
      await page.$$eval('[role=option]', items => items.find(e => e.textContent.trim() === 'Discrete mathematics').click());
      await page.waitForFunction(() => !document.querySelector('[data-plan-upcoming]')?.textContent.includes('Derivatives'));
      const agenda = await page.$eval('[data-plan-upcoming]', (node) => node.textContent);
      check(agenda.includes("Functions problem set") && !agenda.includes("Derivatives"), "course agenda excludes other classes");
      await h.shot("plan-course");
      await page.click('[data-plan-timer]');
      await page.waitForSelector('[data-focus-timer]');
      check(true, "timer opens on demand in a popover");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[data-focus-timer]'));
      check(!(await page.$('[data-focus-timer]')), "timer popover closes cleanly");
    },
  },
  {
    name: "education-disabled-space",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, spaces: [{ ...spaces[1], lastUsed: Date.now() }], threads: {} },
    async run(page) {
      await page.waitForSelector('[data-space-pane="work"]');
      check(!(await page.$('[data-view-tab="study"], [data-view-tab="grades"], [data-view-tab="plan"]')), "non-education space has no education destinations");
      await page.keyboard.down("Alt"); await page.keyboard.down("Meta"); await page.keyboard.press("2"); await page.keyboard.up("Meta"); await page.keyboard.up("Alt");
      check(!(await page.$('[data-study-hub]')), "education shortcut cannot open a disabled workspace");
    },
  },
];
