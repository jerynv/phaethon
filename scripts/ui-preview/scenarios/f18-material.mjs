// Feature round 18: what a course's documents are made of, and a model that can't look at pictures. Each import says it
// per course (typed, handwriting read by text recognition, pictures that can't be read as text), and so does Settings ›
// Course sites; where the material of a chosen test (or the course) leans on such pages and the space's model can't look
// at pictures, the make wizard's test step and review, and the chat card, say so plainly. A passage the model read from
// a page's picture says so where a question says where it comes from. The fake core is mock-ipc.js (lms L.material,
// study scopeViews[...].material, study planMaterial). Behaviour checks: check(...) fails the run.
//   f18-import-report    the import's last step: the course's report, its files one fold below, by keyboard
//   f18-settings-report  Settings › Course sites: each course's report under its name
//   f18-wizard-alert     the test step: the course's warning for everything so far, Test 1's for Test 1; the review repeats it
//   f18-wizard-sees      a model that can look at pictures: no warning anywhere
//   f18-card-alert       the chat card warns before anything is made
//   f18-picture-source   a question whose passage was read from a picture says so
//   f18-picture-card     so does a flashcard's, in the review session and the deck editor
import { SETTINGS, check } from "../audit-fixtures.mjs";

const SHOWN = "[data-space-pane][data-shown]";
const DIALOG = "[data-course-import]";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (page, fn, arg, timeout = 5000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const text = (page, sel) => page.evaluate((sel) => document.querySelector(sel)?.innerText.replace(/\s+/g, " ").trim() ?? null, sel);
const chord = async (page, keys) => {
  for (const k of keys) await page.keyboard.down(k);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
};
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// The owner's real C241 numbers (lms/material.rs over a copy of the vault's courses).
const HAND = (name, pages, known) => ({ path: `files/Notes/handwritten in-class notes/${name}`, handwriting: pages, unreadable: 0, pictures: 0, knownWords: known });
const C241_REPORT = {
  documents: 25,
  typedDocuments: 11,
  handwritingPages: 185,
  unreadablePages: 0,
  pictures: 0,
  readability: "fair",
  knownWords: 0.717,
  lines: ["185 pages are handwriting or scans: read with text recognition; expect some mistakes."],
  flagged: [HAND("notes c241 Fa26 - 20260915.pdf", 10, 0.59), HAND("notes c241 Fa26 - 20260917.pdf", 13, 0.67), HAND("notes c241 Fa26 - 20261008.pdf", 14, 0.805)],
};
const SYS_REPORT = {
  documents: 13,
  typedDocuments: 4,
  handwritingPages: 44,
  unreadablePages: 0,
  pictures: 17,
  readability: "good",
  knownWords: 0.961,
  lines: ["44 pages are handwriting or scans: read with text recognition; it reads well, but may contain mistakes.", "17 pictures (figures, diagrams or photos): they can’t be read as text."],
  flagged: [{ path: "files/Lectures/Chapter8.pdf", handwriting: 44, unreadable: 0, pictures: 0, knownWords: 0.961 }, { path: "files/Lectures/WK06_D01_stdlib.pdf", handwriting: 0, unreadable: 0, pictures: 10 }],
};
const BETTER = "A model that can read pictures (for example Claude, GPT-4o or newer, Gemini, or a vision model such as Llama 3.2 Vision in Ollama) would do better.";
const alert = (n, of) => ({ kind: "cantSee", text: `Your model can’t look at pictures, and ${n} pages of ${of} are handwriting or diagrams. Questions from those pages may have mistakes or be missed. ${BETTER}` });

// ---- Import and Settings -----------------------------------------------------------------------
const LMS = {
  step: 40,
  material: { 101: C241_REPORT, 103: SYS_REPORT },
  connections: {
    school: [{ id: "c1", kind: "canvas", address: "https://iu.instructure.com", schoolName: "Indiana University Bloomington", signedIn: true, lastSync: Date.UTC(2026, 9, 9, 18), courses: ["101", "103"] }],
  },
};

async function openImport(page) {
  await page.waitForSelector("[data-composer-input]", { timeout: 5000 });
  await page.focus("[data-composer-input]");
  await chord(page, ["Meta", "k"]);
  await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
  await page.keyboard.type("import courses");
  await page.keyboard.press("Enter");
  await page.waitForSelector(DIALOG, { timeout: 3000 });
}
const atStep = (page, s) => waitFor(page, ([D, s]) => document.querySelector(D)?.getAttribute("data-step") === s, [DIALOG, s]);

// ---- Study ---------------------------------------------------------------------------------------
const C241 = "courses/CSCI-C 241 Fall 2026 (All Sections)";
const NOTES = `${C241}/files/Notes/handwritten in-class notes/notes c241 Fa26 - 20260917.pdf`;
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const topic = (id, title, sections) => ({ id, title, sections, terms: [], weight: 2, homework: [], evidence: [] });
const MAP = {
  course: "CSCI-C 241 Fall 2026 (All Sections)",
  name: "CSCI-C 241 Discrete Structures",
  built: 1,
  topics: [topic("t1", "Sets", "2.1–2.5"), topic("t2", "Logic and proofs", "3.1–3.13"), topic("t3", "Graphs", "6.1–6.3")],
  notation: [],
  exams: [{ title: "Test 1", date: day(5), known: true, summary: "through HW 6; not graphs", includes: ["t1", "t2"], excludes: ["t3"], excludedWords: ["graphs"], homework: [], evidence: [], fromUser: false }],
  dropped: 0,
};
const material = (sees) => ({
  lines: C241_REPORT.lines,
  pages: 185,
  sight: sees ? { sees: "yes", model: "Claude Code", shown: true } : { sees: "no", model: "gpt-3.5-turbo", shown: false },
  ...(sees ? {} : { alert: alert(185, "this course") }),
  exams: [{ title: "Test 1", pages: 120, ...(sees ? {} : { alert: alert(120, "Test 1’s material") }) }],
});
const studyMock = (sees, extra = {}) => ({
  settings: SETTINGS,
  threads: {},
  study: {
    step: 60,
    courses: [{ course: "CSCI-C 241 Discrete Structures", folder: C241 }],
    scopeViews: { [C241]: { course: C241, name: "CSCI-C 241 Discrete Structures", state: "fresh", map: MAP, stated: [], material: material(sees) } },
    ...extra,
  },
});

async function toExamStep(page) {
  await page.waitForSelector(`${SHOWN} [data-view-tab="study"]`, { timeout: 5000 });
  await page.click(`${SHOWN} [data-view-tab="study"]`);
  await page.waitForSelector(`${SHOWN} [data-study-hub] [data-make="quiz"]`, { timeout: 5000 });
  await page.click(`${SHOWN} [data-study-hub] [data-make="quiz"]`);
  await page.waitForSelector("[data-make-dialog]", { timeout: 3000 });
  await sleep(300);
  // With one course it starts chosen.
  if (!(await page.$eval(`[data-source-course="${C241}"] input`, (i) => i.checked))) await page.click(`[data-source-course="${C241}"] input`);
  await page.click("[data-step-next]");
  check(await waitFor(page, () => document.querySelector("[data-make-form]")?.getAttribute("data-make-at") === "exam" && !document.querySelector("[data-exam-loading]")), "on to the test step", await page.evaluate(() => JSON.stringify({ at: document.querySelector("[data-make-form]")?.getAttribute("data-make-at"), loading: !!document.querySelector("[data-exam-loading]"), err: document.querySelector("[data-field-error]")?.textContent, body: document.querySelector("[data-make-dialog]")?.innerText.slice(0, 400) })));
  await sleep(150);
}
const nextTo = async (page, step) => {
  await page.click("[data-step-next]");
  return waitFor(page, (s) => document.querySelector("[data-make-form]")?.getAttribute("data-make-at") === s, step);
};

// ---- Chat card -----------------------------------------------------------------------------------
const BLOCK = { kind: "quiz", title: "Test 1 practice", exam: "Test 1", count: 4, kinds: ["choice"], difficulty: "exam", sources: [C241] };
const cardThread = () => [
  { role: "user", text: "Make me a practice test for Test 1.", attachments: [] },
  { role: "assistant", text: `I’ll make a 4-question practice test for **Test 1** from your C241 notes.\n\n\`\`\`phaethon-study\n${JSON.stringify(BLOCK)}\n\`\`\``, attachments: [] },
];

export default [
  {
    name: "f18-import-report",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {}, lms: LMS },
    async run(page, h) {
      await openImport(page);
      await page.click('[data-existing-site="c1"]');
      await page.waitForSelector("[data-course-list]", { timeout: 3000 });
      await page.click('[data-course="101"]');
      await page.click("[data-step-next]");
      await atStep(page, "viewers");
      await page.click("[data-step-next]");
      await atStep(page, "review");
      await page.click("[data-import-start]");
      check(await waitFor(page, () => document.querySelector("[data-step-title]")?.textContent === "Import finished", undefined, 8000), "the import finishes");
      const r = await text(page, '[data-import-course="101"] [data-material]');
      check(r?.startsWith("185 pages are handwriting or scans: read with text recognition; expect some mistakes."), "the course's report, in words", r);
      check((await page.$eval('[data-import-course="101"] [data-material]', (e) => e.getAttribute("data-material"))) === "flagged", "flagged");
      // Which files, one fold below, opened by keyboard.
      await page.focus('[data-import-course="101"] [data-material] summary');
      await page.keyboard.press("Enter");
      const files = await page.$$eval('[data-import-course="101"] [data-material-files] li', (els) => els.map((e) => e.textContent));
      check(files.length === 3 && files[0] === "notes c241 Fa26 - 20260915.pdf: 10 pages of handwriting or scans (59% of words recognised as the course’s own)", "each file and what it holds", JSON.stringify(files));
      check(await fits(page), "nothing scrolls sideways");
      await h.shot("report");
    },
  },
  {
    name: "f18-settings-report",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {}, lms: { ...LMS, list: LMS.connections.school }, courseAccess: { school: { "c1/101": ["overview", "files"], "c1/103": ["files"] } } },
    async run(page, h) {
      await page.waitForSelector("[data-composer-input]", { timeout: 5000 });
      await chord(page, ["Meta", ","]);
      await page.waitForSelector('[data-testid="settings-tab-courses"]', { timeout: 3000 });
      await page.$eval('[data-testid="settings-tab-courses"]', (el) => el.click());
      await page.waitForSelector('[data-access-course="c1/101"] [data-material]', { timeout: 3000 });
      const a = await text(page, '[data-access-course="c1/101"] [data-material] ul');
      const b = await text(page, '[data-access-course="c1/103"] [data-material] ul');
      check(a === "185 pages are handwriting or scans: read with text recognition; expect some mistakes.", "C241's report under its name", a);
      check(b?.includes("17 pictures (figures, diagrams or photos): they can’t be read as text."), "and the other course's, pictures included", b);
      check(await fits(page), "nothing scrolls sideways");
      await page.$eval('[data-access-course="c1/103"]', (e) => e.scrollIntoView({ block: "start" }));
      await h.shot("settings");
    },
  },
  {
    name: "f18-wizard-alert",
    sizes: [[1100, 720], [640, 480]],
    mock: studyMock(false),
    async run(page, h) {
      await toExamStep(page);
      const all = await page.$eval("[data-material-alert]", (e) => ({ kind: e.getAttribute("data-material-alert"), text: e.textContent }));
      check(all.kind === "cantSee" && all.text.startsWith("Your model can’t look at pictures, and 185 pages of this course are handwriting or diagrams."), "everything so far: the course's warning", JSON.stringify(all));
      await page.focus('[data-exam-choice=""]');
      await page.keyboard.press("ArrowDown");
      check(await waitFor(page, () => document.querySelector('[data-exam-choice="Test 1"]')?.checked && /120 pages of Test 1’s material/.test(document.querySelector("[data-material-alert]")?.textContent ?? "")), "Test 1: its own share", await text(page, "[data-material-alert]"));
      check(/would do better\.$/.test((await text(page, "[data-material-alert]")) ?? ""), "it says what would do better");
      await page.$eval("[data-material-alert]", (e) => e.scrollIntoView({ block: "nearest" }));
      await h.shot("exam");
      check(await nextTo(page, "questions"), "on");
      await nextTo(page, "details");
      check(await nextTo(page, "review"), "to the review");
      check(/120 pages of Test 1’s material/.test((await text(page, "[data-make-form] [data-material-alert]")) ?? ""), "the review repeats it before anything is made");
      check(await fits(page), "nothing scrolls sideways");
      await h.shot("review");
    },
  },
  {
    name: "f18-wizard-sees",
    sizes: [[1100, 720]],
    mock: studyMock(true),
    async run(page, h) {
      await toExamStep(page);
      check(!(await page.$("[data-material-alert]")), "a model that is shown the pages: no warning");
      await page.click('[data-exam-choice="Test 1"]');
      await sleep(100);
      check(!(await page.$("[data-material-alert]")), "for Test 1 either");
      await h.shot("sees");
    },
  },
  {
    name: "f18-card-alert",
    sizes: [[1100, 720], [640, 480]],
    mock: { ...studyMock(false, { planMaterial: alert(120, "Test 1’s material") }), threads: { school: cardThread() } },
    async run(page, h) {
      const card = `${SHOWN} [data-study-action]`;
      await page.waitForSelector(card, { timeout: 6000 });
      check(await waitFor(page, (c) => document.querySelector(c)?.getAttribute("data-study-action") === "ready", card), "the card is ready");
      const a = await text(page, `${card} [data-material-alert]`);
      check(a?.startsWith("Your model can’t look at pictures, and 120 pages of Test 1’s material are handwriting or diagrams."), "the card warns before anything is made", a);
      check(await fits(page), "nothing scrolls sideways");
      await page.$eval(card, (e) => e.scrollIntoView({ block: "end" }));
      await h.shot("card");
    },
  },
  {
    name: "f18-picture-source",
    sizes: [[1100, 720]],
    mock: studyMock(true, {
      quizzes: {
        "study/quizzes/Rules.json": {
          title: "Rules",
          course: "CSCI-C 241 Discrete Structures",
          sources: [NOTES],
          created: Date.now(),
          questions: [
            {
              id: "q1",
              kind: "truefalse",
              prompt: "Weakening: from X you may conclude “X or Y”.",
              choices: ["true", "false"],
              answer: "true",
              explanation: "That is the rule as the notes give it.",
              source: NOTES,
              topic: "Proof rules",
              citations: [{ source: NOTES, quote: "If you know that X is true, you can conclude that either X or Y is true.", at: "p. 3", picture: 3 }],
            },
          ],
        },
      },
    }),
    async run(page, h) {
      await page.waitForSelector(`${SHOWN} [data-view-tab="study"]`, { timeout: 5000 });
      await page.click(`${SHOWN} [data-view-tab="study"]`);
      await page.waitForSelector(`${SHOWN} [data-take-quiz]`, { timeout: 4000 });
      await page.click(`${SHOWN} [data-take-quiz]`);
      await page.waitForSelector(`${SHOWN} [data-question="q1"] [data-provenance]`, { timeout: 4000 });
      const from = await text(page, `${SHOWN} [data-question="q1"] [data-provenance] p`);
      check(from === "From: notes c241 Fa26 - 20260917 p. 3 (read from a picture of the page)", "a passage read from a picture says so", from);
      await h.shot("source");
    },
  },
  {
    name: "f18-picture-card",
    sizes: [[1100, 720], [640, 480]],
    mock: studyMock(true, {
      decks: {
        "study/decks/Rules.md": {
          title: "Rules",
          course: "CSCI-C 241 Discrete Structures",
          sources: [NOTES],
          cards: [
            { front: "What may you conclude from X by weakening?", back: "X or Y, for any Y.", source: NOTES, quote: "If you know that X is true, you can conclude that either X or Y is true.", picture: 3 },
            { front: "What is a typed card?", back: "One from a typed page.", source: NOTES, quote: "Typed words from the notes." },
          ],
        },
      },
    }),
    async run(page, h) {
      const PICTURED = "From: notes c241 Fa26 - 20260917 p. 3 (read from a picture of the page)";
      await page.waitForSelector(`${SHOWN} [data-view-tab="study"]`, { timeout: 5000 });
      await page.click(`${SHOWN} [data-view-tab="study"]`);
      // The deck editor: each card says where it comes from, as a question does.
      await page.waitForSelector(`${SHOWN} [data-open-deck="study/decks/Rules.md"]`, { timeout: 4000 });
      await page.click(`${SHOWN} [data-open-deck="study/decks/Rules.md"]`);
      await page.waitForSelector(`${SHOWN} [data-card-row] [data-provenance]`, { timeout: 4000 });
      const rows = await page.evaluate((S) => [...document.querySelectorAll(`${S} [data-card-row] [data-provenance] p`)].map((p) => p.textContent), SHOWN);
      check(rows.length === 2 && rows[0] === PICTURED && rows[1] === "From: notes c241 Fa26 - 20260917", "the deck editor says it per card", JSON.stringify(rows));
      check(await fits(page), "no sideways scroll");
      await h.shot("editor");
      await page.click(`${SHOWN} [data-back-to-study]`);
      // The review session: the answer's source line says the passage was read from a picture.
      await page.waitForSelector(`${SHOWN} [data-study-deck-row]`, { timeout: 4000 });
      await page.click(`${SHOWN} [data-study-deck-row]`);
      await page.waitForSelector(`${SHOWN} [data-card-front]`, { timeout: 4000 });
      await page.keyboard.press("Space");
      await page.waitForSelector(`${SHOWN} [data-card-back] [data-provenance]`, { timeout: 3000 });
      const first = await text(page, `${SHOWN} [data-card-back] [data-provenance] p`);
      check(first === PICTURED, "a card read from a picture says so in the review", first);
      await h.shot("review");
      await page.keyboard.press("4");
      await page.waitForFunction((S) => document.querySelector(`${S} [data-session-progress]`)?.textContent === "Card 2 of 2", { timeout: 3000 }, SHOWN);
      await page.keyboard.press("Space");
      await page.waitForSelector(`${SHOWN} [data-card-back] [data-provenance]`, { timeout: 3000 });
      const second = await text(page, `${SHOWN} [data-card-back] [data-provenance] p`);
      check(second === "From: notes c241 Fa26 - 20260917", "a typed card doesn't", second);
    },
  },
];
