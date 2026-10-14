// A quiz made from a chat reply opens Study (f13): nothing moves when it does. Behaviour checks: check(...) fails the run.
//   f14-generate-shift  Generate quiz, then Study opens on it: the space header, the view switcher and the panel keep
//                       their boxes, pixel for pixel, and so does Chat when you go back
import { SETTINGS, check } from "../audit-fixtures.mjs";

const SHOWN = "[data-space-pane][data-shown]";
const M301 = "courses/MATH-M 301 Fall 2026";
const BLOCK = { kind: "quiz", title: "Eigenvalues practice", focus: "eigenvalues", count: 3, kinds: ["choice", "truefalse"], difficulty: "exam", sources: [M301] };
const REPLY = `Here’s what I’ll put together: three questions on eigenvalues.\n\n\`\`\`phaethon-study\n${JSON.stringify(BLOCK)}\n\`\`\``;
const QUIZ = [
  { id: "q1", kind: "choice", prompt: "What are the eigenvalues of a 2 by 2 identity matrix?", choices: ["1 and 1", "0 and 1", "2", "none"], answer: "1 and 1", explanation: "Every vector is an eigenvector with eigenvalue 1." },
  { id: "q2", kind: "truefalse", prompt: "An eigenvector can be the zero vector.", choices: ["true", "false"], answer: "false", explanation: "Eigenvectors are nonzero." },
];
const boxes = (page) =>
  page.evaluate((S) => {
    const r = (el) => (el ? [...Object.values(el.getBoundingClientRect().toJSON())].slice(0, 4).map((n) => Math.round(n * 100) / 100) : null);
    const pane = document.querySelector(S);
    return JSON.stringify({
      header: r(pane.querySelector("[data-space-header]")),
      switcher: r(pane.querySelector("[data-view-switcher]")),
      panel: r(pane.querySelector("[role=tabpanel][data-view-shown]")),
    });
  }, SHOWN);
const waitFor = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);

export default [
  {
    name: "f14-generate-shift",
    sizes: [[1100, 720], [640, 480]],
    mock: {
      settings: SETTINGS,
      threads: { school: [{ role: "user", text: "Can you quiz me on eigenvalues?", attachments: [] }, { role: "assistant", text: REPLY, attachments: [] }] },
      study: { courses: [{ course: "MATH-M 301 Linear Algebra", folder: M301 }], step: 60, chatQuiz: QUIZ },
    },
    async run(page, h) {
      await page.waitForSelector(`${SHOWN} [data-study-action-make]`, { timeout: 6000 });
      await page.mouse.move(2, 400);
      const chat = await boxes(page);
      await page.click(`${SHOWN} [data-study-action-make]`);
      const opened = await waitFor(page, (S) => document.querySelector(`${S} [data-view-tab="study"]`)?.getAttribute("aria-selected") === "true" && !!document.querySelector(`${S} [data-quiz-form]`), SHOWN);
      check(opened, "the quiz opens in Study");
      await h.idle();
      await page.mouse.move(2, 400);
      const study = await boxes(page);
      console.log(`     f14 generate: chat ${chat} -> study ${study}`);
      check(study === chat, "Study opens without moving the header, the switcher or the panel", `${chat} -> ${study}`);
      await h.shot("study");
      await page.click(`${SHOWN} [data-view-tab="chat"]`);
      await h.idle();
      await page.mouse.move(2, 400);
      check((await boxes(page)) === chat, "and Chat is where it was");
    },
  },
];
