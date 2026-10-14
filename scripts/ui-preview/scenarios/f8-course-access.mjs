// Course access: course sites belong to the vault, and each space sees only
// the courses (and parts of them) the person allows. Behaviour checks: check(...) fails the run.
//   f8-grid            Settings › Course sites: a grid of spaces by parts per course, by keyboard (one Tab stop,
//                      arrows, Space, All / None), each change saved and said
//   f8-space-courses   Settings › Spaces: the courses each space can see, in words, and the way to change it
//   f8-import-access   the import's "Who can see these courses": the current space by default, others by choice
//   f8-no-access       a space that can't see any courses: Study, Grades and Plan say so and lead to Settings
import { SETTINGS, check, park } from "../audit-fixtures.mjs";

const COMPOSER = "[data-composer-input]";
const shown = "[data-space-pane][data-shown]";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const chord = async (page, keys) => {
  for (const k of keys) await page.keyboard.down(k);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
};
const waitFor = (page, fn, arg, timeout = 4000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const focused = (page) => page.evaluate(() => ({ cell: document.activeElement?.dataset.cell ?? null, name: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "" }));
const settingsSaid = (page, re) =>
  page.waitForFunction((re) => [...document.querySelectorAll('[role="status"]')].some((s) => new RegExp(re).test(s.textContent ?? "")), { timeout: 3000 }, re.source).then(() => true, () => false);

const ALL = ["overview", "syllabus", "assignments", "announcements", "files", "grades"];
const LMS = {
  list: [{ id: "c1", kind: "canvas", address: "https://iu.instructure.com", schoolName: "Indiana University Bloomington", signedIn: true, lastSync: Date.UTC(2026, 9, 9, 18), courses: ["101", "102"] }],
  step: 40,
};
/** School sees all of both courses; Work sees nothing. */
const MOCK = { settings: SETTINGS, threads: {}, lms: LMS, courseAccess: { school: { "c1/101": [...ALL], "c1/102": [...ALL] } } };

async function openCourseSites(page) {
  await page.waitForSelector(COMPOSER, { timeout: 5000 });
  await chord(page, ["Meta", ","]);
  await page.waitForSelector('[data-testid="settings-tab-courses"]', { timeout: 3000 });
  await page.$eval('[data-testid="settings-tab-courses"]', (el) => el.click());
  await page.waitForSelector("[data-access-grid]", { timeout: 3000 });
}

export default [
  {
    name: "f8-grid",
    sizes: [[1100, 720], [640, 480]],
    mock: MOCK,
    async run(page, h) {
      await openCourseSites(page);
      const grid = '[data-access-grid="c1/101"]';
      // A real table: named by its course, a column per part, a row per space, a name on every checkbox.
      const shape = await page.evaluate((g) => {
        const t = document.querySelector(g);
        return {
          role: t.getAttribute("role"),
          name: document.getElementById(t.getAttribute("aria-labelledby"))?.textContent,
          cols: [...t.querySelectorAll('thead th[scope="col"]')].map((th) => th.textContent.trim()),
          rows: [...t.querySelectorAll('tbody th[scope="row"]')].map((th) => th.getAttribute("aria-label") ?? th.textContent.trim()),
          unnamed: [...t.querySelectorAll("input, button")].filter((x) => !x.getAttribute("aria-label")).length,
          school: [...t.querySelectorAll('[data-access-row="school"] input')].map((i) => i.checked),
          work: [...t.querySelectorAll('[data-access-row="work"] input')].map((i) => i.checked),
          stops: [...t.querySelectorAll("input, button")].filter((x) => x.tabIndex === 0).length,
        };
      }, grid);
      check(shape.role === "grid" && shape.name === "Discrete Structures for Computer Science", "each course is a grid named by the course", JSON.stringify(shape));
      check(shape.cols.join("|") === "Space|Overview|Syllabus|Assignments|Announcements|Files|Grades", "a column header per part", shape.cols.join("|"));
      check(shape.rows.join("|") === "School|Work" && shape.unnamed === 0, "a row header per space and a name on every control", JSON.stringify(shape));
      check(shape.school.every(Boolean) && !shape.work.some(Boolean), "School sees all of it, Work nothing", JSON.stringify(shape));
      check(shape.stops === 1, "the grid is one stop in the Tab order", String(shape.stops));
      // As a screen reader gets it: row headers named by the space alone, column headers by the part.
      const tree = await page.accessibility.snapshot({ root: await page.$(grid), interestingOnly: false });
      const named = (n, role, out = []) => (n.role === role && out.push(n.name), (n.children ?? []).forEach((c) => named(c, role, out)), out);
      check(named(tree, "rowheader").join("|") === "School|Work" && named(tree, "columnheader").length === 7 && tree.role === "grid", "the accessibility tree has the grid, its row and column headers", JSON.stringify({ rows: named(tree, "rowheader"), cols: named(tree, "columnheader"), role: tree.role }));
      await page.$eval(grid, (e) => e.scrollIntoView({ block: "center" }));
      await sleep(500);
      await h.shot("grid");
      // Tab into the grid: the first cell. Arrow down to Work, right to Syllabus, Space checks it.
      await page.focus('[data-sites-import]');
      for (let i = 0; i < 20; i++) {
        if (await page.evaluate((g) => !!document.activeElement?.closest(g), grid)) break;
        await page.keyboard.press("Tab");
      }
      let f = await focused(page);
      check(f.cell === "0:2" && f.name === "School: Overview", "Tab lands on the first part", JSON.stringify(f));
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowRight");
      f = await focused(page);
      check(f.cell === "1:3" && f.name === "Work: Syllabus", "the arrow keys move between cells", JSON.stringify(f));
      await page.keyboard.press("Space");
      check(await settingsSaid(page, /Work can now see the syllabus of Discrete Structures/), "the change is said");
      let set = (await calls(page, "course_access_set")).at(-1);
      check(set.space === "work" && set.course === "c1/101" && set.parts.join() === "syllabus", "it is saved at once, for that space and course", JSON.stringify(set));
      f = await focused(page);
      check(f.cell === "1:3", "focus stays on the cell", JSON.stringify(f));
      // End: the row's last part; Home: its first control, All, beside the space's name. All gives every part.
      await page.keyboard.press("End");
      f = await focused(page);
      check(f.cell === "1:7" && f.name === "Work: Grades", "End goes to the row's end", JSON.stringify(f));
      await page.keyboard.press("Home");
      f = await focused(page);
      check(f.cell === "1:0" && f.name === "Work: all of Discrete Structures for Computer Science", "Home goes to All", JSON.stringify(f));
      await page.keyboard.press("Enter");
      check(await settingsSaid(page, /Work can now see all of Discrete Structures/), "All is said");
      set = (await calls(page, "course_access_set")).at(-1);
      check(set.parts.join() === ALL.join(), "All allows every part", JSON.stringify(set));
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      check(await settingsSaid(page, /Work can no longer see Discrete Structures/), "None is said");
      set = (await calls(page, "course_access_set")).at(-1);
      check(set.parts.length === 0, "None allows nothing", JSON.stringify(set));
      await chord(page, ["Control", "Home"]);
      f = await focused(page);
      check(f.cell === "0:0", "Ctrl+Home goes to the first cell", JSON.stringify(f));
      // Tab leaves the grid in one step.
      await page.keyboard.press("Tab");
      const out = await page.evaluate((g) => !document.activeElement?.closest(g), grid);
      check(out, "one Tab leaves the grid");
      // A failed save puts the box back and says why.
      await page.evaluate(() => (window.__MOCK__.lms.accessFail = "course-access.json couldn’t be saved: disk full"));
      await page.click(`${grid} [data-cell="1:5"]`);
      check(await waitFor(page, () => [...document.querySelectorAll('[role="alert"]')].some((a) => a.textContent.includes("disk full"))), "a failed save says why");
      check(!(await page.$eval(`${grid} [data-cell="1:5"]`, (i) => i.checked)), "and the box goes back");
      // Let any tooltip the pointer opened fade before the picture.
      await park(page);
      await sleep(400);
      await h.shot("after");
    },
  },
  {
    name: "f8-space-courses",
    sizes: [[1100, 720], [640, 480]],
    themes: ["light"],
    mock: { ...MOCK, courseAccess: { school: { "c1/101": [...ALL], "c1/102": [...ALL] }, work: { "c1/101": ["syllabus", "files"] } } },
    async run(page, h) {
      await page.waitForSelector(COMPOSER, { timeout: 5000 });
      await chord(page, ["Meta", ","]);
      await page.waitForSelector('[data-testid="settings-tab-spaces"]', { timeout: 3000 });
      await page.$eval('[data-testid="settings-tab-spaces"]', (el) => el.click());
      await page.waitForSelector('[data-space-courses="work"] [data-space-course]', { timeout: 3000 });
      const lists = await page.evaluate(() =>
        Object.fromEntries([...document.querySelectorAll("[data-space-courses]")].map((d) => [d.dataset.spaceCourses, [...d.querySelectorAll("[data-space-course]")].map((li) => li.innerText.replace(/\s+/g, " ").trim())])),
      );
      check(lists.school.length === 2 && lists.school.every((t) => t.endsWith("all of it")), "School sees both courses, all of them", JSON.stringify(lists));
      check(lists.work.join() === "Discrete Structures for Computer Science syllabus, files", "Work sees one course, in words", JSON.stringify(lists));
      await page.$eval('[data-space-courses="work"]', (e) => e.scrollIntoView({ block: "center" }));
      await h.shot("spaces");
      await page.click('[data-space-courses="work"] [data-space-courses-change]');
      await page.waitForSelector("[data-access-grid]", { timeout: 3000 });
      const ok = await waitFor(page, () => document.activeElement?.closest('[data-access-row="work"]') != null);
      check(ok, "Choose which courses Work can see goes to Course sites, at Work’s row");
    },
  },
  {
    name: "f8-import-access",
    sizes: [[1100, 720], [640, 480]],
    themes: ["light"],
    mock: MOCK,
    async run(page, h) {
      await page.waitForSelector(COMPOSER, { timeout: 5000 });
      await page.focus(COMPOSER);
      await chord(page, ["Meta", "k"]);
      await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
      await page.keyboard.type("import courses");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-existing-site="c1"]', { timeout: 3000 });
      await page.click('[data-existing-site="c1"]');
      await page.waitForSelector("[data-course-list]", { timeout: 3000 });
      // Who can see them is its own step, after the courses.
      await page.click("[data-step-next]");
      await page.waitForSelector('[data-course-import][data-step="viewers"] [data-import-viewers]', { timeout: 3000 });
      const v = await page.evaluate(() => {
        const f = document.querySelector("[data-import-viewers]");
        return {
          legend: f.querySelector("legend")?.textContent,
          checked: [...f.querySelectorAll("[data-import-viewer]")].filter((l) => l.querySelector("input").checked).map((l) => l.dataset.importViewer),
          described: !!document.getElementById((f.getAttribute("aria-describedby") ?? "").split(" ")[0])?.textContent,
        };
      });
      check(v.legend === "Who can see these courses" && v.checked.join() === "school" && v.described, "the current space can see them by default", JSON.stringify(v));
      // None chosen: said, and focus goes to the choices.
      await page.click('[data-import-viewer="school"] input');
      await page.click("[data-step-next]");
      const err = await page.evaluate(() => ({ text: document.querySelector("[data-import-viewers] [data-field-error]")?.textContent, focus: document.activeElement?.closest("[data-import-viewer]")?.dataset.importViewer }));
      check(err.text === "Choose at least one space that can see these courses." && err.focus === "school", "no space chosen: said, focus on the choices", JSON.stringify(err));
      check((await calls(page, "lms_import")).length === 0, "nothing is imported");
      await page.click('[data-import-viewer="school"] input');
      await page.click('[data-import-viewer="work"] input');
      await h.shot("viewers");
      await page.click("[data-step-next]");
      await page.waitForSelector('[data-course-import][data-step="review"] [data-import-start]', { timeout: 3000 });
      const review = await page.$eval("[data-wizard-review]", (e) => e.innerText.replace(/\s+/g, " "));
      check(/Who can see them School, Work/.test(review), "the review says who will see them", review);
      await page.click("[data-import-start]");
      await page.waitForSelector('[data-course-import][data-step="progress"]', { timeout: 3000 });
      const imp = (await calls(page, "lms_import")).at(-1);
      check(imp.spaces.join() === "school,work" && imp.courseIds.join() === "103", "the core is told who can see the new course", JSON.stringify(imp));
      await waitFor(page, () => document.querySelector("[data-step-title]")?.textContent === "Import finished", undefined, 6000);
      const seen = await page.$eval("[data-import-seen-by]", (e) => e.textContent);
      check(seen === "New courses can be seen in School, Work.", "the summary says who can see them", seen);
      const access = await page.evaluate(() => window.__MOCK__.courseAccess.work["c1/103"]);
      check(access?.length === 6, "Work now sees all of the new course", JSON.stringify(access));
    },
  },
  {
    name: "f8-no-access",
    sizes: [[1100, 720], [640, 480]],
    mock: {
      ...MOCK,
      // Work is the space in front; it sees no course.
      spaces: [
        { id: "school", name: "School", description: "Courses", hue: 240 },
        { id: "work", name: "Work", description: "Projects", hue: 50, lastUsed: Date.now() },
      ],
    },
    async run(page, h) {
      await page.waitForSelector(`${shown}[data-space-pane="work"]`, { timeout: 5000 });
      const empty = async (view) => {
        await page.click(`${shown} [data-view-tab="${view}"]`);
        const root = `${shown} [data-${view === "study" ? "study-hub" : `${view}-view`}]`;
        await page.waitForSelector(root, { timeout: 5000 });
        await page.waitForSelector(`${root} [data-no-course-access]`, { timeout: 3000 });
        return page.$eval(`${root} [data-no-course-access]`, (e) => e.innerText.replace(/\s+/g, " ").trim());
      };
      let t = await empty("study");
      check(t.startsWith("This space can’t see any courses. Choose which ones in Settings › Course sites."), "Study says the space can’t see any courses", t);
      check(!(await page.$(`${shown} [data-empty-import]`)), "and doesn’t offer to import them again");
      await h.shot("study");
      t = await empty("grades");
      check(t.startsWith("This space can’t see any courses."), "Grades says so too", t);
      await h.shot("grades");
      t = await empty("plan");
      check(t.startsWith("This space can’t see any courses."), "Plan’s Coming up says so too", t);
      await h.shot("plan");
      await page.click(`${shown} [data-plan-view] [data-open-course-access]`);
      await page.waitForSelector("[data-access-grid]", { timeout: 3000 });
      check(true, "Choose in Settings opens Course sites");
      // Let Work see the syllabus only, in the grid: the views follow at once, and Grades says it can't see grades.
      await page.click('[data-access-grid="c1/101"] [data-access-row="work"] [data-access-part="syllabus"]');
      await waitFor(page, () => window.__calls.some(([c]) => c === "course_access_set"));
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("[data-access-grid]"), { timeout: 3000 });
      t = await empty("grades");
      check(t.startsWith("This space can’t see the grades of its courses."), "with no grades allowed, Grades says that", t);
    },
  },
];
