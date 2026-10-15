import { readFileSync } from "node:fs";
import { SETTINGS, openSettings, park } from "../audit-fixtures.mjs";
const Q = JSON.parse(readFileSync("/private/tmp/claude-501/-Users-jeryn-Documents-GitHub-phaethon/dcf51079-a694-483f-a203-a25dc81a4c4c/scratchpad/real-quiz.json", "utf8"));
const P = "study/quizzes/C241 Test 1 multiple-choice review.json";
const SHOWN = "[data-space-pane][data-shown]";
const C = "courses/CSCI-C 241 Fall 2026 (All Sections)";
const study = { step: 30, courses: [{ course: "CSCI-C 241 Fall 2026 (All Sections)", folder: C }], decks: {}, quizzes: { [P]: Q } };
const full = (page, n) => page.screenshot({ path: "/private/tmp/claude-501/-Users-jeryn-Documents-GitHub-phaethon/dcf51079-a694-483f-a203-a25dc81a4c4c/scratchpad/look/" + n + ".png", fullPage: true });
async function scrollShots(page, n) {
  const el = await page.evaluateHandle(() => { let e = document.querySelector("[data-quiz-form], [data-quiz-results]"); while (e && !(e.scrollHeight > e.clientHeight + 4 && getComputedStyle(e).overflowY !== "visible")) e = e.parentElement; return e; });
  const H = await page.evaluate((e) => e ? e.scrollHeight : 0, el);
  for (let y = 0, i = 0; y < H && i < 40; y += 650, i++) { await page.evaluate((e, y) => e && (e.scrollTop = y), el, y); await new Promise(r => setTimeout(r, 120)); await page.screenshot({ path: "/private/tmp/claude-501/-Users-jeryn-Documents-GitHub-phaethon/dcf51079-a694-483f-a203-a25dc81a4c4c/scratchpad/look/" + n + "-" + String(i).padStart(2, "0") + ".png" }); }
}
export default [
  { name: "zz-quiz", sizes: [[1280, 800]], themes: ["light"], mock: { settings: SETTINGS, threads: {}, study },
    async run(page, h) {
      await page.waitForSelector(SHOWN + ' [data-view-tab="study"]'); await page.click(SHOWN + ' [data-view-tab="study"]');
      await page.waitForSelector(SHOWN + " [data-study-hub]"); await new Promise(r => setTimeout(r, 300));
      await page.screenshot({ path: "/private/tmp/claude-501/-Users-jeryn-Documents-GitHub-phaethon/dcf51079-a694-483f-a203-a25dc81a4c4c/scratchpad/look/hub.png" });
      await page.click(SHOWN + ' [data-take-quiz="' + P + '"]'); await page.waitForSelector("[data-quiz-form]"); await new Promise(r => setTimeout(r, 500));
      await scrollShots(page, "take");
      // answer: right on most, wrong on every 4th, skip one
      await page.evaluate((qs) => { qs.forEach((q, i) => { if (i === 7) return; const want = i % 4 === 3 ? q.choices.find(c => c !== q.answer) : q.answer; const box = document.querySelector('[data-question="' + q.id + '"]'); const inp = [...box.querySelectorAll("input")].find(x => x.value === want); inp && inp.click(); }); }, Q.questions);
      await page.click("[data-quiz-submit]"); await new Promise(r => setTimeout(r, 300)); await page.screenshot({ path: "/private/tmp/claude-501/-Users-jeryn-Documents-GitHub-phaethon/dcf51079-a694-483f-a203-a25dc81a4c4c/scratchpad/look/ask.png" });
      await page.click("[data-submit-anyway]"); await page.waitForSelector("[data-quiz-results]"); await new Promise(r => setTimeout(r, 500));
      await scrollShots(page, "results");
    } },
  { name: "zz-spaces", sizes: [[1280, 800], [800, 700]], themes: ["light"], mock: { settings: SETTINGS },
    async run(page, h) { await openSettings(page, h, "spaces"); await park(page); } },
];
