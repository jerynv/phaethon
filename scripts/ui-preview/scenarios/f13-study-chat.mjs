// Feature round 13: a quiz or flashcards offered in a chat reply. The reply
// says what it will make and ends with a ```phaethon-study block, shown as a
// card with Generate quiz; pressing it makes the quiz (progress said in the
// card, Stop, errors with Try again), then opens it in Study with focus on
// its first question. The card offers Open quiz afterwards, also after a
// reload. Math in quizzes and flashcards is drawn by KaTeX. The fake core is
// the "study from chat (f13)" block in mock-ipc.js. Each scenario throws
// when the behaviour is wrong.
import { SETTINGS, check } from "../audit-fixtures.mjs";

const SHOWN = "[data-space-pane][data-shown]";
const CARD = `${SHOWN} [data-study-action]`;
const waitFor = (page, fn, arg, timeout = 5000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const stateIs = (page, s) => waitFor(page, (s) => document.querySelector("[data-space-pane][data-shown] [data-study-action]")?.getAttribute("data-study-action") === s, s);
const cardState = (page) => page.evaluate((c) => document.querySelector(c)?.getAttribute("data-study-action") ?? null, CARD);
const mockState = (page) => page.evaluate(() => ({ makes: window.__MOCK__.study?.chatMakes ?? [], quizzes: Object.keys(window.__MOCK__.study?.quizzes ?? {}), decks: Object.keys(window.__MOCK__.study?.decks ?? {}) }));

const M301 = "courses/MATH-M 301 Fall 2026";
const COURSES = [
  { course: "MATH-M 301 Linear Algebra", folder: M301 },
  { course: "CSCI-C 241 Discrete Structures", folder: "courses/CSCI-C 241 Fall 2026 (All Sections)" },
];
const QUESTION = "Can you quiz me on eigenvalues for the M301 exam? Mostly computing them.";
const BLOCK = {
  kind: "quiz",
  title: "Eigenvalues practice",
  focus: "eigenvalues, eigenvectors and the characteristic polynomial",
  count: 6,
  kinds: ["choice", "truefalse", "short"],
  difficulty: "exam",
  sources: [M301],
};
const prose =
  "Here’s what I’ll put together: **6 questions** on eigenvalues, eigenvectors and the characteristic polynomial $\\det(A - \\lambda I) = 0$, drawn from your M301 lecture notes and the Chapter 5 review sheet. " +
  "A mix of multiple choice, true or false and a couple of short answers, at exam level, with most of them asking you to compute.";
const fence = (b = BLOCK) => `\n\n\`\`\`phaethon-study\n${JSON.stringify(b)}\n\`\`\``;
const REPLY = prose + fence();
const thread = (reply = REPLY) => [
  { role: "user", text: QUESTION, attachments: [] },
  { role: "assistant", text: reply, attachments: [] },
];

/** The questions the fake core "makes": math in prompts, choices and explanations. */
const MATH_QUIZ = [
  {
    id: "q1",
    kind: "choice",
    prompt: "What are the eigenvalues of $A = \\begin{bmatrix} 2 & 1 \\\\ 0 & 3 \\end{bmatrix}$?",
    choices: ["$\\lambda = 2$ and $\\lambda = 3$", "$\\lambda = 1$ and $\\lambda = 3$", "$\\lambda = 0$ and $\\lambda = 5$", "$\\lambda = 2$ only"],
    answer: "$\\lambda = 2$ and $\\lambda = 3$",
    explanation: "A triangular matrix has its diagonal entries as eigenvalues: $\\det(A - \\lambda I) = (2-\\lambda)(3-\\lambda)$.",
  },
  { id: "q2", kind: "truefalse", prompt: "If $A\\mathbf{v} = \\lambda\\mathbf{v}$ with $\\mathbf{v} = \\mathbf{0}$, then $\\lambda$ is an eigenvalue of $A$.", choices: ["true", "false"], answer: "false", explanation: "Eigenvectors are nonzero by definition." },
  { id: "q3", kind: "short", prompt: "Why is $\\lambda$ an eigenvalue exactly when $$\\det(A - \\lambda I) = 0?$$", answer: "Then A − λI is singular, so (A − λI)v = 0 has a nonzero solution v.", explanation: "Singular means a nonzero null space." },
];
const STUDY = { courses: COURSES, step: 120, chatQuiz: MATH_QUIZ };
const clone = (x) => JSON.parse(JSON.stringify(x));
const mock = (extra = {}) => ({ settings: SETTINGS, threads: { school: thread() }, study: clone(STUDY), ...extra });

async function cardReady(page) {
  await page.waitForSelector(CARD, { timeout: 6000 });
  const ok = await stateIs(page, "ready");
  check(ok, "the card is ready to generate", await cardState(page));
}

export default [
  {
    name: "f13-card",
    sizes: [[1100, 720], [640, 480]],
    mock: mock(),
    async run(page) {
      await cardReady(page);
      const c = await page.evaluate((C) => {
        const card = document.querySelector(C);
        const btn = card.querySelector("[data-study-action-make]");
        const reply = card.closest('[data-role="assistant"]');
        return {
          title: card.querySelector("[data-study-action-title]")?.textContent,
          summary: card.querySelector("[data-study-action-summary]")?.textContent,
          label: btn?.textContent.trim(),
          disabled: btn?.disabled,
          code: !!reply.querySelector("pre"),
          raw: reply.innerText.includes('"kind"'),
          labelled: card.getAttribute("aria-labelledby") && document.getElementById(card.getAttribute("aria-labelledby"))?.textContent,
          proseMath: !!reply.querySelector(".katex") || reply.innerText.includes("det(A"),
          fit: document.documentElement.scrollWidth <= window.innerWidth,
        };
      }, CARD);
      check(c.title === "Eigenvalues practice", "the card says the quiz's title", c.title);
      check(
        c.summary === "A quiz of 6 questions on eigenvalues, eigenvectors and the characteristic polynomial (multiple choice, true or false and short answer), exam level, from MATH-M 301 Linear Algebra.",
        "the card says what, how many, which kinds and from where, in words",
        c.summary,
      );
      check(c.label === "Generate quiz" && c.disabled === false, "Generate quiz can be pressed", JSON.stringify(c));
      check(!c.code && !c.raw, "the block is a card, never code or JSON on screen", JSON.stringify(c));
      check(c.labelled === "Eigenvalues practice", "the card is a region named by its title");
      check(c.fit, "nothing scrolls sideways");
    },
  },
  {
    name: "f13-streaming",
    mock: mock({
      threads: {},
      holdOpen: true,
      turn: [
        { kind: "text", delta: prose },
        { kind: "text", delta: "\n\n```phaethon-study\n{\"kind\": \"quiz\", \"title\": \"Eigenvalues practice\", \"count\": 6, \"sour" },
      ],
    }),
    async run(page, h) {
      await h.send(QUESTION);
      await page.waitForSelector(CARD, { timeout: 6000 });
      check(await stateIs(page, "writing"), "a half-written block says it is still being written", await cardState(page));
      const w = await page.evaluate((C) => {
        const card = document.querySelector(C);
        return { btn: card.querySelector("[data-study-action-make]")?.disabled, text: card.innerText };
      }, CARD);
      check(w.btn === true && w.text.includes("Still writing the plan"), "while the reply comes, Generate waits", JSON.stringify(w));
      await h.shot("writing");
      // The rest of the block arrives: still waiting until the reply ends.
      await page.evaluate((rest) => window.__liveTurn.send({ kind: "text", delta: rest }), `ces": ["${M301}"]}\n\`\`\``);
      await new Promise((r) => setTimeout(r, 300));
      const still = await page.evaluate((C) => document.querySelector(C)?.querySelector("[data-study-action-make]")?.disabled, CARD);
      check(still === true, "a whole block waits for the reply to end");
      await page.evaluate(() => {
        window.__liveTurn.send({ kind: "end", sessionId: null });
        window.__liveTurn = null;
      });
      check(await stateIs(page, "ready"), "when the reply ends, the card is ready", await cardState(page));
    },
  },
  {
    name: "f13-invalid",
    mock: mock({
      threads: {
        school: [
          { role: "user", text: "make me a quiz", attachments: [] },
          { role: "assistant", text: "Sure, here it is." + "\n\n```phaethon-study\n{\"kind\": \"quiz\", \"count\": 6, \n```", attachments: [] },
          { role: "user", text: "and an essay?", attachments: [] },
          { role: "assistant", text: "Here." + fence({ kind: "essay" }), attachments: [] },
          { role: "user", text: "chemistry then", attachments: [] },
          { role: "assistant", text: "From chemistry." + fence({ kind: "quiz", sources: ["CHEM-C 117"] }), attachments: [] },
          { role: "user", text: "lots", attachments: [] },
          { role: "assistant", text: "A big one." + fence({ kind: "quiz", count: 400, kinds: ["choice", "essay"], sources: ["M301", "CHEM-C 117"] }), attachments: [] },
        ],
      },
      study: { ...clone(STUDY), courses: [COURSES[0]] },
    }),
    async run(page) {
      await page.waitForSelector(`${SHOWN} [data-study-action="invalid"]`, { timeout: 6000 });
      await waitFor(page, () => document.querySelectorAll("[data-space-pane][data-shown] [data-study-action]").length === 4);
      const all = await page.evaluate((S) => [...document.querySelectorAll(`${S} [data-study-action]`)].map((c) => ({ state: c.getAttribute("data-study-action"), text: c.innerText.replace(/\s+/g, " "), btn: !!c.querySelector("button:not([disabled])") })), SHOWN);
      check(all[0].state === "invalid" && all[0].text.includes("isn’t written in a form Phaethon can read") && !all[0].btn, "a broken block is a quiet note with no button", JSON.stringify(all[0]));
      check(all[1].state === "invalid" && all[1].text.includes("quiz or flashcards"), "an unknown kind is said", JSON.stringify(all[1]));
      check(all[2].state === "unusable" && all[2].text.includes("CHEM-C 117"), "sources that aren't there are named, nothing is made", JSON.stringify(all[2]));
      check(all[3].state === "ready" && all[3].text.includes("A quiz of 50 questions") && all[3].text.includes("At most 50") && all[3].text.includes("Not in this space, so left out: CHEM-C 117") && all[3].text.includes("“essay” isn’t a kind"), "limits and unknown sources are said, the rest is used", JSON.stringify(all[3]));
      const errors = await page.evaluate(() => document.body.innerText.includes("Something went wrong"));
      check(!errors, "nothing crashed");
    },
  },
  {
    name: "f13-generate",
    sizes: [[1100, 720]],
    mock: mock(),
    async run(page, h) {
      await cardReady(page);
      // Two presses at once: one quiz.
      await page.evaluate((C) => {
        const b = document.querySelector(`${C} [data-study-action-make]`);
        b.click();
        b.click();
      }, CARD);
      check(await stateIs(page, "running"), "pressing it starts making the quiz", await cardState(page));
      await waitFor(page, (C) => /Reading|Writing/.test(document.querySelector(`${C} [data-study-action-live]`)?.textContent ?? ""), CARD);
      const running = await page.evaluate((C) => {
        const card = document.querySelector(C);
        return { live: card.querySelector("[data-study-action-live]")?.textContent, role: card.querySelector("[data-study-action-live]")?.getAttribute("role"), stop: !!card.querySelector("[data-study-action-stop]"), focus: document.activeElement?.hasAttribute("data-study-action-stop") };
      }, CARD);
      check(running.role === "status" && running.stop && running.focus, "progress is said politely, Stop takes focus", JSON.stringify(running));
      await h.shot("running");
      // Done: Study shows the quiz, focus on the first question.
      const opened = await waitFor(page, (S) => document.querySelector(`${S} [data-view-tab="study"]`)?.getAttribute("aria-selected") === "true" && !!document.querySelector(`${S} [data-quiz-form]`), SHOWN, 8000);
      check(opened, "when it is made, Study opens on the quiz");
      await waitFor(page, () => document.activeElement?.closest("[data-question]")?.getAttribute("data-question") === "q1");
      const q = await page.evaluate(() => ({
        focus: document.activeElement?.closest("[data-question]")?.getAttribute("data-question"),
        tag: document.activeElement?.tagName,
        said: document.querySelector("[data-shell-status]")?.textContent,
        title: document.querySelector("[data-quiz-title]")?.textContent,
        katex: document.querySelectorAll("[data-quiz-form] .katex").length,
        mathml: document.querySelectorAll("[data-quiz-form] .katex math").length,
        display: !!document.querySelector('[data-quiz-form] [data-math="display"]'),
        rawDollar: [...document.querySelectorAll("[data-quiz-form] [data-question]")].some((f) => f.innerText.includes("$")),
      }));
      check(q.focus === "q1" && q.tag === "INPUT", "focus is on the first question's first choice", JSON.stringify(q));
      check(q.said?.includes("Your quiz is ready: Eigenvalues practice, 3 questions"), "its arrival is said", q.said);
      check(q.title === "Eigenvalues practice", "it is the quiz just made", q.title);
      check(q.katex >= 8 && q.mathml === q.katex && !q.rawDollar, "math is drawn by KaTeX, with MathML for screen readers, no $ left", JSON.stringify(q));
      // One question at a time: display math is on one of the others.
      let display = false;
      for (const id of await page.$$eval(`${SHOWN} [data-go-question]`, (bs) => bs.map((b) => b.dataset.goQuestion))) {
        await page.click(`${SHOWN} [data-go-question="${id}"]`);
        display ||= await page.evaluate(() => !!document.querySelector('[data-quiz-form] [data-math="display"]'));
      }
      check(display, "display math is drawn as display");
      await page.click(`${SHOWN} [data-go-question="q1"]`);
      const st = await mockState(page);
      check(st.makes.length === 1 && st.quizzes.length === 1, "two presses made one quiz", JSON.stringify(st));
      check(st.makes[0].question === QUESTION && st.makes[0].reply.includes("6 questions") && st.makes[0].reply.includes("phaethon-study"), "the question and the reply go along as context", JSON.stringify(st.makes[0]).slice(0, 200));
      await h.shot("quiz");
      // Back in Chat the card offers Open quiz, and it opens the same quiz without making another.
      await page.click(`${SHOWN} [data-view-tab="chat"]`);
      check(await stateIs(page, "done"), "the card shows it was made", await cardState(page));
      const label = await page.evaluate((C) => document.querySelector(`${C} [data-study-action-open]`)?.textContent.trim(), CARD);
      check(label === "Open quiz", "the card offers Open quiz", label);
      await page.click(`${CARD} [data-study-action-open]`);
      check(await waitFor(page, () => document.activeElement?.closest("[data-question]")?.getAttribute("data-question") === "q1"), "Open quiz opens it at its first question");
      check((await mockState(page)).makes.length === 1, "opening never makes another");
    },
  },
  {
    name: "f13-reload",
    sizes: [[1100, 720]],
    mock: mock({ threads: {}, recordTurns: true, turn: [{ kind: "text", delta: REPLY }] }),
    async run(page, h) {
      await h.send(QUESTION);
      await cardReady(page);
      await page.click(`${CARD} [data-study-action-make]`);
      check(await waitFor(page, (S) => !!document.querySelector(`${S} [data-quiz-form]`), SHOWN, 8000), "made and opened");
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector(CARD, { timeout: 8000 });
      check(await stateIs(page, "made"), "after a reload the card knows what it made", await cardState(page));
      const label = await page.evaluate((C) => document.querySelector(`${C} [data-study-action-open]`)?.textContent.trim(), CARD);
      check(label === "Open quiz", "after a reload it offers Open quiz", label);
      await page.click(`${CARD} [data-study-action-open]`);
      check(await waitFor(page, (S) => document.querySelector(`${S} [data-quiz-title]`)?.textContent === "Eigenvalues practice", SHOWN), "Open quiz opens it after a reload");
      const st = await mockState(page);
      check(st.makes.length === 0 && st.quizzes.length === 1, "nothing was made again", JSON.stringify(st));
    },
  },
  {
    name: "f13-error",
    mock: mock({ study: { ...clone(STUDY), chatError: "No model is set up: add an API key in Settings, or switch to Claude Code.", chatErrorOnce: true } }),
    async run(page, h) {
      await cardReady(page);
      await page.click(`${CARD} [data-study-action-make]`);
      check(await stateIs(page, "error"), "a failure shows in the card", await cardState(page));
      const e = await page.evaluate((C) => {
        const card = document.querySelector(C);
        return {
          alert: card.querySelector('[role="alert"]')?.textContent,
          settings: [...card.querySelectorAll("button")].some((b) => b.textContent.includes("Open Settings")),
          retry: card.querySelector("[data-study-action-make]")?.textContent.trim(),
          focus: document.activeElement?.hasAttribute("data-study-action-make"),
        };
      }, CARD);
      check(e.alert?.startsWith("The quiz couldn’t be made. No model is set up") && e.settings, "it says why in words, and offers Settings", JSON.stringify(e));
      check(e.retry === "Try again" && e.focus, "Try again takes focus", JSON.stringify(e));
      await h.shot("error");
      await page.click(`${CARD} [data-study-action-make]`);
      check(await waitFor(page, (S) => !!document.querySelector(`${S} [data-quiz-form]`), SHOWN, 8000), "Try again makes it and opens it");
    },
  },
  {
    name: "f13-stop",
    mock: mock({ study: { ...clone(STUDY), step: 500 } }),
    async run(page, h) {
      await cardReady(page);
      await page.click(`${CARD} [data-study-action-make]`);
      await page.waitForSelector(`${CARD} [data-study-action-stop]`, { timeout: 3000 });
      await page.click(`${CARD} [data-study-action-stop]`);
      check(await stateIs(page, "cancelled"), "Stop stops it", await cardState(page));
      const s = await page.evaluate((C) => {
        const card = document.querySelector(C);
        return { live: card.querySelector("[data-study-action-live]")?.textContent, focus: document.activeElement?.hasAttribute("data-study-action-make"), label: card.querySelector("[data-study-action-make]")?.textContent.trim() };
      }, CARD);
      check(s.live === "Stopped. Nothing was made." && s.focus && s.label === "Generate quiz", "it says nothing was made, and Generate is back with focus", JSON.stringify(s));
      const st = await mockState(page);
      check(st.quizzes.length === 0, "no quiz was saved", JSON.stringify(st));
      await h.shot("stopped");
    },
  },
  {
    name: "f13-math",
    sizes: [[1100, 720], [640, 480]],
    mock: mock({
      threads: {},
      study: {
        courses: COURSES,
        quizzes: { "study/quizzes/Eigenvalues practice.json": { title: "Eigenvalues practice", course: "MATH-M 301 Linear Algebra", sources: [M301], created: Date.now(), questions: MATH_QUIZ } },
        decks: {
          "study/decks/Determinants.md": {
            title: "Determinants",
            course: "MATH-M 301 Linear Algebra",
            sources: [M301],
            cards: [
              { front: "What is $\\det\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}$?", back: "$ad - bc$" },
              { front: "A square matrix is invertible exactly when its {{determinant}} is not $0$.", back: "" },
            ],
          },
        },
      },
    }),
    async run(page, h) {
      await page.waitForSelector(`${SHOWN} [data-view-tab="study"]`, { timeout: 5000 });
      await page.click(`${SHOWN} [data-view-tab="study"]`);
      await page.waitForSelector(`${SHOWN} [data-take-quiz]`, { timeout: 4000 });
      await page.click(`${SHOWN} [data-take-quiz]`);
      await page.waitForSelector(`${SHOWN} [data-quiz-form] .katex`, { timeout: 4000 });
      await h.shot("quiz");
      // A flashcard with a matrix, then its answer.
      await page.click(`${SHOWN} [data-back-to-study]`);
      await page.waitForSelector(`${SHOWN} [data-study-deck-row]`, { timeout: 4000 });
      await page.click(`${SHOWN} [data-study-deck-row]`);
      await page.waitForSelector(`${SHOWN} [data-card-front] .katex`, { timeout: 4000 });
      const f = await page.evaluate((S) => {
        const front = document.querySelector(`${S} [data-card-front]`);
        return { katex: front.querySelectorAll('[aria-hidden="true"] .katex').length, srMath: front.querySelectorAll(".sr-only .katex math").length, matrix: !!front.querySelector(".katex .mtable, .katex .arraycolsep") };
      }, SHOWN);
      check(f.katex === 1 && f.srMath === 1 && f.matrix, "a flashcard's matrix is drawn, and screen readers get it as MathML", JSON.stringify(f));
      await h.shot("card");
      await page.keyboard.press("Space");
      await page.waitForSelector(`${SHOWN} [data-card-back] .katex`, { timeout: 3000 });
    },
  },
];
