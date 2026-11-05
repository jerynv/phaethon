// A real AI-help click hands the populated draft to the committed Chat view.
import { check, SETTINGS } from "../audit-fixtures.mjs";

const NAV = ':is(#spaces-sidebar:not([hidden]), [data-space-pane][data-shown])';
const COURSE = 'courses/Discrete mathematics';
const PATH = 'study/quizzes/Focus.json';
const COMPOSER = '[data-space-pane][data-shown] [data-composer-input]';
const quiz = { title: 'Focus', course: 'Discrete mathematics', sources: [`${COURSE}/notes.md`], created: 17,
  questions: [1, 2].map((n) => ({ id: `q${n}`, kind: 'choice', prompt: `Question ${n}: choose the injective function.`, choices: ['f(x)=x', 'f(x)=0'], answer: 'f(x)=x', explanation: 'Distinct inputs remain distinct.' })) };

const cases = [{
  name: 'compose-focus-quiz-ai',
  sizes: [[1100, 720], [640, 480]],
  mock: { settings: { ...SETTINGS, backend: 'codex-cli' }, threads: {}, study: { courses: [{ course: 'Discrete mathematics', folder: COURSE }], decks: {}, quizzes: { [PATH]: quiz } } },
  async run(page, h) {
    const clickVisible = async (selector) => {
      await page.waitForSelector(selector, { visible: true });
      await h.click(selector);
    };
    await page.waitForSelector(COMPOSER, { visible: true });
    await clickVisible(`${NAV} [data-view-tab="study"]`);
    await clickVisible(`[data-open-course="${COURSE}"]`);
    await clickVisible(`[data-take-quiz="${PATH}"]`);
    await page.waitForSelector('[data-question-help="q1"]');
    await clickVisible('[data-question-help="q1"]');
    await page.waitForFunction((selector) => document.querySelector(selector)?.value.includes('Question 1'), {}, COMPOSER);
    const focused = await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector), { timeout: 3000 }, COMPOSER).then(() => true, () => false);
    const state = await page.$eval(COMPOSER, (input) => ({ active: document.activeElement?.outerHTML.slice(0, 160), inert: !!input.closest('[inert]'), text: input.value }));
    check(focused, 'the first AI-help draft is focused after Chat commits', JSON.stringify(state));
    const draft = state.text;
    await clickVisible(`${NAV} [data-view-tab="study"]`);
    await clickVisible('[data-question-help="q1"]');
    await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector), { timeout: 3000 }, COMPOSER);
    check(await page.$eval(COMPOSER, (input, draft) => input.value === draft, draft), 'the existing-draft guard restores focus and preserves the draft');
    check(await page.evaluate(() => !window.__calls.some(([name]) => name === 'agent_send')), 'AI help prepares a draft without sending it');
  },
}];

export default ["phaethon", "codex-cli"].flatMap((backend) => [false, true].map((reduced) => ({
  ...cases[0],
  name: `compose-focus-quiz-ai-${backend}${reduced ? "-reduced-motion" : ""}`,
  mock: { ...cases[0].mock, settings: { ...SETTINGS, backend, appearance: { ...SETTINGS.appearance, reduceMotion: reduced ? "on" : "system" } } },
  async run(page, h) {
    if (reduced) {
      await page.waitForFunction(() => document.documentElement.dataset.motion === "reduce");
      check(true, "the actual reduced-motion preference is applied");
    }
    await cases[0].run(page, h);
  },
})));
