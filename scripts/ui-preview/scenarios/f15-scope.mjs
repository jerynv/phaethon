// Feature round 15: what a quiz is made against, and where each question and
// claim comes from. A practice test for an exam shows that exam's scope (and
// where it was found) on the chat card and the quiz; making it says each step
// with how many questions were kept and dropped by the check against the notes;
// a quiz with fewer than asked says why; an exam whose scope wasn't found asks
// the person and uses their word; each question and card shows its source with
// the passage one fold below; a reply's [source: … "…"] citations are chips
// that say whether the words are in that file. The fake core is the f13 block
// (with its f15 hooks) and the "course scope and citations (f15)" block in
// mock-ipc.js. Each scenario throws when the behaviour is wrong.
import { SETTINGS, check } from "../audit-fixtures.mjs";

const SHOWN = "[data-space-pane][data-shown]";
const CARD = `${SHOWN} [data-study-action]`;
const waitFor = (page, fn, arg, timeout = 5000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const stateIs = (page, s) => waitFor(page, (s) => document.querySelector("[data-space-pane][data-shown] [data-study-action]")?.getAttribute("data-study-action") === s, s);
const cardState = (page) => page.evaluate((c) => document.querySelector(c)?.getAttribute("data-study-action") ?? null, CARD);

const C241 = "courses/CSCI-C 241 Fall 2026 (All Sections)";
const COURSES = [{ course: "CSCI-C 241 Discrete Structures", folder: C241 }];
const ANN = `${C241}/announcements.md`;
const NOTES = `${C241}/files/Notes/Wennstrom Lecture Notes - C241 Fa26.pdf`;
const HW6 = `${C241}/files/HW/HW 06 - C241 Fa26.pdf`;
const SCOPE_QUOTE = "The test will cover everything up through and including HW 6.";
const EXCL_QUOTE = "Test 1 will not cover graphs or combinatorics.";
const INJ = "A function f : A → B is injective if and only if for every x, y ∈ A, if f(x) = f(y), then x = y.";
const SUB = "A ⊆ B means that every member of A is also a member of B.";

const QUESTION = "Can you make me a practice test for Test 1 in C241?";
const BLOCK = { kind: "quiz", title: "Test 1 practice", exam: "Test 1", count: 4, kinds: ["choice", "truefalse"], difficulty: "exam", sources: [C241] };
const prose = "I’ll make a 4-question practice test for **Test 1** from your C241 materials: sets, logic, proofs, relations and functions, nothing past HW 6.";
const fence = (b = BLOCK) => `\n\n\`\`\`phaethon-study\n${JSON.stringify(b)}\n\`\`\``;
const thread = (reply = prose + fence()) => [
  { role: "user", text: QUESTION, attachments: [] },
  { role: "assistant", text: reply, attachments: [] },
];

const QUIZ = [
  {
    id: "q1",
    kind: "choice",
    prompt: "Which condition says that $f : A \\to B$ is injective?",
    choices: ["For every $x, y \\in A$, if $f(x) = f(y)$ then $x = y$", "For every $b \\in B$ there is an $a$ with $f(a) = b$", "$f(x) \\in B$ for every $x \\in A$", "$A = B$"],
    answer: "For every $x, y \\in A$, if $f(x) = f(y)$ then $x = y$",
    explanation: "That is the definition of injective in the notes.",
    source: NOTES,
    topic: "Properties of functions (5.3)",
    citations: [{ source: NOTES, quote: INJ, at: "§5.3" }],
  },
  {
    id: "q2",
    kind: "truefalse",
    prompt: "If $A \\subseteq B$, then every member of $A$ is a member of $B$.",
    choices: ["true", "false"],
    answer: "true",
    explanation: "That is what ⊆ means.",
    source: NOTES,
    topic: "Subsets (2.5)",
    citations: [{ source: NOTES, quote: SUB, at: "§2.5" }],
  },
  {
    id: "q3",
    kind: "truefalse",
    prompt: "A function from $\\{1,2,3,4\\}$ to $\\{1,2,3,4,5,6\\}$ can be onto.",
    choices: ["true", "false"],
    answer: "false",
    explanation: "Four inputs can reach at most four of the six outputs.",
    source: HW6,
    topic: "Properties of functions (5.3)",
    citations: [{ source: HW6, quote: "Is it possible for a function with this domain and codomain to be onto?", at: "#2" }],
  },
];

const GROUNDING = {
  exam: "Test 1",
  scope: "through HW 6; not graphs or combinatorics",
  fromUser: false,
  evidence: [
    { source: ANN, quote: SCOPE_QUOTE },
    { source: ANN, quote: EXCL_QUOTE },
  ],
  asked: 4,
  kept: 3,
  dropped: [
    { text: "What is the preimage of $\\{1\\}$ under $f$?", why: "not taught in your notes or not in scope: preimages are never defined" },
    { text: "Every tree with n vertices has n − 1 edges.", why: "its topic, Trees, isn’t in scope" },
  ],
  coverage: [
    { topic: "Subsets", sections: "2.5", count: 1 },
    { topic: "Properties of functions", sections: "5.3", count: 2 },
    { topic: "Relations", sections: "4.1–4.4", count: 0, why: "its questions didn’t pass the check" },
  ],
  notes: ["Only 3 of the 4 questions you asked for passed the check against your notes, so there are 3. The rest weren’t padded with others: 2 were dropped, mostly because they needed ideas your notes don’t teach."],
};

const PLAN_SCOPE = { exam: "Test 1", state: "known", words: "through HW 6; not graphs or combinatorics", fromUser: false, evidence: GROUNDING.evidence, course: C241, courseName: "CSCI-C 241 Discrete Structures" };
const STEPS = [
  ["mapping", 0, 2],
  ["mapping", 1, 2],
  ["mapping", 2, 2],
  ["reading", 1, 1],
  ["making", 0, 3],
  ["checking", 0, 5, 0, 1],
  ["checking", 5, 5, 3, 2],
  ["saving", 0, 1],
];
const STUDY = { courses: COURSES, step: 90, chatQuiz: QUIZ, chatGrounding: GROUNDING, chatSteps: STEPS, planScopes: { "Test 1": PLAN_SCOPE } };
const clone = (x) => JSON.parse(JSON.stringify(x));
const mock = (extra = {}, study = {}) => ({ settings: SETTINGS, threads: { school: thread() }, study: { ...clone(STUDY), ...study }, ...extra });

async function cardReady(page) {
  await page.waitForSelector(CARD, { timeout: 6000 });
  check(await stateIs(page, "ready"), "the card is ready to generate", await cardState(page));
}

const CITED_REPLY = [
  "Test 1 covers everything through HW 6 [source: " + ANN + ' "The test will cover everything up through and including HW 6."], and it leaves out graphs ',
  "[source: " + ANN + " “Test 1 will not cover graphs or combinatorics.”].",
  "",
  "For injective functions, use the course's definition [source: " + NOTES + ' "A function f : A → B is injective if and only if for every x, y ∈ A, if f(x) = f(y), then x = y."].',
  "",
  "Preimages are worth knowing too [source: " + NOTES + ' "The preimage of a set B under f is the set of inputs that land in B."].',
  "",
  "`[source: x.md \"inline code stays as written\"]`",
].join("\n");
const CITE_FILES = {
  [ANN]: `## Test 1 Next Week!\n\n**Subject Matter**\n\n${SCOPE_QUOTE} This includes all of the sections on sets, propositional logic, universal and existential claims, constrained proofs, relations, and functions. Test 1 will **not** cover graphs or combinatorics.`,
  [NOTES]: `5.3 Properties of Functions\n\nDefinition 5.3.1. ${INJ} Intuitively, different inputs give different outputs.`,
};

export default [
  {
    name: "f15-scope-card",
    sizes: [[1100, 720], [640, 480]],
    mock: mock(),
    async run(page, h) {
      await cardReady(page);
      const c = await page.evaluate((C) => {
        const card = document.querySelector(C);
        const line = card.querySelector("[data-study-action-scope]");
        return { state: line?.getAttribute("data-study-action-scope"), text: line?.innerText.replace(/\s+/g, " "), fit: document.documentElement.scrollWidth <= window.innerWidth };
      }, CARD);
      check(c.state === "known" && c.text.includes("Test 1: through HW 6; not graphs or combinatorics") && c.text.includes("checked against your notes"), "the card says the exam's scope before anything is made", JSON.stringify(c));
      check(c.fit, "nothing scrolls sideways");
      await page.click(`${CARD} [data-study-action-scope] summary`);
      const ev = await page.evaluate((C) => [...document.querySelectorAll(`${C} [data-scope-evidence] [data-passage]`)].map((p) => p.textContent), CARD);
      check(ev.length === 2 && ev[1].includes("Test 1 will not cover graphs or combinatorics."), "its evidence is the course's own words", JSON.stringify(ev));
      await h.shot("evidence");
    },
  },
  {
    name: "f15-progress",
    sizes: [[1100, 720]],
    mock: mock({}, { chatHoldAt: "checking" }),
    async run(page, h) {
      await cardReady(page);
      await page.click(`${CARD} [data-study-action-make]`);
      const live = `${CARD} [data-study-action-live]`;
      check(await waitFor(page, (L) => /Reading CSCI-C 241 Discrete Structures to see what it teaches and what Test 1 covers/.test(document.querySelector(L)?.textContent ?? ""), live), "mapping is said in words", await page.evaluate((L) => document.querySelector(L)?.textContent, live));
      check(await waitFor(page, (L) => /Checking each question against your notes \(0 of 5\): 0 kept, 1 dropped so far/.test(document.querySelector(L)?.textContent ?? ""), live, 6000), "checking says kept and dropped", await page.evaluate((L) => document.querySelector(L)?.textContent, live));
      const role = await page.evaluate((L) => document.querySelector(L)?.getAttribute("role"), live);
      check(role === "status", "progress is a polite status");
      await h.shot("checking");
      await page.evaluate(() => window.__releaseChat?.());
      check(await waitFor(page, (L) => /3 kept, 2 dropped/.test(document.querySelector(L)?.textContent ?? ""), live, 6000), "the final count is said");
      await page.evaluate(() => window.__releaseChat?.());
      // Made: Study opens on the quiz with its scope, its shortfall and each question's source.
      check(await waitFor(page, (S) => !!document.querySelector(`${S} [data-quiz-form]`), SHOWN, 8000), "the quiz opens in Study");
      const said = await page.evaluate(() => document.querySelector("[data-shell-status]")?.textContent ?? "");
      check(said.includes("Only 3 of 4 passed the check") || said.includes("Your quiz is ready"), "arrival is said", said);
    },
  },
  {
    name: "f15-quiz",
    sizes: [[1100, 720], [640, 480]],
    mock: mock({ threads: {} }, { quizzes: { "study/quizzes/Test 1 practice.json": { title: "Test 1 practice", course: "CSCI-C 241 Discrete Structures", sources: [NOTES, HW6], created: Date.now(), questions: QUIZ, grounding: GROUNDING } } }),
    async run(page, h) {
      await page.waitForSelector(`${SHOWN} [data-view-tab="study"]`, { timeout: 5000 });
      await page.click(`${SHOWN} [data-view-tab="study"]`);
      await page.waitForSelector(`${SHOWN} [data-take-quiz]`, { timeout: 4000 });
      await page.click(`${SHOWN} [data-take-quiz]`);
      await page.waitForSelector(`${SHOWN} [data-grounding]`, { timeout: 4000 });
      const g = await page.evaluate((S) => {
        const box = document.querySelector(`${S} [data-grounding]`);
        return {
          scope: box.querySelector("[data-scope-line]")?.innerText.replace(/\s+/g, " "),
          note: box.querySelector("[data-grounding-note]")?.innerText,
          hidden: !document.querySelector(`${S} [data-question] [data-provenance]`),
          fit: document.documentElement.scrollWidth <= window.innerWidth,
        };
      }, SHOWN);
      check(g.scope === "Test 1: through HW 6; not graphs or combinatorics", "the quiz header says the exam's scope", g.scope);
      check(g.note?.startsWith("Only 3 of the 4 questions you asked for passed the check"), "fewer questions are explained, never padded", g.note);
      check(g.hidden, "where a question comes from stays hidden while answering (its passage can give the answer away)");
      check(g.fit, "nothing scrolls sideways");
      await h.shot("header");
      // Coverage and what the check left out.
      await page.evaluate((S) => document.querySelectorAll(`${S} [data-grounding] details`).forEach((d) => (d.open = true)), SHOWN);
      const cov = await page.evaluate((S) => ({ cov: document.querySelector(`${S} [data-coverage]`)?.innerText, dropped: document.querySelector(`${S} [data-dropped]`)?.innerText }), SHOWN);
      check(cov.cov.includes("Relations (4.1–4.4): none, its questions didn’t pass the check") && cov.cov.includes("Properties of functions (5.3): 2 questions"), "coverage says which topics got questions and why one got none", cov.cov);
      check(cov.dropped.includes("preimages are never defined"), "what was dropped is said with why", cov.dropped);
      await h.shot("details");
      // In the results, each question says where it comes from, the passage one fold below with the file a click on.
      await page.click(`${SHOWN} [data-quiz-submit]`);
      await page.waitForSelector(`${SHOWN} [data-submit-anyway]`, { timeout: 3000 });
      await page.click(`${SHOWN} [data-submit-anyway]`);
      await page.waitForSelector(`${SHOWN} [data-quiz-results]`, { timeout: 4000 });
      const from = await page.evaluate((S) => [...document.querySelectorAll(`${S} [data-result] [data-provenance] p`)].map((p) => p.textContent), SHOWN);
      check(from[0] === "From: Wennstrom Lecture Notes - C241 Fa26 §5.3" && from[2] === "From: HW 06 - C241 Fa26 #2", "each question says where it comes from", JSON.stringify(from));
      await page.click(`${SHOWN} [data-result="q1"] [data-provenance] summary`);
      const p = await page.evaluate((S) => ({ passage: document.querySelector(`${S} [data-result="q1"] [data-passage] mark`)?.textContent, open: document.querySelector(`${S} [data-result="q1"] [data-view-file]`)?.getAttribute("data-view-file") }), SHOWN);
      check(p.passage?.startsWith("A function f : A → B is injective") && p.open === NOTES, "the quote is shown and its file opens in the viewer", JSON.stringify(p));
      await page.click(`${SHOWN} [data-result="q1"] [data-view-file]`);
      check(await waitFor(page, (n) => document.querySelector("[data-file-viewer]")?.getAttribute("data-file-viewer") === n, NOTES), "the file opens in the in-app viewer");
    },
  },
  {
    name: "f15-unknown-scope",
    sizes: [[1100, 720], [640, 480]],
    mock: mock({}, { planScopes: { "Test 1": { ...PLAN_SCOPE, state: "unknown", words: "", evidence: [] } }, chatNeedsScope: { course: C241, courseName: "CSCI-C 241 Discrete Structures", exam: "Test 1" } }),
    async run(page, h) {
      await cardReady(page);
      const line = await page.evaluate((C) => document.querySelector(`${C} [data-study-action-scope]`)?.innerText, CARD);
      check(line?.includes("I couldn’t find what Test 1 covers"), "an unknown scope is said up front, not guessed", line);
      await page.click(`${CARD} [data-study-action-make]`);
      check(await stateIs(page, "error"), "nothing is made", await cardState(page));
      await page.waitForSelector(`${CARD} [data-scope-form]`, { timeout: 4000 });
      const f = await page.evaluate((C) => ({ alert: document.querySelector(`${C} [data-study-action-error]`)?.innerText, focus: document.activeElement?.closest("[data-scope-form]") != null, label: document.querySelector(`${C} [data-scope-form] label`)?.textContent }), CARD);
      check(f.alert.includes("I won’t guess") && f.focus && f.label === "What does Test 1 cover?", "it asks what the exam covers, with focus in the answer", JSON.stringify(f));
      await h.shot("ask");
      await page.click(`${CARD} [data-scope-save]`);
      check(await waitFor(page, (C) => !!document.querySelector(`${C} [data-scope-form] [aria-invalid="true"]`), CARD), "an empty answer is refused in words");
      await page.type(`${CARD} [data-scope-form] input`, "Through HW 6, not graphs or combinatorics");
      await page.click(`${CARD} [data-scope-save]`);
      check(await waitFor(page, (S) => !!document.querySelector(`${S} [data-quiz-form]`), SHOWN, 8000), "then it is made and opens");
      const st = await page.evaluate(() => window.__MOCK__.study.scopeStates);
      check(st?.[0]?.exam === "Test 1" && st[0].text === "Through HW 6, not graphs or combinatorics" && st[0].course === C241, "the person's word is kept for the course", JSON.stringify(st));
      await page.click(`${SHOWN} [data-view-tab="chat"]`);
      const after = await page.evaluate((C) => document.querySelector(`${C} [data-study-action-scope]`)?.innerText, CARD);
      check(after?.includes("Through HW 6, not graphs or combinatorics (as you said)"), "the card shows the scope as the person's own", after);
    },
  },
  {
    name: "f15-citations",
    sizes: [[1100, 720], [640, 480]],
    mock: mock({ threads: { school: [{ role: "user", text: "What's on Test 1?", attachments: [] }, { role: "assistant", text: CITED_REPLY, attachments: [] }] } }, { citeFiles: CITE_FILES, citeAt: { [NOTES]: "§5.3" } }),
    async run(page, h) {
      const chip = `${SHOWN} [data-citation]`;
      await page.waitForSelector(chip, { timeout: 6000 });
      check(await waitFor(page, (c) => [...document.querySelectorAll(c)].every((x) => x.getAttribute("data-citation") !== "checking"), chip), "every chip is checked");
      const chips = await page.evaluate((c) => [...document.querySelectorAll(c)].map((x) => ({ state: x.getAttribute("data-citation"), label: x.getAttribute("aria-label"), text: x.innerText.replace(/\s+/g, " ") })), chip);
      check(chips.length === 4, "one chip per citation, none from code", JSON.stringify(chips));
      check(chips.slice(0, 3).every((c) => c.state === "found"), "quotes in their files are found (whitespace, typographic quotes and bold aside)", JSON.stringify(chips));
      check(chips[2].label === "Source: Wennstrom Lecture Notes - C241 Fa26.pdf §5.3, found in your materials", "a found chip says so to a screen reader", chips[2].label);
      check(chips[3].state === "missing" && chips[3].text.includes("not found in your materials") && chips[3].label.endsWith("not found in your materials"), "a quote that isn't in the file is said, in words", JSON.stringify(chips[3]));
      const code = await page.evaluate((S) => [...document.querySelectorAll(`${S} [data-role="assistant"] code`)].some((c) => c.textContent.includes("inline code stays as written")), SHOWN);
      check(code, "a citation in code stays code");
      const calls = await page.evaluate(() => window.__MOCK__.study.citationChecks);
      check(calls.length === 1 && calls[0] === 4, "the chips are checked together, once", JSON.stringify(calls));
      await h.shot("chips");
      await page.click(`${chip}[data-citation="found"]:nth-of-type(1)`);
      await page.waitForSelector("[data-citation-dialog]", { timeout: 3000 });
      const d = await page.evaluate(() => ({ mark: document.querySelector("[data-citation-dialog] mark")?.textContent, ctx: document.querySelector("[data-citation-dialog] [data-passage]")?.textContent, open: document.querySelector("[data-citation-dialog] [data-view-file]")?.getAttribute("data-view-file") }));
      check(d.mark === SCOPE_QUOTE && d.ctx.includes("Subject Matter") && d.open === ANN, "a found citation opens its passage in place, with the file a click on", JSON.stringify(d));
      await h.shot("passage");
      await page.keyboard.press("Escape");
      check(await waitFor(page, () => !document.querySelector("[data-citation-dialog]") && document.activeElement?.getAttribute("data-citation") === "found"), "Escape closes it, focus back on the chip");
      await page.focus(`${chip}[data-citation="missing"]`);
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-citation-dialog="missing"]', { timeout: 3000 });
      const m = await page.evaluate(() => document.querySelector('[data-citation-dialog="missing"]')?.innerText);
      check(m.includes("Not found in your materials. Those words aren’t in that file."), "a missing one says why", m);
    },
  },
  {
    name: "f15-cards",
    sizes: [[1100, 720]],
    mock: mock(
      { threads: {} },
      {
        decks: {
          "study/decks/Functions.md": {
            title: "Functions",
            course: "CSCI-C 241 Discrete Structures",
            sources: [NOTES],
            cards: [{ front: "When is $f : A \\to B$ injective?", back: "When $f(x) = f(y)$ implies $x = y$.", source: NOTES, quote: INJ }],
          },
        },
      },
    ),
    async run(page, h) {
      await page.waitForSelector(`${SHOWN} [data-view-tab="study"]`, { timeout: 5000 });
      await page.click(`${SHOWN} [data-view-tab="study"]`);
      await page.waitForSelector(`${SHOWN} [data-study-deck-row]`, { timeout: 4000 });
      await page.click(`${SHOWN} [data-study-deck-row]`);
      await page.waitForSelector(`${SHOWN} [data-card-front]`, { timeout: 4000 });
      check(!(await page.$(`${SHOWN} [data-provenance]`)), "the source waits for the answer");
      await page.keyboard.press("Space");
      await page.waitForSelector(`${SHOWN} [data-card-back] [data-provenance]`, { timeout: 3000 });
      await page.click(`${SHOWN} [data-card-back] [data-provenance] summary`);
      const p = await page.evaluate((S) => ({ from: document.querySelector(`${S} [data-provenance] p`)?.textContent, mark: document.querySelector(`${S} [data-provenance] mark`)?.textContent }), SHOWN);
      check(p.from === "From: Wennstrom Lecture Notes - C241 Fa26" && p.mark === INJ, "a card shows where it comes from, with the passage", JSON.stringify(p));
      await h.shot("card");
    },
  },
];
