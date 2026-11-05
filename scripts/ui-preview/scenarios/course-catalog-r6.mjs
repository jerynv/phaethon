import { SETTINGS, check, showSidebar } from '../audit-fixtures.mjs';

const shown = '[data-space-pane][data-shown] [data-view-shown]';
const names = Array.from({ length: 24 }, (_, index) => index === 0
  ? 'Discrete Structures for Computer Science and Applications to Advanced Combinatorial Models'
  : index === 1 ? 'Calculus II' : `Seminar ${String(index + 1).padStart(2, '0')}`);
const folders = names.map(name => `courses/${name}`);
const parts = ['overview', 'syllabus', 'assignments', 'announcements', 'files', 'grades'];
const courses = names.map((name, index) => ({ id: String(101 + index), name, code: `TEST-${index + 1}`, term: 'Fall 2026', imported: true, current: true }));
const mock = {
  settings: SETTINGS, threads: {},
  spaces: [{ id: 'school', name: 'School', description: '', hue: 240, educationEnabled: true }],
  lms: { list: [{ id: 'c1', kind: 'canvas', address: 'https://example.instructure.com', signedIn: true, courses: courses.map(course => course.id) }], courses },
  courseAccess: { school: Object.fromEntries(courses.map(course => [`c1/${course.id}`, parts])) },
  study: { courses: names.map((name, index) => ({ course: `Old study title ${index}`, folder: folders[index] })), decks: {}, quizzes: {} },
  lmsGrades: { school: names.map((name, index) => ({ connection: 'c1', courseId: String(101 + index), course: `Old grade title ${index}`, folder: folders[index], updated: Date.now(), current: { percent: 71.2 + index, letter: 'B' }, groups: [], items: [] })) },
};

async function view(page, h, name) {
  await showSidebar(page);
  await h.click(`#spaces-sidebar:not([hidden]) [data-view-tab="${name}"]`);
  await page.waitForSelector(`${shown} [data-${name === 'study' ? 'study-hub' : 'grades-view'}]`, { visible: true });
}

export default [{
  name: 'course-catalog-r6', sizes: [[1100, 720], [640, 480]], sizesRequired: true, mock,
  async run(page, h) {
    await view(page, h, 'study');
    await page.waitForFunction(selector => document.querySelectorAll(`${selector} [data-open-course]`).length === 24, {}, shown);
    await page.waitForFunction(selector => [...document.querySelectorAll(`${selector} [data-course-catalog-name]`)].some(node => node.textContent.startsWith('Discrete Structures')), {}, shown);
    const study = await page.$$eval(`${shown} [data-open-course]`, rows => rows.map(row => ({
      name: row.querySelector('[data-course-catalog-name]').textContent,
      height: row.getBoundingClientRect().height,
      width: row.getBoundingClientRect().width,
      left: row.getBoundingClientRect().left,
    })));
    check(study.length === 24 && study.some(row => row.name === names[0]) && !study.some(row => row.name.startsWith('Old study')), 'Study uses canonical imported names for every course');
    check(Math.max(...study.map(row => row.height)) - Math.min(...study.map(row => row.height)) < 1, 'long and short names share a consistent compact row height', JSON.stringify(study.slice(0, 3)));
    check(Math.max(...study.map(row => row.height)) <= 60 && study.every(row => row.left === study[0].left && row.width === study[0].width), 'the catalog uses aligned compact rows rather than large summary tiles', JSON.stringify(study.slice(0, 3)));
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'the compact catalog fits the narrow window');
    await h.shot('study');
    await h.click(`${shown} input[aria-label="Search courses"]`);
    await page.type(`${shown} input[aria-label="Search courses"]`, 'TEST-24');
    await page.waitForFunction(selector => document.querySelectorAll(`${selector} [data-open-course]`).length === 1, {}, shown);
    check(await page.$eval(`${shown} [data-course-catalog-name]`, node => node.textContent) === names[23], 'course code search reaches a course beyond the initial viewport');
    await h.click(`${shown} [data-open-course]`);
    await page.waitForSelector(`${shown} [data-study-hub][data-course-context="c1/124"] [data-course-back]`);
    check(await page.$eval(`${shown} [data-study-hub] h2`, node => node.textContent) === names[23], 'opening the search result keeps the canonical identity and title');
    await view(page, h, 'grades');
    await page.waitForSelector(`${shown} [data-grades-course="124"]`);
    check(await page.$eval(`${shown} [data-grades-view] h2`, node => node.textContent) === names[23], 'Grades follows the exact selected course with the same canonical title');
    await h.click(`${shown} [data-course-back]`);
    await page.waitForSelector(`${shown} [data-course-catalog]`);
    const gradeNames = await page.$$eval(`${shown} [data-course-catalog-name]`, rows => rows.map(row => row.textContent));
    check(gradeNames.length === 24 && gradeNames.every((name, index) => study[index]?.name === name), 'Study and Grades catalog names and order agree despite old source titles');
    check(await page.$eval(`${shown} [data-open-course="c1:101"] [data-course-catalog-metric]`, node => node.textContent) === '71.2%', 'the compact grade row preserves the real saved grade');
    await h.shot('grades');
    await page.type(`${shown} input[aria-label="Search courses"]`, 'no course matches this');
    await page.waitForSelector(`${shown} [data-course-catalog-empty]`);
    check(!await page.$(`${shown} [data-open-course]`), 'unmatched search shows a distinct empty result without stale rows');
    await h.click(`${shown} [data-course-catalog-empty] button`);
    await page.waitForFunction(selector => document.querySelectorAll(`${selector} [data-open-course]`).length === 24, {}, shown);
    await view(page, h, 'study');
    await page.waitForSelector(`${shown} input[aria-label="Search courses"]`);
    check(await page.$eval(`${shown} input[aria-label="Search courses"]`, input => input.value) === 'TEST-24', 'returning from a course preserves the Study catalog search');
    await page.focus(`${shown} [data-open-course]`); await page.keyboard.press('Enter');
    await page.waitForSelector(`${shown} [data-study-hub][data-course-context="c1/124"] [data-course-back]`);
    check(true, 'the whole catalog row remains keyboard-operable');
  },
}];
