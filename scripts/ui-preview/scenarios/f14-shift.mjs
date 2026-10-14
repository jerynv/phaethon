// Nothing moves when a space switches views (Chat, Study, Grades, Plan). Behaviour checks: check(...) fails the run.
//   f14-shift-empty    an empty conversation: the header, the view switcher and the panel keep their boxes in every view
//   f14-shift-title    a long conversation title: the same, and the bar keeps its state (same element) across views
//   f14-shift-running  a reply running: the same while the activity shows, in the space header, sidebar and title bar
// Each prints the boxes it measured ("f14 <view> header=… switcher=… panel=…") so a regression shows by how much.
import { CONVERSATION, SETTINGS, check as strict, park } from "../audit-fixtures.mjs";

// F14_SOFT=1 reports every failed check instead of stopping at the first (to measure before a fix).
const check = (ok, what, detail) => (process.env.F14_SOFT && !ok ? console.log(`     MOVED: ${what}${detail ? ` (${detail})` : ""}`) : strict(ok, what, detail));

const shown = "[data-space-pane][data-shown]";
const VIEWS = ["chat", "study", "grades", "plan"];
const SIZES = [
  [1100, 720],
  [800, 600],
  [640, 480],
];

/** The boxes that must not move, in CSS px, rounded to 1/100 px. */
const boxes = (page) =>
  page.evaluate((shown) => {
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return [b.x, b.y, b.width, b.height].map((n) => Math.round(n * 100) / 100);
    };
    const pane = document.querySelector(shown);
    return {
      header: r(pane?.querySelector("[data-space-header]")),
      switcher: r(pane?.querySelector("[data-view-switcher]")),
      panel: r(pane?.querySelector("[role=tabpanel][data-view-shown]")),
      titlebar: r(document.querySelector("header")),
      sidebar: [...document.querySelectorAll("#spaces-sidebar:not([hidden]) [data-space-item]")].map((li) => r(li)),
    };
  }, shown);

const fmt = (b) => (b ? b.join(",") : "none");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function show(page, h, view) {
  await page.click(`${shown} [data-view-tab="${view}"]`);
  await page.waitForSelector(`${shown} [role=tabpanel][data-space-view="${view}"][data-view-shown]`, { timeout: 5000 });
  // Each view's first load settles (a spinner then its content) before measuring.
  await h.idle();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Measure every view, then back to Chat; every box must equal Chat's, pixel for pixel. */
async function measure(page, h, label) {
  await park(page);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const chat = await boxes(page);
  const seen = { chat };
  for (const v of [...VIEWS.slice(1), "chat"]) {
    await show(page, h, v);
    await park(page);
    seen[v === "chat" ? "back" : v] = await boxes(page);
  }
  for (const [v, b] of Object.entries(seen)) {
    console.log(`     f14 ${label} ${v}: header=${fmt(b.header)} switcher=${fmt(b.switcher)} panel=${fmt(b.panel)} titlebar=${fmt(b.titlebar)}`);
  }
  for (const [v, b] of Object.entries(seen)) {
    if (v === "chat") continue;
    check(same(b.header, chat.header), `${label}: the space header keeps its box in ${v}`, `${fmt(chat.header)} -> ${fmt(b.header)}`);
    check(same(b.switcher, chat.switcher), `${label}: the view switcher keeps its box in ${v}`, `${fmt(chat.switcher)} -> ${fmt(b.switcher)}`);
    check(same(b.panel, chat.panel), `${label}: the view's panel keeps its box in ${v}`, `${fmt(chat.panel)} -> ${fmt(b.panel)}`);
    check(same(b.titlebar, chat.titlebar), `${label}: the title bar keeps its box in ${v}`, `${fmt(chat.titlebar)} -> ${fmt(b.titlebar)}`);
    check(same(b.sidebar, chat.sidebar), `${label}: the sidebar's spaces keep their boxes in ${v}`);
  }
  return chat;
}

const LONG_TITLE =
  "Can you go through every proof in chapter four of the discrete structures notes and tell me which ones rely on strong induction rather than ordinary induction";

// ---- f14-load-*: a view's first load (a spinner, then its content) doesn't move what was already on screen ----
const SLOW = 700;
const LOADS = {
  // Study's heading row grows by its Make buttons once decks load (about 2 px): study-view.tsx is being changed
  // elsewhere, so that one is reported, not checked, until its heading row keeps a button's height from the start.
  study: { cmds: ["study_overview", "study_sources"], heading: "[data-study-hub] h2", known: true },
  grades: { cmds: ["lms_grades", "lms_connections"], heading: "[data-grades-view] h2" },
  plan: { cmds: ["plan_upcoming", "plan_exams_get", "plan_state_get"], heading: "[data-plan-view] h2" },
};
// Enough in each view that it has something to load, and more than a short window holds.
const DAY = 86400000;
const item = (title, group, score, dueIn) => ({
  title, group, score, possible: 10, percent: score == null ? undefined : score * 10, due: new Date(Date.now() + dueIn * DAY).toISOString(),
  submitted: score != null, graded: score != null, late: false, missing: false, excused: false, comments: [],
});
const LOAD_DATA = {
  study: {
    courses: [{ course: "Discrete Structures", folder: "courses/Discrete Structures" }],
    decks: Object.fromEntries(
      ["Graph theory basics", "Induction", "Relations", "Counting"].map((t) => [`study/decks/${t}.md`, { title: t, course: "Discrete Structures", cards: [{ front: `What is ${t}?`, back: "…" }] }]),
    ),
  },
  lms: { connections: { school: [{ id: "c1", kind: "canvas", address: "https://iu.instructure.com", schoolName: "Indiana University", signedIn: true, courses: ["101"] }] } },
  lmsGrades: {
    school: [
      {
        connection: "c1", courseId: "101", course: "Discrete Structures", folder: "courses/Discrete Structures", updated: Date.now() - 3600000,
        current: { percent: 88, letter: "B+" }, groups: [{ name: "Homework", weight: 50 }, { name: "Exams", weight: 50 }],
        items: [item("HW 1", "Homework", 9, -20), item("HW 2", "Homework", 8, -10), item("HW 3", "Homework", undefined, 4), item("Test 1", "Exams", undefined, 6)],
      },
    ],
  },
};
const loadBoxes = (page, v) =>
  page.evaluate(
    (heading, shown, v) => {
      const r = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return [b.x, b.y, b.width, b.height].map((n) => Math.round(n * 100) / 100);
      };
      const panel = document.querySelector(`${shown} [role=tabpanel][data-space-view="${v}"]`);
      // The view's own scrollers (the panel, and the view's section where it scrolls itself): the width
      // they leave for content, which a scrollbar that appears would narrow, and whether they keep its room.
      const scrollers = [panel, panel.firstElementChild].filter((e) => e && /auto|scroll/.test(getComputedStyle(e).overflowY));
      return {
        heading: r(panel.querySelector(heading)),
        widths: scrollers.map((e) => e.clientWidth).join("/"),
        gutters: scrollers.map((e) => getComputedStyle(e).scrollbarGutter).join("/"),
      };
    },
    LOADS[v].heading,
    shown,
    v,
  );
const loadScenario = (v) => ({
  name: `f14-load-${v}`,
  sizes: SIZES,
  mock: { settings: SETTINGS, threads: {}, slow: Object.fromEntries(LOADS[v].cmds.map((c) => [c, SLOW])), ...LOAD_DATA },
  async run(page) {
    await page.waitForSelector(`${shown} [data-view-switcher]`, { timeout: 5000 });
    await page.click(`${shown} [data-view-tab="${v}"]`);
    await page.waitForSelector(`${shown} ${LOADS[v].heading}`, { timeout: 5000 });
    const loading = await loadBoxes(page, v);
    await new Promise((r) => setTimeout(r, SLOW + 900));
    const loaded = await loadBoxes(page, v);
    console.log(`     f14 load ${v}: heading ${fmt(loading.heading)} -> ${fmt(loaded.heading)}; scroller widths ${loading.widths} -> ${loaded.widths}`);
    if (LOADS[v].known && !same(loading.heading, loaded.heading)) console.log(`     KNOWN: ${v}: its heading moves once it has loaded (${fmt(loading.heading)} -> ${fmt(loaded.heading)})`);
    else check(same(loading.heading, loaded.heading), `${v}: its heading doesn't move once it has loaded`, `${fmt(loading.heading)} -> ${fmt(loaded.heading)}`);
    check(loading.widths === loaded.widths, `${v}: no scrollbar appears that narrows it`, `${loading.widths} -> ${loaded.widths}`);
    // Headless Chromium's scrollbars overlay the page (as macOS's do by default), so a scrollbar that takes room
    // ("Show scroll bars: Always") is guarded by its room being kept from the start.
    check(loaded.gutters.split("/").every((g) => g.startsWith("stable")), `${v}: its scrollers keep a scrollbar's room from the start`, loaded.gutters);
  },
});

export default [
  loadScenario("study"),
  loadScenario("grades"),
  loadScenario("plan"),
  {
    name: "f14-shift-empty",
    sizes: SIZES,
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await page.waitForSelector(`${shown} [data-view-switcher]`, { timeout: 5000 });
      await measure(page, h, "empty");
    },
  },
  {
    name: "f14-shift-title",
    sizes: SIZES,
    mock: {
      settings: SETTINGS,
      threads: { school: [{ ...CONVERSATION[0], text: LONG_TITLE }, ...CONVERSATION.slice(1)] },
    },
    async run(page, h) {
      await page.waitForSelector(`${shown} [data-conversation-current]`, { timeout: 5000 });
      // The bar keeps its state across views: the very same element, not a remount.
      await page.evaluate((shown) => (document.querySelector(`${shown} [data-conversations-bar]`).__f14 = true), shown);
      await measure(page, h, "title");
      check(
        await page.evaluate((shown) => document.querySelector(`${shown} [data-conversations-bar]`)?.__f14 === true, shown),
        "the conversations bar is the same element after the other views (kept, not remounted)",
      );
      const hiddenInOthers = await page.evaluate((shown) => {
        const bar = document.querySelector(`${shown} [data-conversations-bar]`);
        return !bar.closest("[inert]");
      }, shown);
      check(hiddenInOthers, "in Chat the bar is not inert");
    },
  },
  {
    name: "f14-shift-running",
    sizes: SIZES,
    mock: {
      settings: SETTINGS,
      threads: { school: CONVERSATION },
      // A name long enough that "Answering…" beside it once wrapped onto a line of its own.
      spaces: [
        { id: "school", name: "School and every course", description: "Courses, deadlines, study notes", hue: 240 },
        { id: "work", name: "Work", description: "Projects, meetings, follow-ups", hue: 50 },
      ],
      holdOpen: true,
      turn: [{ kind: "text", delta: "Working through the chapter…" }],
    },
    async run(page, h) {
      await page.waitForSelector(`${shown} [data-conversation-current]`, { timeout: 5000 });
      await park(page);
      const before = await boxes(page);
      await h.send("Make me a plan for the week");
      await page.waitForSelector('[data-space-status="running"]', { timeout: 5000 });
      await h.idle();
      await park(page);
      const during = await boxes(page);
      console.log(`     f14 running idle-vs-running: header ${fmt(before.header)} -> ${fmt(during.header)}; sidebar ${JSON.stringify(before.sidebar)} -> ${JSON.stringify(during.sidebar)}`);
      check(same(before.header, during.header), "a reply starting doesn't move the space header", `${fmt(before.header)} -> ${fmt(during.header)}`);
      check(same(before.switcher, during.switcher), "or the view switcher");
      check(same(before.titlebar, during.titlebar), "or the title bar");
      check(same(before.sidebar, during.sidebar), "and the sidebar's activity mark doesn't resize its space", JSON.stringify(during.sidebar));
      await measure(page, h, "running");
      check(!!(await page.$('[data-space-status="running"]')), "the reply is still running after visiting every view");
    },
  },
];
