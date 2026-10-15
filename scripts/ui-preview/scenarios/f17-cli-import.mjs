// Conversations Claude Code had in a space before Phaethon kept them (src-tauri/src/cli_import.rs):
// the Conversations menu offers to find them where Claude Code answers or kept transcripts there.
// Behaviour checks: check(...) fails the run.
//   f17-find-earlier       by keyboard: Find earlier Claude Code conversations brings in two, says so
//                          under it and through the status region, keeps focus on it, lists them by
//                          their titles with their own dates; one opens; a second look finds none
//   f17-find-earlier-small the same at 640x480 with 200% text: the item and what it found fit the menu
//   f17-not-offered        Phaethon's own agent answering and no transcripts here: not offered
//   f17-busy               asked while a reply runs: refused with the busy alert, nothing brought in
import { SETTINGS, check, park } from "../audit-fixtures.mjs";

const MENU = "[data-conversations-menu]";
const ITEM = "[data-find-earlier]";
const waitFor = (page, fn, arg, timeout = 4000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const rows = (page) =>
  page.$$eval(`${MENU} [role="menuitemradio"]`, (els) => els.map((e) => ({ id: e.dataset.threadId, text: e.innerText.replace(/\s+/g, " ").trim() })));

const OCT10 = Date.UTC(2026, 9, 10, 0, 6, 46);
const OCT11 = Date.UTC(2026, 9, 11, 7, 1, 52);
const FOUND = [
  {
    updated: OCT10,
    messages: [
      { role: "user", text: "Hi liner help", at: OCT10 - 50000 },
      { role: "assistant", text: "Hi! I’m not sure what you mean by “liner help.” Did you mean linear algebra?", at: OCT10 - 45000 },
      { role: "user", text: "yes looi where im weakest", at: OCT10 - 28000 },
      { role: "assistant", text: "I looked through your Linear Algebra (M301) folder and can’t tell where you’re weakest from it alone.", at: OCT10 },
    ],
  },
  {
    updated: OCT11,
    messages: [
      { role: "user", text: "hi", at: OCT11 - 2000 },
      { role: "assistant", text: "Hi! I can see your school workspace and your four Fall 2026 course folders.", at: OCT11 },
    ],
  },
];
const CURRENT = [
  { role: "user", text: "help me study for c241 test this friday", at: Date.now() - 600000 },
  { role: "assistant", text: "I’ll look through your C241 course materials.", at: Date.now() - 590000 },
];
const mock = () => ({
  settings: { ...SETTINGS, backend: "codex-cli" },
  threads: { school: CURRENT },
  cliImport: { offered: true, found: structuredClone(FOUND) },
});

/** Open Conversations by keyboard and go down to Find earlier Claude Code conversations. */
async function toItem(page, h) {
  await h.focusVia("[data-conversations-trigger]");
  await page.keyboard.press("Enter");
  check(await waitFor(page, (S) => !!document.querySelector(S), ITEM), "the menu offers Find earlier Claude Code conversations");
  for (let i = 0; i < 8 && !(await page.evaluate((S) => document.activeElement?.matches(S), ITEM)); i++) await page.keyboard.press("ArrowDown");
  check(await page.evaluate((S) => document.activeElement?.matches(S), ITEM), "and it is reached with the arrow keys");
}

async function findEarlier(page, h, { label }) {
  await toItem(page, h);
  const before = await rows(page);
  check(before.length === 1, "only the current conversation is listed at first", JSON.stringify(before));
  await page.keyboard.press("Enter");
  check(await waitFor(page, () => !!document.querySelector("[data-find-earlier-result]")), "what it found is said under it");
  const said = await page.$eval("[data-find-earlier-result]", (e) => e.textContent);
  check(said.includes("2 earlier conversations") && said.includes("“Hi liner help”") && said.includes("“hi”"), "naming both", said);
  check(await waitFor(page, (t) => document.querySelector("[data-shell-status]")?.textContent === t, said), "and announced");
  check(await page.evaluate((S) => document.activeElement?.matches(S), ITEM), "focus stays on the item, the menu open");
  const after = await rows(page);
  check(after.length === 3, "both are listed", JSON.stringify(after));
  check(after[1].text.includes("Hi liner help") === false && after[1].text.startsWith("hi") && after[2].text.startsWith("Hi liner help"), "most recent first, after the current one", JSON.stringify(after));
  check(after[2].text.includes("4 messages") && after[1].text.includes("2 messages"), "with their messages counted", JSON.stringify(after));
  check(!after[1].text.includes("Just now") && !after[2].text.includes("minutes ago"), "dated when they were had, not now", JSON.stringify(after));
  const box = await page.$eval(ITEM, (e) => {
    const r = e.getBoundingClientRect();
    const m = e.closest("[data-conversations-menu]").getBoundingClientRect();
    return { r: r.right, mr: m.right, w: document.documentElement.scrollWidth, vw: innerWidth };
  });
  check(box.r <= box.mr + 0.5 && box.w <= box.vw, "the item fits the menu and the window", JSON.stringify(box));
  const seen = await page.evaluate((S) => {
    const m = document.querySelector("[data-conversations-menu]").getBoundingClientRect();
    return [S, "[data-find-earlier-result]"].map((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return r.top >= m.top - 0.5 && r.bottom <= m.bottom + 0.5;
    });
  }, ITEM);
  check(seen[0] && seen[1], "the item with focus and what it found stay in view as the list grows", JSON.stringify(seen));
  await h.shot(label);

  // A second look finds nothing new.
  await page.keyboard.press("Enter");
  check(
    await waitFor(page, () => document.querySelector("[data-find-earlier-result]")?.textContent.includes("no earlier Claude Code conversations")),
    "a second look says there are none left to bring in",
  );
  check((await rows(page)).length === 3, "and adds nothing");
  return after;
}

export default [
  {
    name: "f17-find-earlier",
    sizes: [[1100, 720]],
    themes: ["light", "dark"],
    mock: mock(),
    async run(page, h) {
      await h.waitText("help me study for c241");
      const after = await findEarlier(page, h, { label: "found" });
      // Opening one brought in shows it as it was said.
      await page.keyboard.press("Escape");
      check(await waitFor(page, (S) => !document.querySelector(S), MENU), "Escape closes the menu");
      check(await page.evaluate(() => document.activeElement?.matches("[data-conversations-trigger]")), "and focus goes back to Conversations");
      await page.keyboard.press("Enter");
      await page.waitForSelector(`${MENU} [data-thread-id="${after[2].id}"]`, { timeout: 4000 });
      for (let i = 0; i < 4 && !(await page.evaluate((id) => document.activeElement?.dataset.threadId === id, after[2].id)); i++) await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => document.body.innerText.includes("yes looi where im weakest") && document.body.innerText.includes("can’t tell where you’re weakest")), "an imported conversation opens with its messages");
      const opened = await page.evaluate(() => window.__calls.filter(([c]) => c === "thread_open").map(([, a]) => a.id));
      check(opened.includes(after[2].id), "through thread_open with its id", JSON.stringify(opened));
      await park(page);
    },
  },
  {
    name: "f17-find-earlier-small",
    sizes: [[640, 480]],
    themes: ["light"],
    mock: { ...mock(), settings: { ...SETTINGS, backend: "codex-cli", appearance: { version: 1, tokens: { "--ph-text-scale": 2 } } } },
    async run(page, h) {
      await h.waitText("help me study for c241");
      await findEarlier(page, h, { label: "found" });
      // The result reads whole: the menu scrolls to it rather than cutting it off.
      const fits = await page.$eval("[data-find-earlier-result]", (e) => {
        e.scrollIntoView({ block: "nearest" });
        const r = e.getBoundingClientRect();
        return r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
      });
      check(fits, "what it found can be scrolled into view whole");
    },
  },
  {
    name: "f17-not-offered",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: { ...SETTINGS }, threads: { school: CURRENT }, cliImport: { offered: false, found: [] } },
    async run(page, h) {
      await h.waitText("help me study for c241");
      await h.click("[data-conversations-trigger]");
      await page.waitForSelector("[data-menu-new-conversation]", { timeout: 4000 });
      check(await waitFor(page, (S) => document.querySelectorAll(`${S} [role="menuitemradio"]`).length === 1, MENU), "the list is loaded");
      check(!(await page.$(ITEM)), "nothing is offered where Claude Code never answered and kept nothing");
      const asked = await page.evaluate(() => window.__calls.filter(([c]) => c === "cli_import_run").length);
      check(asked === 0, "and nothing is looked for");
    },
  },
  {
    name: "f17-busy",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { ...mock(), settings: { ...SETTINGS, backend: "claude-cli" }, cliImport: { found: structuredClone(FOUND) }, holdOpen: true, turn: [{ kind: "text", delta: "Working on it" }] },
    async run(page, h) {
      await h.send("Plan my week");
      check(await waitFor(page, () => document.body.innerText.includes("Working on it")), "a reply is running");
      await h.click("[data-conversations-trigger]");
      check(await waitFor(page, (S) => !!document.querySelector(S), ITEM), "offered where Claude Code answers");
      await h.click(ITEM);
      check(await waitFor(page, () => !!document.querySelector("[data-conversations-problem]")), "refused with the busy alert");
      const runs = await page.evaluate(() => window.__MOCK__.cliImportRuns ?? []);
      check(runs.length === 0, "and nothing is brought in", JSON.stringify(runs));
      await park(page);
    },
  },
];
