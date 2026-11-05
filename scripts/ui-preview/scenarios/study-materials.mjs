import lmsCases from "./lms-revision.mjs";
import { check } from "../audit-fixtures.mjs";
const base = lmsCases.find(item => item.name === "lms-revision-sources").mock;
const folder = "courses/Discrete Structures";
const path = `${folder}/modules.md`;
export default [{
  name: "study-course-materials",
  sizes: [[1100,720],[640,480]],
  mock: {
    ...base,
    study: { courses: [{ course: "Discrete Structures", folder }], decks: {}, quizzes: {} },
    lmsContent: { "c1/101": [{ path, title: "Second algebra module", kind: "module", anchor: "raw-math-anchor", headingIndex: 1 }] },
    files: { ...base.files, [path]: { kind: "markdown", text: "# Course modules\n\n## First $x^2$\n\nSource one\n\n## Second $y^2$\n\nSource two" } },
  },
  async run(page,h) {
    await page.click(':is(#spaces-sidebar:not([hidden]),[data-space-pane][data-shown]) [data-view-tab="study"]');
    await page.waitForSelector(`[data-open-course="${folder}"]`);
    await page.click(`[data-open-course="${folder}"]`);
    await h.click('[data-study-materials]');
    await page.waitForSelector('[data-course-content-open]');
    check(!await page.$('[data-settings-header]'), "course materials are available from Study without opening Settings");
    await h.shot('materials');
    await page.click('[data-course-content-open]');
    await page.waitForFunction(() => document.activeElement?.matches('[data-md-depth="2"]') && document.activeElement.textContent.startsWith('Second'));
    check(true,"native heading ordinal targets rendered math headings independently of slug text");
    await h.shot('source');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-file-viewer]'));
    await page.$$eval('[role="tab"]', tabs => tabs.find(t => t.textContent === 'Practice').click());
    check(!await page.$('[data-course-content]'), "returning to Practice preserves the course workspace");
    check(await page.evaluate(() => !window.__calls.some(([cmd]) => cmd === 'agent_send')), "browsing source material never sends a model turn");
  },
}];
