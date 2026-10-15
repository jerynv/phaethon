// Feature round 6: Study. A view switcher in each space's header (Chat,
// Study, Grades, Plan); the Study hub; making flashcards and quizzes from the
// space's courses; a Brainscape-style review session; the deck editor; taking
// a quiz and its results, mistake review and cards from mistakes. The fake
// core is the "study (UI)" block in mock-ipc.js. Each scenario throws when
// the behaviour is wrong.
import { SETTINGS, check } from "../audit-fixtures.mjs";

const SHOWN = "[data-space-pane][data-shown]";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter((c) => c[0] === cmd).map((c) => c[1]), cmd);
const chord = async (page, keys) => {
  for (const k of keys) await page.keyboard.down(k);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
};
const waitFor = (page, fn, arg, timeout = 4000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const active = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName, text: (a?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80), label: a?.getAttribute("aria-label"), data: Object.keys(a?.dataset ?? {}).join(",") };
  });
const focusIs = (page, sel) => page.evaluate((s) => !!document.activeElement?.matches(s), sel);
const tabTo = async (page, sel, max = 60) => {
  for (let i = 0; i < max; i++) {
    if (await focusIs(page, sel)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached ${sel} (at ${JSON.stringify(await active(page))})`);
};
const status = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sel);
const openStudy = async (page) => {
  await page.waitForSelector(`${SHOWN} [data-view-tab="study"]`, { timeout: 5000 });
  await page.click(`${SHOWN} [data-view-tab="study"]`);
  await page.waitForSelector(`${SHOWN} [data-study-hub]`, { timeout: 3000 });
};

const C241 = "courses/CSCI-C 241 Fall 2026 (All Sections)";
const NOTES = `${C241}/files/Notes/Wennstrom Lecture Notes - C241 Fa26.pdf`;
const REVIEW = `${C241}/files/HW/Test 1 Review - C241 Fa26.pdf`;
const DAY = 86400000;
const now = Date.now();

const STUDY = {
  streakDays: 3,
  step: 40,
  courses: [
    { course: "CSCI-C 241 Discrete Structures", folder: C241 },
    { course: "MATH-M 212 Calculus II", folder: "courses/Calculus II" },
  ],
  decks: {
    "study/decks/Graph theory basics.md": {
      title: "Graph theory basics",
      course: "CSCI-C 241 Fall 2026 (All Sections)",
      sources: [NOTES, REVIEW],
      cards: [
        { front: "What is a bipartite graph?", back: "A graph whose vertices split into two sets with every edge going between the sets." },
        { front: "The {{chromatic number}} of a bipartite graph with an edge is 2.", back: "" },
        { front: "How many edges does a tree with n vertices have?", back: "n − 1" },
        { front: "What is a Hamiltonian cycle?", back: "A cycle that visits every vertex exactly once.", confidence: 5, due: now + 6 * DAY },
        { front: "What does Euler’s handshake lemma say?", back: "The degrees add up to twice the number of edges.", confidence: 4, due: now + 3 * DAY },
      ],
    },
    "study/decks/Logic and proofs.md": {
      title: "Logic and proofs",
      course: "CSCI-C 241 Fall 2026 (All Sections)",
      sources: [NOTES],
      cards: [
        { front: "What is the contrapositive of p → q?", back: "¬q → ¬p", confidence: 5, due: now + 5 * DAY },
        { front: "When is p → q false?", back: "Only when p is true and q is false.", confidence: 4, due: now + 2 * DAY },
      ],
    },
  },
  quizzes: {
    "study/quizzes/Test 1 practice.json": {
      title: "Test 1 practice",
      course: "CSCI-C 241 Fall 2026 (All Sections)",
      sources: [REVIEW],
      created: now - 3 * DAY,
      lastScore: 0.6,
      lastTaken: now - 2 * DAY,
      questions: [
        { id: "q1", kind: "choice", prompt: "Which of these graphs is bipartite?", choices: ["A triangle (a 3-cycle)", "A square (a 4-cycle)", "The complete graph K5"], answer: "A square (a 4-cycle)", explanation: "Even cycles are bipartite; odd cycles never are.", source: NOTES },
        { id: "q2", kind: "multi", prompt: "Which statements mean the same as p → q?", choices: ["¬p ∨ q", "¬q → ¬p", "q → p", "¬(p ∧ ¬q)"], answer: ["¬p ∨ q", "¬q → ¬p", "¬(p ∧ ¬q)"], explanation: "The converse q → p is not equivalent.", source: REVIEW },
        { id: "q3", kind: "truefalse", prompt: "Every tree with n vertices has n − 1 edges.", choices: ["True", "False"], answer: "True", explanation: "Each edge added to a tree adds exactly one vertex.", source: NOTES },
        { id: "q4", kind: "short", prompt: "Why can’t a bipartite graph have a cycle of odd length?", answer: "sides alternate, so odd cycle returns same side", explanation: "Walking a cycle switches sides at every edge, so you only get back to the start after an even number of edges.", source: NOTES },
        { id: "q5", kind: "cloze", prompt: "The {{chromatic number}} of a bipartite graph with at least one edge is 2.", answer: "chromatic number", explanation: "Two colours suffice: one per side.", source: NOTES },
      ],
    },
  },
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const mock = (study = STUDY, extra = {}) => ({ settings: SETTINGS, threads: {}, study: clone(study), ...extra });

export default [
  {
    name: "f6-hub",
    sizes: [[1100, 720], [640, 480]],
    mock: mock(),
    async run(page, h) {
      await openStudy(page);
      await h.waitText("cards due today");
      const hub = await page.evaluate((S) => {
        const root = document.querySelector(`${S} [data-study-hub]`);
        const tab = document.querySelector(`${S} [data-view-tab="study"]`);
        const panel = document.getElementById(tab.getAttribute("aria-controls"));
        return {
          due: root.querySelector("[data-due-count]")?.textContent,
          streak: root.querySelector("[data-streak]")?.textContent,
          decks: [...root.querySelectorAll("[data-deck-row]")].map((r) => r.innerText.replace(/\s+/g, " ")),
          quiz: root.querySelector("[data-last-score]")?.textContent,
          selected: tab.getAttribute("aria-selected"),
          panelOk: panel?.getAttribute("role") === "tabpanel" && panel.contains(root),
          chatHidden: document.querySelector(`${S} [data-space-view="chat"]`)?.inert,
        };
      }, SHOWN);
      check(hub.due === "3 cards due today", "the hub says how many cards are due", hub.due);
      check(hub.streak?.includes("3 days in a row"), "the streak is in words", hub.streak);
      check(hub.decks.length === 2 && hub.decks[0].includes("40% known") && hub.decks[0].includes("3 due · 3 new · 5 cards"), "a deck row has mastery in words and its counts", hub.decks[0]);
      check(hub.decks[0].includes("CSCI-C 241"), "a deck row names its course");
      check(hub.quiz?.startsWith("Last score 60%"), "a quiz row has its last score", hub.quiz);
      check(hub.selected === "true" && hub.panelOk && hub.chatHidden, "the Study tab is selected, its panel shows, Chat is out of reach");
      const fit = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      check(fit, "nothing scrolls sideways");
    },
  },
  {
    name: "f6-views-keyboard",
    mock: mock(),
    async run(page, h) {
      const COMPOSER = "[data-composer-input]";
      await page.waitForSelector(COMPOSER, { timeout: 5000 });
      // Arrow keys move along the tabs and show each view.
      await page.focus(`${SHOWN} [data-view-tab="chat"]`);
      await page.keyboard.press("ArrowRight");
      await waitFor(page, () => document.activeElement?.getAttribute("data-view-tab") === "study");
      let at = await page.evaluate(() => document.activeElement?.getAttribute("data-view-tab"));
      check(at === "study" && !!(await page.$(`${SHOWN} [data-study-hub]`)), "ArrowRight goes to Study and shows it", at);
      await page.keyboard.press("End");
      await waitFor(page, () => document.activeElement?.getAttribute("data-view-tab") === "plan");
      at = await page.evaluate(() => document.activeElement?.getAttribute("data-view-tab"));
      check(at === "plan", "End goes to Plan", at);
      await page.keyboard.press("ArrowRight");
      await waitFor(page, () => document.activeElement?.getAttribute("data-view-tab") === "chat");
      at = await page.evaluate(() => document.activeElement?.getAttribute("data-view-tab"));
      check(at === "chat", "ArrowRight from the last wraps to Chat", at);
      const roving = await page.evaluate((S) => [...document.querySelectorAll(`${S} [role=tab]`)].map((t) => t.tabIndex).join(","), SHOWN);
      check(roving === "0,-1,-1,-1", "only the selected tab is in the Tab order", roving);
      // Option+Cmd+2: Study, its heading takes focus.
      await page.focus(COMPOSER);
      await chord(page, ["Alt", "Meta", "Digit2"]);
      const ok = await waitFor(page, () => document.activeElement?.matches("[data-study-hub] h2"));
      check(ok, "⌥⌘2 opens Study and focuses its heading", JSON.stringify(await active(page)));
      // Option+Cmd+1: back to Chat and its composer.
      await chord(page, ["Alt", "Meta", "Digit1"]);
      check(await waitFor(page, (c) => document.activeElement?.matches(c), COMPOSER), "⌥⌘1 goes back to Chat, focus in the composer");
      // The palette: Open Study.
      await chord(page, ["Meta", "k"]);
      await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
      await page.keyboard.type("open study");
      const listed = await page.evaluate(() => document.querySelector('[data-command="view:study"]')?.getAttribute("aria-selected"));
      check(listed === "true", "the palette offers Open Study");
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => document.activeElement?.matches("[data-study-hub] h2")), "Open Study shows Study with its heading focused");
      // Cmd+N from Study goes back to Chat and starts a new conversation there.
      await chord(page, ["Meta", "n"]);
      check(await waitFor(page, (S) => document.querySelector(`${S} [data-view-tab="chat"]`)?.getAttribute("aria-selected") === "true", SHOWN), "Cmd+N from Study goes back to Chat");
      // The shortcuts sheet lists the view shortcut.
      await chord(page, ["Meta", "/"]);
      await h.waitText("Chat, Study, Grades or Plan");
      await page.keyboard.press("Escape");
      await waitFor(page, () => !document.querySelector('[role="dialog"]'));
      await sleep(300);
    },
  },
  {
    name: "f6-empty",
    sizes: [[1100, 720], [640, 480]],
    mock: mock({ courses: [] }),
    async run(page, h) {
      await openStudy(page);
      await page.waitForSelector("[data-study-empty]", { timeout: 3000 });
      await waitFor(page, () => !!document.querySelector("[data-empty-import]"));
      const e = await page.evaluate(() => ({
        text: document.querySelector("[data-study-empty]")?.innerText ?? "",
        importBtn: !!document.querySelector("[data-empty-import]"),
        make: !!document.querySelector("[data-study-empty] [data-make]"),
      }));
      check(e.text.includes("Turn your courses into flashcards") && e.importBtn && !e.make, "no courses: it explains, and offers Import courses", JSON.stringify(e));
      await page.click("[data-empty-import]");
      check(await waitFor(page, () => !!document.querySelector("[data-course-import]")), "Import courses opens the course import");
    },
  },
  {
    name: "f6-empty-courses",
    mock: mock({ courses: STUDY.courses }),
    async run(page) {
      await openStudy(page);
      await page.waitForSelector("[data-study-empty] [data-make='deck']", { timeout: 3000 });
      check(!(await page.$("[data-empty-import]")), "with courses: it offers to make cards, not to import");
    },
  },
  {
    name: "f6-make-deck",
    sizes: [[1100, 720], [640, 480]],
    mock: mock({ ...STUDY, step: 250 }),
    async run(page, h) {
      await openStudy(page);
      await page.click(`${SHOWN} [data-study-hub] [data-make="deck"]`);
      await page.waitForSelector("[data-make-dialog='deck']", { timeout: 3000 });
      // Step by step (f14-make has the whole of it): nothing chosen is a plain error, tied to the choices, focus there.
      await page.click("[data-step-next]");
      const err = await page.evaluate(() => ({
        text: document.querySelector("[data-field-error]")?.textContent ?? "",
        focusInSources: !!document.activeElement?.closest("[data-source-course]"),
      }));
      check(err.text.includes("Choose at least one course") && err.focusInSources, "nothing chosen: said in words, focus on the choices", JSON.stringify(err));
      // A part of a course: the course box shows mixed.
      await page.click(`[data-source-course="${C241}"] [data-source-part="files"]`);
      const mixed = await page.evaluate((C) => document.querySelector(`[data-source-course="${C}"] input`).indeterminate, C241);
      check(mixed, "one part chosen: the course's box is mixed");
      await page.click(`[data-source-course="${C241}"] [data-source-part="syllabus.md"]`);
      await page.click("[data-step-next]");
      // Which test: everything so far (f16-exam has the rest).
      await page.waitForSelector('[data-make-form][data-make-at="exam"]', { timeout: 3000 });
      await page.click("[data-step-next]");
      await page.waitForSelector("[data-make-focus]", { timeout: 3000 });
      // The step's heading takes focus first, as it shows.
      await waitFor(page, () => document.activeElement?.matches("[data-make-title]"));
      await page.type("[data-make-focus]", "Test 1");
      await h.shot("form");
      await page.click("[data-step-next]");
      await page.waitForSelector("[data-make-submit]", { timeout: 3000 });
      await page.click("[data-make-submit]");
      check(await waitFor(page, () => !!document.querySelector("[data-make-running] [role=progressbar]")), "making shows a progress bar");
      await waitFor(page, () => /Checking each card/.test(document.querySelector("[data-make-step]")?.textContent ?? ""));
      const p = await page.evaluate(() => document.querySelector("[role=progressbar]")?.getAttribute("aria-valuetext"));
      check(/Checking each card against your notes \(\d+ of 20\): \d+ kept, \d+ dropped so far/.test(p ?? ""), "the progress is in words", p);
      await h.shot("running");
      check(await waitFor(page, () => !!document.querySelector("[data-make-done]"), null, 5000), "it finishes");
      const sent = (await calls(page, "study_make_deck"))[0];
      check(
        JSON.stringify(sent.sources.sort()) === JSON.stringify([`${C241}/files`, `${C241}/syllabus.md`]) && sent.options.focus === "Test 1" && sent.options.count === 20,
        "the core gets the chosen parts, the focus and the count",
        JSON.stringify(sent),
      );
      const focus = await page.evaluate(() => document.activeElement?.matches("[data-make-title]"));
      check(focus, "the result's heading has focus");
      await h.shot("done");
      await page.click("[data-make-next]");
      check(await waitFor(page, () => !!document.querySelector("[data-show-answer]")), "Study them now starts a session with the new cards");
      const paths = (await calls(page, "study_session")).at(-1).paths;
      check(paths?.length === 1 && paths[0].includes("Cards on Test 1"), "the session is the new deck", JSON.stringify(paths));
    },
  },
  {
    name: "f6-make-error",
    mock: mock({ ...STUDY, makeError: "No model is set up: add an API key in Settings, or switch to Claude Code." }),
    async run(page, h) {
      await openStudy(page);
      await page.click(`${SHOWN} [data-make="quiz"]`);
      await page.waitForSelector("[data-make-dialog='quiz']", { timeout: 3000 });
      await page.click(`[data-source-course="${C241}"] input`);
      await page.click("[data-step-next]");
      await page.waitForSelector('[data-make-form][data-make-at="exam"]', { timeout: 3000 });
      await page.click("[data-step-next]");
      // Quiz kinds: none chosen is an error too.
      await page.waitForSelector('[data-quiz-kind="choice"]', { timeout: 3000 });
      for (const k of ["choice", "truefalse", "short"]) await page.click(`[data-quiz-kind="${k}"]`);
      await page.click("[data-step-next]");
      check((await status(page, "[data-field-error]")).includes("at least one kind"), "no kind of question: said in words");
      await page.click('[data-quiz-kind="multi"]');
      await page.click('[data-difficulty="harder"]');
      await page.click("[data-step-next]");
      await page.waitForSelector("[data-make-count]", { timeout: 3000 });
      await page.click("[data-step-next]");
      await page.waitForSelector("[data-make-submit]", { timeout: 3000 });
      await page.click("[data-make-submit]");
      check(await waitFor(page, () => !!document.querySelector("[data-make-error] [role=alert]")), "the error shows as an alert");
      const e = await page.evaluate(() => ({ text: document.querySelector("[data-make-error]")?.innerText ?? "", settings: !!document.querySelector("[data-make-settings]"), title: document.querySelector("[data-make-title]")?.textContent }));
      check(e.text.includes("No model is set up") && e.settings && e.title === "The quiz couldn’t be made", "no model: plain words and a way to Settings", JSON.stringify(e));
      const sent = (await calls(page, "study_make_quiz"))[0];
      check(JSON.stringify(sent.options.kinds) === '["multi"]' && sent.options.difficulty === "harder", "kinds and difficulty go to the core", JSON.stringify(sent.options));
      await h.shot("error");
      await page.click("[data-make-retry]");
      // Back to the look at everything, each choice kept and a way to change it.
      await page.waitForSelector("[data-wizard-review]", { timeout: 3000 });
      const review = await page.$eval("[data-wizard-review]", (e) => e.innerText.replace(/\s+/g, " "));
      check(/Choose all that apply/.test(review) && /Harder/.test(review), "Change and try again shows what was chosen", review);
      await page.click('[data-review-change="sources"]');
      await page.waitForSelector(`[data-source-course="${C241}"] input`, { timeout: 3000 });
      const kept = await page.evaluate((C) => document.querySelector(`[data-source-course="${C}"] input`)?.checked, C241);
      check(kept, "Change and try again keeps the choices");
    },
  },
  {
    name: "f6-review-keyboard",
    sizes: [[1100, 720], [640, 480]],
    mock: mock(),
    async run(page, h) {
      await openStudy(page);
      await page.waitForSelector(`${SHOWN} [data-study-due]:not([disabled])`, { timeout: 3000 });
      await page.focus(`${SHOWN} [data-study-due]`);
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => document.activeElement?.matches("[data-show-answer]")), "the session starts with focus on Show answer");
      const front = await page.evaluate(() => {
        const b = document.activeElement;
        return { described: document.getElementById(b.getAttribute("aria-describedby"))?.querySelector(".sr-only")?.textContent, progress: document.querySelector("[data-session-progress]")?.textContent };
      });
      check(front.described === "What is a bipartite graph?" && front.progress === "Card 1 of 3", "Show answer is described by the front; n of m", JSON.stringify(front));
      await h.shot("front");
      // Space shows the answer: said, focus on the ratings.
      await page.keyboard.press("Space");
      check(await waitFor(page, () => document.activeElement?.matches("[data-ratings]")), "Space flips: focus on the ratings");
      check(await waitFor(page, () => (document.querySelector("[data-session-status]")?.textContent ?? "").startsWith("Answer: A graph whose")), "the answer is announced");
      const names = await page.evaluate(() => [...document.querySelectorAll("[data-rate]")].map((b) => b.textContent).join("|"));
      check(names === "1: Not at all|2: Barely|3: Somewhat|4: Mostly|5: Perfectly", "the ratings are buttons with full names", names);
      await sleep(400); // the answer's fade-in ends
      await h.shot("back");
      // 1: comes back in this session.
      await page.keyboard.press("1");
      check(await waitFor(page, () => document.querySelector("[data-session-progress]")?.textContent === "Card 2 of 4"), "rated 1: the card comes back (4 cards now)");
      check(await focusIs(page, "[data-show-answer]"), "after a rating focus is on the next Show answer");
      // A cloze card: the blank on the front, the sentence on the back.
      const cloze = await page.evaluate(() => ({ blank: !!document.querySelector("[data-card-front] [data-blank]"), spoken: document.querySelector("[data-card-front] .sr-only")?.textContent }));
      check(cloze.blank && cloze.spoken === "The blank of a bipartite graph with an edge is 2.", "a cloze front shows a gap and says 'blank'", JSON.stringify(cloze));
      await page.keyboard.press("Enter");
      await waitFor(page, () => document.activeElement?.matches("[data-ratings]"));
      await page.keyboard.press("4");
      await waitFor(page, () => document.querySelector("[data-session-progress]")?.textContent === "Card 3 of 4");
      await page.keyboard.press("Space");
      await waitFor(page, () => document.activeElement?.matches("[data-ratings]"));
      await page.keyboard.press("5");
      // The repeat of the first card.
      check(await waitFor(page, () => document.querySelector("[data-session-progress]")?.textContent === "Card 4 of 4"), "the card rated 1 is shown again");
      const again = await page.evaluate(() => document.querySelector("[data-card-front] .sr-only")?.textContent);
      check(again === "What is a bipartite graph?", "it is the same card", again);
      await page.keyboard.press("Space");
      await waitFor(page, () => document.activeElement?.matches("[data-ratings]"));
      await page.keyboard.press("3");
      check(await waitFor(page, () => !!document.querySelector("[data-session-summary]")), "after the last card: the summary");
      const sum = await page.evaluate(() => ({ text: document.querySelector("[data-session-summary]")?.innerText ?? "", focus: document.activeElement?.matches("[data-session-summary] h2") }));
      check(sum.focus && /Cards studied\s*3/.test(sum.text) && sum.text.includes("Cards to revisit") && sum.text.includes("What is a bipartite graph?"), "the summary: studied, to revisit, heading focused", sum.text.slice(0, 200));
      check(/Graph theory basics:\s*40%\s*→?\s*(to)?\s*80%/.test(sum.text), "the summary shows the mastery change", sum.text);
      const rated = (await calls(page, "study_rate")).map((c) => c.confidence).join(",");
      check(rated === "1,4,5,3", "each rating went to the core", rated);
      await h.shot("summary");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter").catch(() => {});
    },
  },
  {
    name: "f6-review-motion",
    mock: mock(),
    async run(page) {
      const cdp = await page.createCDPSession();
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await openStudy(page);
      await page.click(`${SHOWN} [data-study-due]`);
      await page.waitForSelector("[data-show-answer]", { timeout: 3000 });
      await page.keyboard.press("Space");
      await page.waitForSelector("[data-card-back]", { timeout: 3000 });
      const anim = await page.evaluate(() => getComputedStyle(document.querySelector("[data-card-back]")).animationName);
      check(anim === "none", "reduced motion: the answer appears without the flip", anim);
    },
  },
  {
    name: "f6-rate-fails",
    mock: mock(),
    async run(page) {
      await openStudy(page);
      await page.click(`${SHOWN} [data-study-due]`);
      await page.waitForSelector("[data-show-answer]", { timeout: 3000 });
      await page.evaluate(() => ((window.__MOCK__.fail ??= {}).study_rate_once = "The disk is full."));
      await page.keyboard.press("Space");
      await waitFor(page, () => document.activeElement?.matches("[data-ratings]"));
      await page.keyboard.press("2");
      check(await waitFor(page, () => (document.querySelector("[data-review-session] [role=alert]")?.textContent ?? "").includes("The disk is full")), "a failed rating says so");
      const still = await page.evaluate(() => document.querySelector("[data-session-progress]")?.textContent);
      check(still === "Card 1 of 3", "the card stays to rate again", still);
      await page.keyboard.press("2");
      check(await waitFor(page, () => document.querySelector("[data-session-progress]")?.textContent === "Card 2 of 4"), "rated again, it goes on (and comes back later)");
    },
  },
  {
    name: "f6-deck-edit",
    sizes: [[1100, 720], [640, 480]],
    mock: mock(),
    async run(page, h) {
      await openStudy(page);
      await page.click(`${SHOWN} [data-open-deck="study/decks/Graph theory basics.md"]`);
      check(await waitFor(page, () => document.activeElement?.matches("[data-deck-title]")), "the deck opens with its title focused");
      const rows = await page.evaluate(() => [...document.querySelectorAll("[data-card-row]")].map((r) => r.innerText.replace(/\s+/g, " ")));
      check(rows.length === 5 && rows[3].includes("Knew it: Perfectly") && rows[0].includes("Not studied yet"), "each card says how well it's known in words", rows[3]);
      // Search.
      await page.type("[data-card-search]", "cycle");
      check(await waitFor(page, () => document.querySelectorAll("[data-card-row]").length === 1), "search narrows the cards");
      check((await status(page, "[data-card-count]")) === "1 card match “cycle”.", "the match count is said");
      await page.click("[data-card-search]", { clickCount: 3 });
      await page.keyboard.press("Backspace");
      // Source opens with file_open.
      await page.click(`[data-source-link="${NOTES}"]`);
      const opened = (await calls(page, "file_open")).at(-1);
      check(opened?.path === NOTES, "a source opens the file", JSON.stringify(opened));
      // Edit a card's answer by keyboard.
      await page.focus('[data-card-row]:nth-child(3) [data-edit-card]');
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => document.activeElement?.matches("[data-edit-front]")), "Edit opens the card inline, focus on its front");
      await page.focus("[data-edit-back]");
      await page.evaluate(() => { const t = document.activeElement; t.setSelectionRange(t.value.length, t.value.length); });
      await page.keyboard.type(" (a tree is connected and has no cycles)");
      await h.shot("editing");
      await page.click("[data-save-card]");
      check(await waitFor(page, () => !document.querySelector("[data-card-editor]")), "Save closes the editor");
      const saved = (await calls(page, "study_deck_save")).at(-1);
      check(saved.cards[2].back === "n − 1 (a tree is connected and has no cycles)" && saved.cards.length === 5, "the edit is saved with the whole deck", JSON.stringify(saved.cards[2]));
      check(await focusIs(page, "[data-card-row]:nth-child(3) [data-edit-card]"), "focus goes back to the card's Edit");
      // Add a card.
      await page.click("[data-add-card]");
      await page.waitForSelector("[data-card-editor='new']");
      await page.click("[data-save-card]");
      check((await status(page, "[data-deck-problem]")).includes("needs a question"), "an empty card says what's missing");
      await page.type("[data-edit-front]", "What is a leaf?");
      await page.type("[data-edit-back]", "A vertex of degree 1.");
      await page.click("[data-save-card]");
      check(await waitFor(page, () => document.querySelectorAll("[data-card-row]").length === 6), "the new card is in the list");
      // Delete a card: asks first, Keep it puts focus back.
      await page.click('[data-card-row]:nth-child(1) [data-delete-card]');
      check(await waitFor(page, () => document.activeElement?.matches("[data-delete-cancel]")), "Delete asks first, focus on Keep it");
      await h.shot("delete");
      await page.click("[data-delete-yes]");
      check(await waitFor(page, () => document.querySelectorAll("[data-card-row]").length === 5), "the card is deleted");
      check(!(await focusIs(page, "body")), "focus isn't lost after a delete", JSON.stringify(await active(page)));
      // Back to Study: focus on the deck's name there.
      await page.click("[data-back-to-study]");
      check(await waitFor(page, () => document.activeElement?.matches('[data-open-deck="study/decks/Graph theory basics.md"]')), "back on the hub, focus on the deck");
    },
  },
  {
    name: "f6-quiz",
    sizes: [[1100, 720], [640, 480]],
    mock: mock(),
    async run(page, h) {
      await openStudy(page);
      await page.click(`${SHOWN} [data-take-quiz="study/quizzes/Test 1 practice.json"]`);
      check(await waitFor(page, () => document.activeElement?.matches("[data-quiz-title]")), "the quiz opens with its title focused");
      // One question at a time: Next goes through every kind.
      const kinds = [];
      for (let i = 0; i < 5; i++) {
        kinds.push(await page.$eval("[data-question]", (q) => q.getAttribute("data-kind")));
        if (i < 4) await page.click("[data-quiz-next]");
      }
      check(kinds.join(",") === "choice,multi,truefalse,short,cloze", "every kind of question is there, one at a time", kinds.join(","));
      check((await page.$$("[data-question]")).length === 1, "only one question shows");
      await page.click('[data-go-question="q1"]');
      check(await waitFor(page, () => document.activeElement?.matches("[data-question-heading]") && document.querySelector("[data-question]")?.getAttribute("data-question") === "q1"), "the map goes back to question 1, its heading focused");
      // Choice by keyboard: arrows move between the radios, Enter goes on.
      await page.focus('[data-question="q1"] input[type=radio]');
      await page.keyboard.press("ArrowDown");
      const picked = await page.evaluate(() => document.querySelector('[data-question="q1"] input:checked')?.value);
      check(picked === "A square (a 4-cycle)", "arrow keys choose within a question", picked);
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => document.querySelector("[data-question]")?.getAttribute("data-question") === "q2" && document.activeElement?.matches("[data-question-heading]")), "Enter on a choice is Next, not hand in");
      check((await calls(page, "study_quiz_submit")).length === 0, "nothing handed in");
      // Multi: two of three right, one wrong.
      for (const i of [1, 2, 3]) {
        await page.focus(`[data-question="q2"] label:nth-child(${i}) input`);
        await page.keyboard.press("Space");
      }
      await page.click("[data-quiz-next]");
      await page.focus('[data-question="q3"] input[type=radio]');
      await page.keyboard.press("Space");
      await page.click("[data-quiz-next]");
      await page.type('[data-question="q4"] textarea', "The sides alternate, so an odd cycle would end on the same side.");
      await page.click("[data-quiz-next]");
      check((await status(page, "[data-answered]")) === "4 of 5 answered", "the answered count", await status(page, "[data-answered]"));
      const map = await page.$$eval("[data-go-question]", (bs) => bs.map((b) => b.getAttribute("aria-label")));
      check(map[0] === "Question 1, answered" && map[4] === "Question 5, no answer yet", "the map says which have answers", JSON.stringify(map));
      // Check with one empty: asks first.
      await page.click("[data-quiz-submit]");
      check(await waitFor(page, () => document.activeElement?.matches("[data-unanswered]")), "an unanswered question: asks first, focus there");
      await page.type('[data-question="q5"] input', "chromatic number");
      await h.shot("taking");
      await page.click("[data-submit-anyway]");
      check(await waitFor(page, () => !!document.querySelector("[data-quiz-results]")), "the results show");
      const r = await page.evaluate(() => ({
        title: document.activeElement?.textContent,
        verdicts: [...document.querySelectorAll("[data-result]")].map((x) => `${x.getAttribute("data-verdict")}:${x.querySelector("h3")?.textContent}`),
        source: !!document.querySelector('[data-result="q1"] [data-result-source]'),
      }));
      check(r.title?.startsWith("Test 1 practice: 4.2 of 5 (83%)"), "the score is the focused heading", r.title);
      check(r.verdicts[0] === "correct:Question 1:Correct" && r.verdicts[1].startsWith("partial:Question 2:Partly right") && r.verdicts[2] === "correct:Question 3:Correct", "each answer is marked in words", r.verdicts.join(" | "));
      check(r.source, "a result links its source");
      await h.shot("results");
      // Review my mistakes.
      await page.click("[data-review-mistakes]");
      check(await waitFor(page, () => document.querySelector("[data-mistakes-review]")?.getAttribute("data-mistakes-review") === "done"), "the review arrives");
      const rev = await page.evaluate(() => ({ text: document.querySelector("[data-review-summary]")?.innerText ?? "", focus: document.activeElement?.id }));
      check(rev.text.includes("chromatic number") && rev.focus === "mistakes-review-title", "the AI summary shows, its heading focused", JSON.stringify(rev));
      await h.shot("review");
      // Make cards from my mistakes: starts at once.
      await page.click("[data-cards-from-mistakes]");
      check(await waitFor(page, () => !!document.querySelector("[data-make-done]"), null, 5000), "cards from mistakes are made");
      const sent = (await calls(page, "study_make_deck")).at(-1);
      check(sent.options.fromAttempt?.startsWith(".phaethon/study/attempts/") && sent.sources[0] === REVIEW, "made from the attempt and the quiz's sources", JSON.stringify(sent));
      await page.click("[data-make-next]");
      check(await waitFor(page, () => !!document.querySelector("[data-show-answer]")), "Study them now starts their session");
    },
  },
  {
    name: "f6-quiz-grade-error",
    mock: mock({ ...STUDY, gradeError: "Claude Code is not logged in. Run claude once in a terminal to log in." }),
    async run(page, h) {
      await openStudy(page);
      await page.click(`${SHOWN} [data-take-quiz="study/quizzes/Test 1 practice.json"]`);
      await page.waitForSelector("[data-quiz-submit]");
      await page.click("[data-quiz-submit]");
      await page.click("[data-submit-anyway]");
      check(await waitFor(page, () => !!document.querySelector("[data-quiz-error]")), "a grading error shows");
      const t = await status(page, "[data-quiz-error]");
      check(t.includes("not logged in") && t.includes("Open Settings"), "in plain words, with Settings", t);
      check((await calls(page, "study_quiz_submit"))[0].answers.q1 === undefined, "nothing made up for empty answers");
      await h.shot("error");
    },
  },
];
