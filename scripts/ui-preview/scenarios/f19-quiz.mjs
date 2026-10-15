// Feature round 19: a long quiz as it is really taken, one question at a time:
// Previous and Next, a numbered map to go to any question that says which have
// answers, Enter on a choice is Next. Choices are lettered; where a question
// comes from stays hidden until the results; answers are kept when the quiz is
// left and come back (the hub says so and continues it, at the first question
// without one), with Start over asking first; checking with some missing names
// them and goes to the first, never handing the quiz in on the way.
// Results: a strip of every verdict to jump from, all or only the ones to look
// at again, and each choice question with all its choices marked yours and
// right. Also: a doubled scope ("no …; not …") is said once, and a quoted
// string in a formula is upright text. f19-quiz-steady: in a short window a
// 25-question map keeps its lines as answers come in, and moving never leaves
// the map cut off at the top or the buttons below; answered numbers are filled,
// the one shown without an answer dotted; the chosen answer pressed again clears it. Each scenario throws when wrong.
import { SETTINGS, check } from "../audit-fixtures.mjs";

const SHOWN = "[data-space-pane][data-shown]";
const C = "courses/CSCI-C 241 Fall 2026 (All Sections)";
const NOTES = `${C}/files/Notes/Lecture Notes.pdf`;
const PATH = "study/quizzes/Test 1 review.json";
const cite = (at) => [{ source: NOTES, quote: "A set has no duplicate members and no order.", at }];
const Q = (n, prompt, choices, answer) => ({ id: `q${n}`, kind: "choice", prompt, choices, answer, explanation: `Because of ${n}.`, source: NOTES, topic: "sets", citations: cite(`§1.${n}`) });

const QUESTIONS = [
  Q(1, "Let $A=\\{2,2,5,\\{2\\}\\}$. Which describes its members?", ["Four: $2$, $2$, $5$, $\\{2\\}$", "Three: $2$, $5$, $\\{5\\}$", "Two: $2$ and $5$", "Three: $2$, $5$, $\\{2\\}$"], "Three: $2$, $5$, $\\{2\\}$"),
  Q(2, "What is $\\{x \\mid x > 2\\}$ in $U=\\{0,\\dots,5\\}$?", ["$\\{2,3,4,5\\}$", "$\\{3,4,5\\}$", "$\\{0,1,2\\}$"], "$\\{3,4,5\\}$"),
  Q(3, "Let $A=\\{1,2,4\\}$, $B=\\{2,3,4\\}$. What is $(A\\cup B)-(A\\cap B)$?", ["$\\{2,4\\}$", "$\\{1\\}$", "$\\{1,3\\}$"], "$\\{1,3\\}$"),
  Q(4, "Which is a proposition rather than an expression?", ["$2+3$", "$2 \\in A$", "$\\{1,2,3\\}$"], "$2 \\in A$"),
  Q(5, "Which translates “locked and no keys”?", ["$P \\land \\neg Q$", "$\\neg(P \\land Q)$", "$P \\lor \\neg Q$"], "$P \\land \\neg Q$"),
  Q(6, "If $P$ and $Q$ are true, what are $P\\lor Q$ and $P\\oplus Q$?", ["True and true", "True and false", "False and true"], "True and false"),
  Q(7, "For a set of strings $A$, $F(A)$ is its first member alphabetically. What is $F(\\{\"cat\",\"ant\",\"bee\"\\})$?", ['$\\{"ant"\\}$', '$"ant"$', '$"cat"$'], '$"ant"$'),
  Q(8, "How many members has $\\mathcal{P}(\\{1,2\\})$?", ["$2$", "$3$", "$4$"], "$4$"),
  { id: "q9", kind: "truefalse", prompt: "Every set is a subset of itself.", choices: ["True", "False"], answer: "True", explanation: "Each member is in it.", source: NOTES, citations: cite("§1.9") },
  Q(10, "Which relation on $\\{1,2\\}$ is reflexive?", ["$\\{(1,1)\\}$", "$\\{(1,1),(2,2)\\}$", "$\\{(1,2)\\}$"], "$\\{(1,1),(2,2)\\}$"),
];

const GROUNDING = {
  exam: "Test 1",
  scope: "October 15 or 16, 2026; through HW 6; no graphs or combinatorics; not graphs or combinatorics",
  fromUser: false,
  evidence: [{ source: `${C}/announcements.md`, quote: "Test 1 will not cover graphs or combinatorics." }],
  asked: 10,
  kept: 10,
  dropped: [],
  coverage: [{ topic: "sets", count: 10 }],
};
const QUIZ = { title: "Test 1 review", course: "CSCI-C 241 Fall 2026 (All Sections)", sources: [NOTES], created: 1791794676908, questions: QUESTIONS, grounding: GROUNDING };
const mock = () => ({ settings: SETTINGS, threads: {}, study: { step: 30, courses: [{ course: "CSCI-C 241 Fall 2026 (All Sections)", folder: C }], decks: {}, quizzes: { [PATH]: JSON.parse(JSON.stringify(QUIZ)) } } });

const waitFor = (page, fn, arg, timeout = 4000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, " ").trim() ?? "", sel);
// Chosen through the control itself, not a point on screen (the bottom bar may lie over it in a small window).
const shown = (page) => page.$eval("[data-question]", (q) => q.dataset.question);
/** Goes to question `q` by the map and chooses its `i`th choice. */
async function pick(page, q, i) {
  await page.$eval(`[data-go-question="${q}"]`, (b) => b.click());
  await page.waitForSelector(`[data-question="${q}"]`);
  await page.$eval(`[data-question="${q}"] label:nth-child(${i + 1}) input`, (el) => el.click());
}

async function openQuiz(page) {
  await page.waitForSelector(`${SHOWN} [data-view-tab="study"]`, { timeout: 5000 });
  await page.click(`${SHOWN} [data-view-tab="study"]`);
  await page.waitForSelector(`${SHOWN} [data-take-quiz="${PATH}"]`, { timeout: 3000 });
  await page.click(`${SHOWN} [data-take-quiz="${PATH}"]`);
  await page.waitForSelector("[data-quiz-form]", { timeout: 3000 });
}

export default [
  {
    name: "f19-quiz-take",
    sizes: [[1100, 720], [640, 480]],
    mock: mock(),
    async run(page, h) {
      await openQuiz(page);
      const scope = await text(page, "[data-scope-line]");
      check(scope === "Test 1: October 15 or 16, 2026; through HW 6; no graphs or combinatorics", "the scope says each part once", scope);
      const first = await text(page, '[data-question="q1"] label');
      check(first.startsWith("A."), "choices are lettered", first);
      check((await page.$$("[data-question]")).length === 1 && (await text(page, "[data-question-heading]")).startsWith("Question 1 of 10"), "one question at a time, with its number");
      check(!(await page.$("[data-question] [data-provenance], [data-question] [data-passage]")), "where a question comes from is hidden while answering");
      check(!!(await page.$("[data-quiz-prev][disabled]")), "Previous is off on the first question");
      // By keyboard: an arrow chooses, Enter goes on, its heading focused.
      await page.focus('[data-question="q1"] input');
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => document.querySelector("[data-question]")?.dataset.question === "q2" && document.activeElement?.matches("[data-question-heading]")), "Enter on a choice is Next, the next question's heading focused");
      check(await page.evaluate(() => window.__calls.filter(([c]) => c === "study_quiz_submit").length === 0), "and nothing is handed in");
      await page.click("[data-quiz-next]");
      await page.click("[data-quiz-prev]");
      check((await shown(page)) === "q2", "Previous goes back");
      // The map: which have answers, and any question in one press.
      const map = await page.$$eval("[data-go-question]", (bs) => bs.map((b) => `${b.getAttribute("aria-label")}${b.getAttribute("aria-current") ? " (here)" : ""}`));
      check(map.length === 10 && map[0] === "Question 1, answered" && map[1] === "Question 2, no answer yet (here)", "the map says which have answers and which is shown", JSON.stringify(map));
      await page.click('[data-go-question="q7"]');
      check(await waitFor(page, () => document.querySelector("[data-question]")?.dataset.question === "q7" && document.activeElement?.matches("[data-question-heading]")), "the map goes to question 7");
      const str = await page.$$eval('[data-question="q7"] .katex-html', (es) => es.map((e) => e.textContent).join(" "));
      check(str.includes("“cat”") && str.includes("“ant”"), "a quoted string in a formula is upright text in curly quotes", str);
      await page.click('[data-go-question="q9"]');
      const tf = await text(page, '[data-question="q9"] label');
      check(tf === "True", "true or false isn't lettered", tf);
      await page.click('[data-go-question="q10"]');
      check(!(await page.$("[data-quiz-next]")) && (await text(page, "[data-quiz-steps] [data-quiz-submit]")) === "Check my answers", "the last question offers Check my answers instead of Next");
      await h.shot("answering");
    },
  },
  {
    name: "f19-quiz-kept",
    sizes: [[1100, 720]],
    mock: mock(),
    async run(page, h) {
      await openQuiz(page);
      await pick(page, "q1", 3);
      await pick(page, "q2", 1);
      await pick(page, "q4", 0);
      await page.click("[data-back-to-study]");
      check(await waitFor(page, (p) => document.querySelector(`[data-quiz-row="${p}"] [data-last-score]`)?.textContent === "3 of 10 answered, not checked yet", PATH), "the hub says the quiz is begun", await text(page, `[data-quiz-row="${PATH}"] [data-last-score]`));
      const btn = await text(page, `[data-take-quiz="${PATH}"]`);
      check(btn.startsWith("Continue quiz"), "and continues it", btn);
      await page.click(`${SHOWN} [data-take-quiz="${PATH}"]`);
      await page.waitForSelector("[data-quiz-form]");
      check(await waitFor(page, () => document.querySelector("[data-answered]")?.textContent === "3 of 10 answered"), "the answers are back", await text(page, "[data-answered]"));
      const back = await page.evaluate(() => [...document.querySelectorAll("[data-question] input:checked")].map((i) => i.closest("[data-question]").dataset.question).join(","));
      check(back === "", "only the question on screen shows", back);
      check((await shown(page)) === "q3", "back at the first question without an answer");
      const done = await page.$$eval("[data-go-question][data-done]", (bs) => bs.map((b) => b.dataset.goQuestion).join(","));
      check(done === "q1,q2,q4", "the map shows the ones answered", done);
      check((await text(page, "[data-quiz-restored]")).includes("3 of 10"), "and it says so", await text(page, "[data-quiz-restored]"));
      // Start over asks first; Keep them keeps them.
      await page.click("[data-start-over]");
      check(await waitFor(page, () => document.activeElement?.matches("[data-keep-answers]")), "start over asks, focus on Keep them");
      await h.shot("start-over");
      await page.keyboard.press("Enter");
      check((await text(page, "[data-answered]")) === "3 of 10 answered", "Keep them keeps them");
      await page.click("[data-start-over]");
      await page.waitForSelector("[data-clear-answers]");
      await page.click("[data-clear-answers]");
      check(await waitFor(page, () => document.querySelector("[data-answered]")?.textContent === "0 of 10 answered"), "Clear them clears them");
      check(!(await page.$("[data-quiz-restored]")), "and the note goes");
      check(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("phaethon.quiz-draft:")).length === 0), "nothing is kept once cleared");
    },
  },
  {
    name: "f19-quiz-results",
    sizes: [[1100, 720], [640, 480]],
    mock: mock(),
    async run(page, h) {
      await openQuiz(page);
      // Right on all but 4 and 8 (wrong) and 10 (left empty).
      const right = { q1: 3, q2: 1, q3: 2, q5: 0, q6: 1, q7: 1, q9: 0 };
      for (const [q, i] of Object.entries(right)) await pick(page, q, i);
      await pick(page, "q4", 0);
      await pick(page, "q8", 1);
      await page.click("[data-quiz-submit]");
      check(await waitFor(page, () => !!document.querySelector("[data-unanswered]")), "missing one: asks first");
      const ask = await text(page, "[data-unanswered]");
      check(ask.includes("Question 10 has no answer.") && ask.includes("Go to question 10"), "naming it, with a way to it", ask);
      await page.click("[data-go-unanswered]");
      check(await waitFor(page, () => document.querySelector("[data-question]")?.dataset.question === "q10" && document.activeElement?.matches("[data-question-heading]")), "which goes there");
      await new Promise((r) => setTimeout(r, 200));
      check(!(await page.$("[data-quiz-results]")) && !(await page.$("[data-unanswered]")), "without handing the quiz in, and the question is put away");
      await page.click("[data-quiz-submit]");
      await page.waitForSelector("[data-submit-anyway]");
      await page.click("[data-submit-anyway]");
      await page.waitForSelector("[data-quiz-results]", { timeout: 4000 });
      check(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("phaethon.quiz-draft:")).length === 0), "checked answers aren't kept as a draft");
      const chips = await page.$$eval("[data-result-jump]", (as) => as.map((a) => a.getAttribute("aria-label")));
      check(chips.length === 10 && chips[3] === "Question 4: Not right" && chips[0] === "Question 1: Correct", "a strip with every question's verdict in words", JSON.stringify(chips));
      // Q4: yours and right marked, in words.
      const marks = await page.$$eval('[data-result="q4"] [data-choice-mark]', (ls) => ls.map((l) => l.getAttribute("data-choice-mark") + "|" + l.textContent.replace(/\s+/g, " ").trim()));
      check(marks.length === 3 && marks[0].startsWith("yours|A.") && marks[0].endsWith("Your answer") && marks[1].startsWith("right|B.") && marks[1].endsWith("Right answer") && marks[2].startsWith("|"), "every choice shown, yours and the right one said", JSON.stringify(marks));
      check((await text(page, '[data-result="q10"]')).includes("You left this one without an answer."), "an empty one says so");
      check(!!(await page.$('[data-result="q1"] [data-provenance]')), "where it comes from shows in the results");
      await h.shot("all");
      // Only the ones to look at again.
      await page.click('[data-result-filter="mistakes"]');
      const shown = await page.$$eval("[data-result]", (ls) => ls.map((l) => l.dataset.result).join(","));
      check(shown === "q4,q8,q10", "only the 3 to look at again", shown);
      check((await page.$eval('[data-result-filter="mistakes"]', (b) => b.getAttribute("aria-pressed"))) === "true", "the filter says it is on");
      await h.shot("mistakes");
      // Jumping to a correct one shows all again and focuses it.
      await page.click('[data-result-jump="q6"]');
      check(await waitFor(page, () => document.activeElement?.id === "quiz-result-q6"), "jumping focuses that result's heading");
      check(!!(await page.$('[data-result="q1"]')), "and shows all of them again");
      await page.click('[data-result-jump="q8"]');
      check(await waitFor(page, () => document.activeElement?.id === "quiz-result-q8"), "by keyboard or pointer");
    },
  },
  {
    name: "f19-quiz-steady",
    sizes: [[1000, 600]],
    sizesRequired: true,
    mock: (() => {
      const m = mock();
      const many = Array.from({ length: 25 }, (_, i) => Q(i + 1, `Question about sets number ${i + 1}: which of these holds for $A=\\{1,2\\}$?`, ["$1 \\in A$", "$3 \\in A$", "$\\{1\\} \\in A$"], "$1 \\in A$"));
      m.study.quizzes[PATH] = { ...QUIZ, questions: many, grounding: { ...GROUNDING, asked: 25, kept: 25 } };
      return m;
    })(),
    async run(page, h) {
      await openQuiz(page);
      const mapHeight = () => page.$eval("[data-question-map] ol", (e) => Math.round(e.getBoundingClientRect().height));
      const before = await mapHeight();
      const fits = () =>
        page.evaluate(() => {
          const view = document.querySelector("[data-question-map]").closest(".overflow-y-auto").getBoundingClientRect();
          const map = document.querySelector("[data-question-map]").getBoundingClientRect();
          const steps = document.querySelector("[data-quiz-steps]").getBoundingClientRect();
          return { ok: map.top >= view.top - 0.5 && steps.bottom <= view.bottom + 0.5, map: Math.round(map.top - view.top), steps: Math.round(view.bottom - steps.bottom) };
        });
      // Answered by keyboard, one after another, the way it is taken.
      for (let i = 1; i <= 24; i++) {
        await page.$eval(`[data-question="q${i}"] input`, (el) => el.focus());
        await page.keyboard.press("Space");
        await page.keyboard.press("Enter");
        await page.waitForSelector(`[data-question="q${i + 1}"]`);
        const f = await fits();
        check(f.ok, `after question ${i}, the whole map and the buttons show`, JSON.stringify(f));
      }
      const after = await mapHeight();
      check(after === before, "answers don't make the map wrap onto more lines", `${before} → ${after}`);
      await new Promise((r) => setTimeout(r, 300)); // colours settle
      const looks = await page.$$eval("[data-go-question]", (bs) => bs.map((b) => { const c = getComputedStyle(b); return `${b.dataset.done === undefined ? "open" : "done"}:${c.borderTopStyle}:${/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(c.backgroundColor) ? "none" : "fill"}`; }));
      check(looks.slice(0, 24).every((l) => l === "done:solid:fill") && looks[24] === "open:dotted:none", "answered numbers are filled, the one shown without an answer is dotted", JSON.stringify(looks.slice(22)));
      check(!(await page.$("[data-go-question] svg")), "no check beside a number");
      // Pressing the chosen answer again leaves the question open.
      await page.$eval('[data-question="q25"] input', (el) => el.click());
      check((await text(page, "[data-answered]")) === "25 of 25 answered", "all answered");
      await page.$eval('[data-question="q25"] input', (el) => el.click());
      check(await waitFor(page, () => document.querySelector("[data-answered]")?.textContent === "24 of 25 answered" && !document.querySelector('[data-question="q25"] input:checked')), "the chosen answer clicked again is cleared", await text(page, "[data-answered]"));
      check((await page.$eval('[data-go-question="q25"]', (b) => b.getAttribute("aria-label"))) === "Question 25, no answer yet", "and the map says so");
      await page.focus('[data-question="q25"] label:nth-child(2) input');
      await page.keyboard.press("Space");
      check((await text(page, "[data-answered]")) === "25 of 25 answered", "Space chooses");
      await page.keyboard.press("Space");
      check((await text(page, "[data-answered]")) === "24 of 25 answered", "and Space again clears it");
      await page.$eval('[data-go-question="q3"]', (b) => b.click());
      const f = await fits();
      check(f.ok, "going back by the map shows it whole", JSON.stringify(f));
      const shell = await page.evaluate(() => ({ html: getComputedStyle(document.documentElement).overscrollBehaviorY, body: getComputedStyle(document.body).overscrollBehaviorY, top: document.scrollingElement.scrollTop, digits: getComputedStyle(document.querySelector("[data-answered]")).fontVariantNumeric }));
      check(shell.html === "none" && shell.body === "none" && shell.top === 0, "the window itself never scrolls or bounces, only the view in it", JSON.stringify(shell));
      check(shell.digits === "tabular-nums", "digits are all one width", shell.digits);
      await h.shot("answered");
    },
  },
];
