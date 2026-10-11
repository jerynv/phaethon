// Feature round 5: Import courses from a school's course site (Canvas,
// Brightspace, Moodle, Blackboard). The fake core is the lms block in
// mock-ipc.js: three schools in the Canvas search, five courses (three
// current, two past), and an import where one course has a skipped part and
// one fails. Each scenario throws when the behaviour is wrong.
import { SETTINGS, check } from "../audit-fixtures.mjs";

const COMPOSER = "[data-composer-input]";
const DIALOG = "[data-course-import]";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter((c) => c[0] === cmd).map((c) => c[1]), cmd);
const chord = async (page, keys) => {
  for (const k of keys) await page.keyboard.down(k);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
};
const waitFor = (page, fn, arg, timeout = 4000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);

/** The dialog's step, its title, and whether that title has focus. */
const stepOf = (page) =>
  page.evaluate((D) => {
    const d = document.querySelector(D);
    const t = d?.querySelector("[data-step-title]");
    return d ? { step: d.getAttribute("data-step"), title: t?.textContent ?? "", focused: document.activeElement === t, label: d.querySelector("[data-step-label]")?.textContent ?? null } : null;
  }, DIALOG);
const waitStep = async (page, step) => {
  const ok = await waitFor(page, ([D, s]) => document.querySelector(D)?.getAttribute("data-step") === s, [DIALOG, step]);
  check(ok, `the dialog moves to the ${step} step`, JSON.stringify(await stepOf(page)));
  // The heading takes focus a frame later.
  await waitFor(page, (D) => document.activeElement?.matches(`${D} [data-step-title]`), DIALOG, 1500);
  return stepOf(page);
};
const active = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName, text: (a?.textContent ?? "").trim().replace(/\s+/g, " "), value: a?.value, data: Object.keys(a?.dataset ?? {}).join(",") };
  });
/** Tab (forwards) until the focused element matches, as a keyboard user would. */
const tabTo = async (page, sel, max = 40) => {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate((s) => !!document.activeElement?.matches(s), sel)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached ${sel} (at ${JSON.stringify(await active(page))})`);
};
const openFromPalette = async (page) => {
  await page.waitForSelector(COMPOSER, { timeout: 5000 });
  await page.focus(COMPOSER);
  await chord(page, ["Meta", "k"]);
  await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
  await page.keyboard.type("import courses");
  const sel = await page.evaluate(() => document.querySelector('[data-command="import-courses"]')?.getAttribute("aria-selected"));
  check(sel === "true", "the palette offers “Import courses…”");
  await page.keyboard.press("Enter");
  await page.waitForSelector(DIALOG, { timeout: 3000 });
};

const LMS = {
  skipped: { 101: ["Announcements: turned off for this course.", "2 files your teacher hid from students."] },
  failCourse: "102",
  step: 60,
};
const base = { settings: SETTINGS, threads: {}, lms: LMS };
/** A space already connected to IU's Canvas, with two courses imported. */
const connected = (extra = {}) => ({
  ...base,
  lms: {
    ...LMS,
    connections: {
      school: [{ id: "c1", kind: "canvas", address: "https://iu.instructure.com", schoolName: "Indiana University Bloomington", signedIn: true, lastSync: Date.UTC(2026, 9, 9, 18), courses: ["101", "103"] }],
      work: [{ id: "c1", kind: "moodle", address: "https://moodle.example.edu", signedIn: false, courses: [] }],
    },
    ...extra,
  },
});

export default [
  {
    name: "f5-keyboard-flow",
    sizes: [[1100, 720], [640, 480]],
    mock: base,
    async run(page, h) {
      await openFromPalette(page);
      let s = await waitStep(page, "kind");
      check(s.focused && s.title === "Which course site does your school use?" && s.label === "Step 1 of 4", "step 1: its heading has focus", JSON.stringify(s));
      // Enter on Continue with nothing chosen: a plain error, tied to the group.
      await tabTo(page, "[data-step-next]");
      await page.keyboard.press("Enter");
      const err = await page.evaluate(() => {
        const g = document.querySelector('[role="radiogroup"]');
        return { error: document.querySelector("[data-field-error]")?.textContent ?? "", describes: !!document.getElementById(g.getAttribute("aria-describedby") ?? "")?.matches("[data-field-error]"), focus: document.activeElement?.getAttribute("role") };
      });
      check(err.error.includes("Choose the course site") && err.describes && err.focus === "radio", "nothing chosen: said in words, linked to the choices, focus on them", JSON.stringify(err));
      await h.shot("kind");
      // Arrows choose (Canvas is first: ArrowDown then ArrowUp lands back on it, chosen).
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowUp");
      const chosen = await page.evaluate(() => document.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute("data-kind"));
      check(chosen === "canvas", "the arrow keys choose a site", chosen);
      await tabTo(page, "[data-step-next]");
      await page.keyboard.press("Enter");
      s = await waitStep(page, "school");
      check(s.focused && s.title === "Find your school" && s.label === "Step 2 of 4", "step 2: its heading has focus", JSON.stringify(s));
      await tabTo(page, "[data-school-input]");
      await page.keyboard.type("indiana");
      const found = await waitFor(page, () => document.querySelectorAll("[data-school-option]").length === 3);
      check(found, "the school search lists the three matches");
      const st = await page.evaluate(() => document.querySelector("[data-school-status]")?.textContent);
      check(st === "3 schools found.", "the count is in the polite status", st);
      const typed = (await calls(page, "lms_schools")).length;
      check(typed <= 2, "the search waits for typing to pause", String(typed));
      await page.keyboard.press("ArrowDown");
      const ad = await page.evaluate(() => {
        const i = document.querySelector("[data-school-input]");
        return { expanded: i.getAttribute("aria-expanded"), option: document.getElementById(i.getAttribute("aria-activedescendant"))?.textContent };
      });
      check(ad.expanded === "true" && ad.option?.startsWith("Indiana University Indianapolis"), "ArrowDown highlights the next school (aria-activedescendant)", JSON.stringify(ad));
      await h.shot("search");
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("Enter");
      const picked = await page.evaluate(() => document.querySelector("[data-school-picked]")?.textContent);
      check(picked === "Indiana University Bloomington, at iu.instructure.com", "Enter picks the school and says which", picked);
      await page.keyboard.press("Enter");
      s = await waitStep(page, "signin");
      check(s.focused && s.title === "Sign in to Indiana University Bloomington" && s.label === "Step 3 of 4", "step 3: sign in, heading focused", JSON.stringify(s));
      await tabTo(page, "[data-signin-open]");
      await page.keyboard.press("Enter");
      s = await waitStep(page, "choose");
      check(s.focused && s.title === "Choose courses to import", "signed in: step 4, heading focused", JSON.stringify(s));
      const sent = (await calls(page, "lms_connect")).at(-1);
      check(sent.space === "school" && sent.kind === "canvas" && sent.address === "https://iu.instructure.com", "the core is asked to sign in to that school’s site for this space", JSON.stringify(sent));
      await page.waitForSelector("[data-course-list]", { timeout: 3000 });
      const list = await page.evaluate(() =>
        [...document.querySelectorAll("[data-course]")].map((l) => ({ id: l.dataset.course, on: l.querySelector("input").checked, text: l.textContent })),
      );
      check(list.filter((c) => c.on).map((c) => c.id).join() === "101,102,103", "the three current courses are checked", JSON.stringify(list));
      check(list[0].text.includes("CSCI-C 241") && list[0].text.includes("Fall 2026"), "each shows its code and term", list[0].text);
      const what = await page.evaluate(() => document.querySelector("[data-import-what]")?.textContent);
      check(what.startsWith("Each course gets a folder in School with its syllabus, assignments, files and the readings it links to."), "it says what will happen, in the current space", what);
      await h.shot("choose");
      await tabTo(page, "[data-import-start]");
      const btn = (await active(page)).text;
      check(btn === "Import 3 courses", "the button counts the courses", btn);
      await page.keyboard.press("Enter");
      s = await waitStep(page, "progress");
      check(s.title === "Importing into School", "the import starts, heading focused", JSON.stringify(s));
      const imp = (await calls(page, "lms_import")).at(-1);
      check(imp.space === "school" && imp.connection === "c1" && imp.courseIds.join() === "101,102,103", "the core is asked for exactly those courses", JSON.stringify(imp));
      await waitFor(page, () => document.querySelector("[data-step-title]")?.textContent === "Import finished", undefined, 6000);
      const done = await page.evaluate(() => ({
        courses: [...document.querySelectorAll("[data-import-course]")].map((c) => [c.dataset.importCourse, c.dataset.state, c.querySelector("[data-course-status]").textContent]),
        said: document.querySelector("[data-import-status]")?.textContent,
      }));
      check(done.courses.map((c) => c[1]).join() === "done,failed,done", "two imported, one failed", JSON.stringify(done.courses));
      check(done.courses[1][2].startsWith("Not imported. Calculus II couldn’t be read"), "the failed course says why", done.courses[1][2]);
      check(done.said?.endsWith("2 of 3 courses imported into School."), "the end is said politely", done.said);
      await h.shot("summary");
    },
  },
  {
    name: "f5-address",
    sizes: [[1100, 720], [640, 480]],
    themes: ["light"],
    mock: base,
    async run(page, h) {
      await openFromPalette(page);
      await waitStep(page, "kind");
      // Canvas: search, or type the address instead.
      await page.click('[data-kind="canvas"]');
      await page.click("[data-step-next]");
      await waitStep(page, "school");
      check(!!(await page.$("[data-school-input]")), "Canvas starts with the school search");
      await page.click('[data-school-mode="address"]');
      await page.waitForSelector("[data-address-input]", { timeout: 2000 });
      check(await page.evaluate(() => document.activeElement?.matches("[data-address-input]")), "“Type the address instead” puts focus in the address field");
      const errorFor = async (text) => {
        await page.click("[data-address-input]", { count: 3 });
        await page.keyboard.press("Backspace");
        if (text) await page.keyboard.type(text);
        await page.keyboard.press("Enter");
        return page.evaluate(() => {
          const i = document.querySelector("[data-address-input]");
          const ids = (i.getAttribute("aria-describedby") ?? "").split(" ");
          const err = document.querySelector("[data-field-error]");
          return { invalid: i.getAttribute("aria-invalid"), linked: !!err && ids.includes(err.id), text: err?.textContent ?? "", focused: document.activeElement === i };
        });
      };
      let e = await errorFor("");
      check(e.invalid === "true" && e.linked && e.focused && e.text.startsWith("Type your course site’s address"), "empty: asked for, linked and focused", JSON.stringify(e));
      e = await errorFor("http://canvas.iu.edu");
      check(e.linked && e.text.includes("https://"), "http: says only secure addresses work", JSON.stringify(e));
      e = await errorFor("canvas");
      check(e.linked && e.text.includes("missing its ending"), "no ending: says so plainly", JSON.stringify(e));
      await h.shot("invalid");
      await page.click("[data-address-input]", { count: 3 });
      await page.keyboard.type("canvas.iu.edu/courses/12");
      await page.keyboard.press("Enter");
      const s = await waitStep(page, "signin");
      check(s.title === "Sign in to canvas.iu.edu", "a good address goes to sign-in, named by its host", JSON.stringify(s));
      // Back twice, then Moodle: no search, the address straight away.
      await page.click("[data-step-back]");
      await waitStep(page, "school");
      const kept = await page.$eval("[data-address-input]", (i) => i.value);
      check(kept === "canvas.iu.edu", "Back keeps what was typed", kept);
      await page.click("[data-step-back]");
      await waitStep(page, "kind");
      await page.click('[data-kind="moodle"]');
      await page.click("[data-step-next]");
      await waitStep(page, "school");
      const m = await page.evaluate(() => ({ search: !!document.querySelector("[data-school-input]"), address: document.querySelector("[data-address-input]")?.placeholder }));
      check(!m.search && m.address === "moodle.yourschool.edu", "Moodle asks for the address, with a Moodle example", JSON.stringify(m));
      check((await calls(page, "lms_schools")).length === 0, "no school search was run");
      await h.shot("moodle");
    },
  },
  {
    name: "f5-signin-cancelled",
    sizes: [[1100, 720], [640, 480]],
    mock: { ...base, lms: { ...LMS, connectHold: true } },
    async run(page, h) {
      await openFromPalette(page);
      await waitStep(page, "kind");
      await page.click('[data-kind="brightspace"]');
      await page.click("[data-step-next]");
      await waitStep(page, "school");
      await page.type("[data-address-input]", "iu.brightspace.com");
      await page.keyboard.press("Enter");
      await waitStep(page, "signin");
      await page.click("[data-signin-open]");
      await page.waitForSelector("[data-signin-waiting]", { timeout: 2000 });
      await waitFor(page, () => document.activeElement?.matches("[data-signin-cancel]"));
      const w = await page.evaluate(() => ({ text: document.querySelector("[data-signin-waiting]").textContent, role: document.querySelector("[data-signin-waiting]").getAttribute("role"), focus: document.activeElement?.textContent }));
      check(
        w.role === "status" && w.text.includes("Finish signing in in the window that opened. Phaethon only keeps the session your sign-in creates, in your keychain on this computer, and only uses it to read your courses."),
        "while waiting it says what to do and what is kept",
        JSON.stringify(w),
      );
      check(w.focus === "Cancel", "focus moves to Cancel", w.focus);
      await h.shot("waiting");
      // The window is closed without signing in.
      await page.evaluate(() => window.__lmsSignIn("cancelled"));
      await page.waitForSelector('[data-signin-problem="warning"]', { timeout: 2000 });
      await waitFor(page, () => document.activeElement?.matches("[data-signin-open]"));
      const c = await page.evaluate(() => {
        const b = document.activeElement;
        return { focus: b.textContent, desc: document.getElementById(b.getAttribute("aria-describedby") ?? "")?.textContent ?? "", step: document.querySelector("[data-course-import]").dataset.step };
      });
      check(c.step === "signin" && c.focus === "Open sign-in window again" && c.desc.includes("closed before you finished"), "a closed window: said plainly, focus on Open again, which it describes", JSON.stringify(c));
      await sleep(300);
      await h.shot("cancelled");
      // Cancel while waiting: stops waiting; a late answer is ignored.
      await page.click("[data-signin-open]");
      await page.waitForSelector("[data-signin-cancel]", { timeout: 2000 });
      await page.click("[data-signin-cancel]");
      await page.evaluate(() => window.__lmsSignIn("ok"));
      await sleep(300);
      const after = await page.evaluate(() => ({ step: document.querySelector("[data-course-import]").dataset.step, focus: document.activeElement?.textContent }));
      check(after.step === "signin" && after.focus === "Open sign-in window again", "Cancel stops waiting and stays on sign-in", JSON.stringify(after));
      // An error from the core is shown as an alert.
      await page.evaluate(() => (window.__MOCK__.lms.connectHold = false, window.__MOCK__.lms.connect = "Couldn’t reach your course site: the connection timed out."));
      await page.click("[data-signin-open]");
      await page.waitForSelector('[data-signin-problem="danger"] [role="alert"]', { timeout: 2000 });
      const t = await page.$eval('[data-signin-problem="danger"]', (e) => e.textContent);
      check(t.includes("Signing in didn’t work. Couldn’t reach your course site"), "a failure says so", t);
    },
  },
  {
    name: "f5-past-courses",
    sizes: [[1100, 720], [640, 480]],
    themes: ["light"],
    mock: connected(),
    async run(page, h) {
      await openFromPalette(page);
      await waitStep(page, "kind");
      // Already connected: straight to its courses.
      const ex = await page.$eval("[data-existing-sites]", (e) => e.textContent);
      check(ex.includes("Indiana University Bloomington") && ex.includes("Canvas · Signed in"), "the space’s connected site is offered first", ex);
      await page.click('[data-existing-site="c1"]');
      await waitStep(page, "choose");
      await page.waitForSelector("[data-course-list]", { timeout: 3000 });
      const st = () =>
        page.evaluate(() => ({
          checked: [...document.querySelectorAll("[data-course] input:checked")].map((i) => i.closest("[data-course]").dataset.course).join(),
          open: document.querySelector("[data-past-courses]").open,
          imported: [...document.querySelectorAll("[data-course-imported]")].length,
          button: document.querySelector("[data-import-start]").textContent,
        }));
      let s = await st();
      check(s.checked === "102" && !s.open && s.imported === 2, "only the current course not imported yet is checked; past courses are folded away", JSON.stringify(s));
      // By keyboard: the disclosure, then its Select all.
      await page.focus('[data-past-courses] summary');
      await page.keyboard.press("Enter");
      s = await st();
      check(s.open, "Enter opens Past courses");
      await page.click('[data-course-group="past courses"] [data-select="all"]');
      s = await st();
      check(s.checked === "102,90,91" && s.button === "Import 3 courses", "Select all picks every past course", JSON.stringify(s));
      await page.click('[data-course-group="current courses"] [data-select="all"]');
      await page.click('[data-course-group="past courses"] [data-select="none"]');
      s = await st();
      check(s.checked === "101,102,103", "Select none clears only the past ones", JSON.stringify(s));
      await page.click('[data-course-group="current courses"] [data-select="none"]');
      await page.click("[data-import-start]");
      const e = await page.evaluate(() => ({ err: document.querySelector("[data-field-error]")?.textContent, focus: document.activeElement?.type }));
      check(e.err === "Choose at least one course to import." && e.focus === "checkbox", "none chosen: said, and focus goes to the first course", JSON.stringify(e));
      check((await calls(page, "lms_import")).length === 0, "nothing is imported");
      await page.click('[data-course="90"]');
      await page.evaluate(() => document.querySelector("[data-past-courses]").scrollIntoView({ block: "start" }));
      await h.shot("past");
    },
  },
  {
    name: "f5-progress",
    sizes: [[1100, 720], [640, 480]],
    mock: { ...connected({ step: 350 }) },
    async run(page, h) {
      await openFromPalette(page);
      await page.click('[data-existing-site="c1"]');
      await waitStep(page, "choose");
      await page.waitForSelector("[data-course-list]", { timeout: 3000 });
      await page.click('[data-course="101"]');
      await page.click('[data-course="103"]');
      await page.click("[data-import-start]");
      await waitStep(page, "progress");
      // Mid-import: one bar per course, valued, named by its course.
      await waitFor(page, () => document.querySelector('[data-import-course="101"] [role="progressbar"]')?.getAttribute("aria-valuenow") === "2", undefined, 5000);
      const bar = await page.evaluate(() => {
        const b = document.querySelector('[data-import-course="101"] [role="progressbar"]');
        return { now: b.getAttribute("aria-valuenow"), max: b.getAttribute("aria-valuemax"), text: b.getAttribute("aria-valuetext"), name: document.getElementById(b.getAttribute("aria-labelledby"))?.textContent };
      });
      check(bar.max === "4" && bar.text === "Downloading files, step 3 of 4" && bar.name === "Discrete Structures for Computer Science", "a determinate bar per course, named by it", JSON.stringify(bar));
      const quiet = await page.evaluate(() => document.querySelector("[data-import-status]").textContent);
      check(quiet === "", "steps are not announced", quiet);
      await h.shot("running");
      await waitFor(page, () => document.querySelector("[data-import-status]").textContent.includes("Imported Discrete Structures"), undefined, 6000);
      const said = await page.evaluate(() => document.querySelector("[data-import-status]").textContent);
      check(said === "Imported Discrete Structures for Computer Science.", "each course is announced once as it finishes", said);
      // Closing does not stop it: a notice shows how far it is, and says when it is done.
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-import-notice="running"]', { timeout: 3000 });
      const n = await page.$eval('[data-import-notice="running"]', (e) => e.textContent);
      check(/Importing courses into School: \d of 3 done\./.test(n), "closed: the notice says how far it is", n);
      const focusNow = await waitFor(page, () => document.activeElement?.hasAttribute("data-composer-input"));
      check(focusNow, "focus goes back to the composer");
      await h.shot("background");
      await page.waitForSelector('[data-import-notice="done"]', { timeout: 8000 });
      await waitFor(page, () => document.querySelector("[data-shell-status]")?.textContent !== "", undefined, 1500);
      const end = await page.evaluate(() => ({ text: document.querySelector('[data-import-notice="done"]').textContent, said: document.querySelector("[data-shell-status]")?.textContent }));
      check(end.text.includes("2 of 3 courses imported into School.") && end.said === "2 of 3 courses imported into School.", "the end is shown and said once", JSON.stringify(end));
      check(await page.evaluate(() => document.activeElement?.hasAttribute("data-composer-input")), "the notice never takes focus");
      await page.click("[data-import-notice-show]");
      await waitStep(page, "progress");
      const s = await stepOf(page);
      check(s.title === "Import finished", "Show summary opens the dialog on it", JSON.stringify(s));
      await page.click("[data-import-close]");
      await sleep(400);
      check(!(await page.$("[data-import-notice]")), "once seen, the notice is gone");
    },
  },
  {
    name: "f5-summary-actions",
    sizes: [[1100, 720]],
    mock: connected(),
    async run(page, h) {
      await openFromPalette(page);
      await page.click('[data-existing-site="c1"]');
      await waitStep(page, "choose");
      await page.waitForSelector("[data-course-list]", { timeout: 3000 });
      await page.click('[data-course="101"]');
      await page.click("[data-import-start]");
      await waitFor(page, () => document.querySelector("[data-step-title]")?.textContent === "Import finished", undefined, 6000);
      const sk = await page.$eval('[data-import-course="101"] [data-course-skipped]', (e) => e.textContent);
      check(sk.includes("Some parts couldn’t be imported:") && sk.includes("Announcements: turned off for this course."), "skipped parts are listed in plain words", sk);
      const summary = await page.$eval('[data-import-course="101"] [data-course-status]', (e) => e.textContent);
      check(summary === "15 files, 1 reading downloaded, 5 links to web pages listed.", "the summary counts files, readings and links", summary);
      await h.shot("summary");
      // Show in Finder: the course's README, revealed, by its path inside the space.
      await page.focus('[data-import-course="101"] [data-course-show]');
      const name = await page.evaluate(() => document.activeElement.textContent);
      check(name === "Show in Finder: Discrete Structures for Computer Science", "Show in Finder names its course", name);
      await page.keyboard.press("Enter");
      await sleep(100);
      const open = (await calls(page, "file_open")).at(-1);
      check(open?.space === "school" && open.path === "courses/Discrete Structures for Computer Science/README.md" && open.reveal === true, "it reveals the course’s README in the space", JSON.stringify(open));
      // Ask about this course: the dialog closes and the question waits in the message box.
      await page.focus('[data-import-course="101"] [data-course-ask]');
      await page.keyboard.press("Enter");
      await page.waitForFunction((D) => !document.querySelector(D), { timeout: 3000 }, DIALOG);
      await waitFor(page, () => document.activeElement?.hasAttribute("data-composer-input"));
      const c = await page.evaluate(() => ({ focus: document.activeElement?.hasAttribute("data-composer-input"), text: document.activeElement?.value }));
      check(c.focus && c.text === "What’s coming up in Discrete Structures for Computer Science, and what should I read first?", "the question is in the composer, focused, not sent", JSON.stringify(c));
      check((await calls(page, "agent_send")).length === 0, "nothing was sent");
    },
  },
  {
    name: "f5-settings",
    sizes: [[1100, 720], [640, 480]],
    mock: connected({ step: 40 }),
    async run(page, h) {
      await page.waitForSelector(COMPOSER, { timeout: 5000 });
      await chord(page, ["Meta", ","]);
      await page.waitForSelector('[data-testid="settings-tab-courses"]', { timeout: 3000 });
      await page.$eval('[data-testid="settings-tab-courses"]', (el) => el.click());
      await page.waitForSelector('[data-site-row="c1"]', { timeout: 3000 });
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll("[data-course-sites]")].map((g) => ({
          space: g.dataset.courseSites,
          rows: [...g.querySelectorAll("[data-site-row]")].map((r) => ({
            status: r.querySelector("[data-site-status]").textContent,
            imported: r.querySelector("[data-site-imported]").textContent,
            actions: [...r.querySelectorAll("[data-site-action]")].map((b) => b.textContent),
          })),
        })),
      );
      const school = rows.find((r) => r.space === "school").rows[0];
      const work = rows.find((r) => r.space === "work").rows[0];
      check(school.status === "Signed in" && school.imported.startsWith("2 courses imported, last on "), "School: signed in, two courses, when it last imported", JSON.stringify(school));
      check(school.actions.join("|") === "Import more…|Import again|Sign out…", "School offers Import more, Import again and Sign out", school.actions.join("|"));
      check(work.status.startsWith("Signed out") && work.actions.join("|") === "Sign in again…|Sign out…", "Work is signed out and offers Sign in again", JSON.stringify(work));
      await sleep(400);
      await h.shot("list");
      // Import again: the dialog opens over Settings on the import of the two imported courses.
      await page.click('[data-site-row="c1"] [data-site-action="sync"]');
      await waitStep(page, "progress");
      const imp = (await calls(page, "lms_import")).at(-1);
      check(imp.space === "school" && imp.courseIds.join() === "101,103", "Import again imports the courses imported before", JSON.stringify(imp));
      await waitFor(page, () => document.querySelector("[data-step-title]")?.textContent === "Import finished", undefined, 6000);
      await page.click("[data-import-close]");
      await waitFor(page, () => document.activeElement?.matches('[data-site-action="sync"]'));
      check(await page.evaluate(() => document.activeElement?.matches('[data-site-action="sync"]')), "closing it returns focus to Import again in Settings");
      // Sign out, asked in place.
      await page.focus('[data-site-row="c1"] [data-site-action="signout"]');
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-site-confirm]", { timeout: 2000 });
      const ask = await page.evaluate(() => ({ text: document.querySelector("[data-site-confirm] p").textContent, focus: document.activeElement?.textContent }));
      check(ask.text.includes("The 2 courses already imported stay in School as files.") && ask.focus === "Sign out", "Sign out asks first and says the files stay", JSON.stringify(ask));
      await h.shot("confirm");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector('[data-course-sites="school"] [data-site-row]'), { timeout: 3000 });
      const after = await page.evaluate(() => ({ focus: document.activeElement?.dataset.sitesImport, calls: window.__calls.filter((c) => c[0] === "lms_disconnect").map((c) => c[1]) }));
      check(after.calls.length === 1 && after.calls[0].space === "school" && after.calls[0].connection === "c1", "the core is asked to sign out of that site", JSON.stringify(after.calls));
      check(after.focus === "school", "focus moves to Import courses in the same space", JSON.stringify(after));
      // Sign in again for Work's signed-out site.
      await page.click('[data-course-sites="work"] [data-site-action="signin"]');
      const s = await waitStep(page, "signin");
      check(s.title === "Sign in to moodle.example.edu again", "Sign in again opens the sign-in step for that site", JSON.stringify(s));
    },
  },
  {
    name: "f5-signed-out",
    sizes: [[1100, 720], [640, 480]],
    themes: ["light"],
    mock: connected({ signedOut: true }),
    async run(page, h) {
      await openFromPalette(page);
      await waitStep(page, "kind");
      await page.click('[data-existing-site="c1"]');
      // The site says the session has expired: sign in again.
      const s = await waitStep(page, "signin");
      check(s.title === "Sign in to Indiana University Bloomington again", "an expired session goes to Sign in again", JSON.stringify(s));
      const lead = await page.evaluate(() => document.querySelector(`[data-course-import] [data-step-title]`).parentElement.textContent);
      check(lead.includes("You’ve been signed out of Indiana University Bloomington"), "it says why", lead);
      await h.shot("again");
      await page.click("[data-signin-open]");
      await waitStep(page, "choose");
      await page.waitForSelector("[data-course-list]", { timeout: 3000 });
      const sent = (await calls(page, "lms_connect")).at(-1);
      check(sent.address === "https://iu.instructure.com" && sent.kind === "canvas", "signing in again uses the same site", JSON.stringify(sent));
    },
  },
  {
    name: "f5-entries",
    sizes: [[1100, 720], [640, 480]],
    themes: ["light"],
    mock: base,
    async run(page, h) {
      // The empty conversation of a space with no course site offers it, quietly.
      await page.waitForSelector("[data-courses-suggestion]", { timeout: 5000 });
      const t = await page.$eval("[data-courses-suggestion]", (e) => e.textContent);
      check(t.includes("Canvas, Brightspace, Moodle or Blackboard") && t.includes("Import courses…"), "the empty conversation suggests importing courses", t);
      await h.shot("empty");
      await page.click("[data-courses-suggestion] button");
      await waitStep(page, "kind");
      await page.keyboard.press("Escape");
      await page.waitForFunction((D) => !document.querySelector(D), { timeout: 3000 }, DIALOG);
      // A space's menu, by keyboard: Shift+F10 on Work, then Import courses….
      const sidebarShown = await page.evaluate(() => !document.getElementById("spaces-sidebar")?.hidden);
      if (!sidebarShown) await chord(page, ["Meta", "\\"]);
      await page.waitForSelector('#spaces-sidebar:not([hidden]) [data-space-id="work"]', { timeout: 3000 });
      await page.focus('[data-space-id="work"]');
      await page.keyboard.down("Shift");
      await page.keyboard.press("F10");
      await page.keyboard.up("Shift");
      await page.waitForSelector('[data-space-menu="work"] [data-space-action="import-courses"]', { timeout: 3000 });
      await sleep(300);
      await h.shot("menu");
      for (let i = 0; i < 6; i++) {
        if (await page.evaluate(() => document.activeElement?.dataset.spaceAction === "import-courses")) break;
        await page.keyboard.press("ArrowDown");
        await sleep(60);
      }
      await page.keyboard.press("Enter");
      await page.waitForSelector(DIALOG, { timeout: 3000 });
      const s = await waitStep(page, "kind");
      const lead = await page.evaluate(() => document.querySelector("[data-course-import] [data-step-title]").parentElement.textContent);
      check(s.focused && lead.includes("keeps them in Work"), "from Work’s menu it imports into Work", lead);
      // Escape returns focus to Work in the sidebar.
      await page.keyboard.press("Escape");
      await page.waitForFunction((D) => !document.querySelector(D), { timeout: 3000 }, DIALOG);
      await sleep(100);
      const back = await page.evaluate(() => document.activeElement?.dataset.spaceId);
      check(back === "work", "closing returns focus to the space", String(back));
    },
  },
];
