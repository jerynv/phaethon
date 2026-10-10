// Feature round 4: search across conversations, wide reading, and Continue on a
// stopped reply. One scenario per behaviour, each with checks that throw when
// the behaviour is wrong.
import { SETTINGS, check } from "../audit-fixtures.mjs";

const COMPOSER = "[data-composer-input]";
const SEARCH = "[data-search-dialog]";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter((c) => c[0] === cmd).map((c) => c[1]), cmd);
const chord = async (page, keys) => {
  for (const k of keys) await page.keyboard.down(k);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
};
const activeIs = (page, sel) => page.evaluate((sel) => !!document.activeElement?.matches(sel), sel);
const waitFor = (page, fn, arg, timeout = 4000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 10, 12);

const SCHOOL_NOW = [
  { role: "user", text: "What is due this week?" },
  { role: "assistant", text: "**Problem set 4** is due Wednesday, and the budget for books is $80." },
];
const SCHOOL_OLD = [
  { role: "user", text: "When is the Résumé workshop?" },
  { role: "assistant", text: "Let me look at the careers page." },
  { role: "user", text: "And what should I bring?" },
  { role: "assistant", text: "Bring two printed copies of your resume and a pen. The RÉSUMÉ workshop starts at 3 pm on Friday." },
];
const WORK_NOW = [
  { role: "user", text: "Draft the quarterly budget summary." },
  { role: "assistant", text: "The Q4 budget is 4% under plan; travel is the biggest saving." },
];

const searchMock = {
  settings: SETTINGS,
  threads: { school: SCHOOL_NOW, work: WORK_NOW },
  currentUpdated: { school: NOW - DAY, work: NOW },
  threadArchive: { school: [{ id: "1759000000000", updated: NOW - 5 * DAY, messages: SCHOOL_OLD }] },
};

const openSearch = async (page) => {
  await page.waitForSelector(COMPOSER, { timeout: 5000 });
  await page.focus(COMPOSER);
  await chord(page, ["Meta", "Shift", "f"]);
  await page.waitForSelector(SEARCH, { timeout: 3000 });
  check(await activeIs(page, "[data-search-input]"), "Cmd+Shift+F opens Search conversations with focus in its field");
};
const results = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-search-result]")].map((o) => ({
      text: o.textContent,
      mark: o.querySelector("mark")?.textContent,
      selected: o.getAttribute("aria-selected"),
      space: o.closest("[data-search-group]")?.querySelector("[data-search-space]")?.getAttribute("data-search-space") ?? null,
    })),
  );
const searchStatus = (page) => page.evaluate(() => document.querySelector("[data-search-status]")?.textContent ?? "");

/** The message search opened: focused, in view, marked. */
const focusedMessage = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    const log = el?.closest('[role="log"]');
    if (!el || !log) return null;
    const a = el.getBoundingClientRect();
    const l = log.getBoundingClientRect();
    return {
      role: el.getAttribute("data-role"),
      text: el.textContent,
      marked: el.hasAttribute("data-found-message"),
      inView: a.top >= l.top - 1 && a.top < l.bottom,
      pane: el.closest("[data-space-pane][data-shown]")?.getAttribute("data-space-pane") ?? null,
    };
  });

/** The conversation column and the message box, against the pane. */
const widths = (page) =>
  page.evaluate(() => {
    const col = document.querySelector('[data-space-pane][data-shown] [role="log"] > div > div, [data-space-pane][data-shown] [role="log"] > div');
    const column = [...document.querySelectorAll('[data-space-pane][data-shown] [role="log"] div')].find((d) => d.className.includes("max-w-(--ph-thread-width)")) ?? col;
    const composer = document.querySelector("[data-space-pane][data-shown] [data-composer-wrap]");
    const main = document.getElementById("main");
    return {
      column: Math.round(column.getBoundingClientRect().width),
      composer: Math.round(composer.getBoundingClientRect().width),
      main: Math.round(main.getBoundingClientRect().width),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });

export default [
  {
    name: "f4-search-keyboard",
    sizes: [[1100, 720], [640, 480]],
    mock: searchMock,
    async run(page, h) {
      await openSearch(page);
      // Before typing: says what it searches and that nothing goes to the model.
      const hint = await page.evaluate(() => document.querySelector("[data-search-empty]")?.textContent ?? "");
      check(hint.includes("Nothing is sent to the model") && hint.includes("School"), "the empty search says its scope and that nothing is sent", hint);
      await page.keyboard.type("resume");
      const got = await waitFor(page, () => document.querySelectorAll("[data-search-result]").length > 0);
      check(got, "results arrive once typing pauses");
      const r = await results(page);
      check(r.length === 3, "accent- and case-insensitive: “Résumé”, “resume” and “RÉSUMÉ” in the old conversation", JSON.stringify(r));
      check(r.every((x) => /r[ée]sum[ée]/i.test(x.mark ?? "")), "each match is a <mark> around the found words", JSON.stringify(r.map((x) => x.mark)));
      check(r[0].selected === "true" && r[1].selected === "false", "the first result is highlighted");
      const said = await searchStatus(page);
      check(said === "3 matches in 1 conversation.", "the count is in the polite status line", said);
      const calledWith = (await calls(page, "conversations_search")).at(-1);
      check(calledWith.space === "school" && calledWith.allSpaces === false, "the default scope is the space on screen", JSON.stringify(calledWith));
      const typed = (await calls(page, "conversations_search")).length;
      check(typed <= 2, "typing is debounced (not one search per key)", String(typed));
      await h.shot("results");
      await page.keyboard.press("ArrowDown");
      const desc = await page.evaluate(() => {
        const input = document.querySelector("[data-search-input]");
        return document.getElementById(input.getAttribute("aria-activedescendant"))?.textContent ?? "";
      });
      check(desc.includes("RÉSUMÉ workshop starts"), "ArrowDown moves the active option (aria-activedescendant)", desc);
      await page.keyboard.press("Enter");
      await page.waitForFunction((S) => !document.querySelector(S), { timeout: 3000 }, SEARCH);
      const opened = await waitFor(page, () => document.activeElement?.hasAttribute("data-found-message"));
      const open = (await calls(page, "thread_open")).at(-1);
      check(open?.space === "school" && open?.id === "1759000000000", "Enter opens that conversation", JSON.stringify(open));
      const m = await focusedMessage(page);
      check(opened && m?.role === "assistant" && m.text.includes("RÉSUMÉ workshop starts") && m.inView, "the found message is focused, in view and marked", JSON.stringify(m));
      const conv = await page.evaluate(() => document.querySelector('[data-testid="conversation-status"]')?.textContent);
      check(conv === "Opened the conversation “When is the Résumé workshop?”.", "the switch is said", conv);
      const bar = await page.evaluate(() => document.querySelector("[data-space-pane][data-shown] [data-conversations-bar]")?.textContent ?? "");
      check(bar.includes("Résumé workshop"), "the conversations bar shows the conversation now open", bar);
      await sleep(2600);
      check(!(await page.evaluate(() => !!document.querySelector("[data-found-message]"))), "the mark goes after a moment");
    },
  },
  {
    name: "f4-search-all-spaces",
    sizes: [[1100, 720], [640, 480]],
    mock: searchMock,
    async run(page, h) {
      // From the command palette.
      await page.waitForSelector(COMPOSER, { timeout: 5000 });
      await page.focus(COMPOSER);
      await chord(page, ["Meta", "k"]);
      await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
      await page.keyboard.type("search conv");
      const entry = await page.evaluate(() => document.querySelector('[data-command="search-conversations"]')?.getAttribute("aria-selected"));
      check(entry === "true", "the palette offers “Search conversations…”");
      await page.keyboard.press("Enter");
      await page.waitForSelector(SEARCH, { timeout: 3000 });
      await waitFor(page, () => document.activeElement?.matches("[data-search-input]"));
      await page.keyboard.type("budget");
      await waitFor(page, () => document.querySelectorAll("[data-search-result]").length > 0);
      let r = await results(page);
      check(r.length === 1 && r[0].space === null, "in this space only, one result and no space named", JSON.stringify(r));
      // Tab to the switch, Space turns on All spaces.
      await h.focusVia("[data-search-all]", 4);
      await page.keyboard.press("Space");
      await waitFor(page, () => document.querySelectorAll("[data-search-result]").length === 3);
      r = await results(page);
      check(r.map((x) => x.space).join() === "work,work,school", "All spaces: both spaces, newest first, each naming its space", JSON.stringify(r));
      const last = (await calls(page, "conversations_search")).at(-1);
      check(last.allSpaces === true, "the switch asks for every space", JSON.stringify(last));
      const said = await searchStatus(page);
      check(said === "3 matches in 2 conversations.", "the new count is said", said);
      await h.shot("all-spaces");
      // Back to the field and open the Work result.
      await page.focus("[data-search-input]");
      await page.keyboard.press("Enter");
      await page.waitForFunction((S) => !document.querySelector(S), { timeout: 3000 }, SEARCH);
      await waitFor(page, () => document.activeElement?.hasAttribute("data-found-message"));
      const m = await focusedMessage(page);
      check(m?.pane === "work" && m.role === "user" && m.text.includes("quarterly budget"), "choosing it switches to Work and focuses the message", JSON.stringify(m));
      check((await calls(page, "thread_open")).length === 0, "the current conversation is shown without reopening anything");
    },
  },
  {
    name: "f4-search-claude-code",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { ...searchMock, settings: { ...SETTINGS, backend: "claude-cli" } },
    async run(page) {
      await openSearch(page);
      await waitFor(page, () => document.querySelector("[data-search-empty]")?.textContent.includes("Claude Code"));
      const s = await page.evaluate(() => ({
        text: document.querySelector("[data-search-empty]")?.textContent,
        status: document.querySelector("[data-search-status]")?.textContent,
      }));
      check(s.text?.includes("can’t search") && s.status === "Claude Code’s history can’t be searched here.", "with Claude Code it says (and announces) its history can’t be searched here", JSON.stringify(s));
      await page.keyboard.type("budget");
      await sleep(400);
      check((await calls(page, "conversations_search")).length === 0, "and searches nothing");
    },
  },
  {
    name: "f4-wide-toggle",
    sizes: [[1600, 1000], [640, 480]],
    sizesRequired: true,
    mock: { settings: SETTINGS, threads: { school: SCHOOL_NOW } },
    async run(page, h) {
      await page.waitForSelector(COMPOSER, { timeout: 5000 });
      const w = page.viewport().width;
      const before = await widths(page);
      // 58rem fits beside the sidebar only at the usual text size (at 200% it fills the pane anyway).
      const fits = await page.evaluate(() => 58 * parseFloat(getComputedStyle(document.documentElement).fontSize) < document.getElementById("main").clientWidth * 0.75);
      if (w >= 1600 && fits) check(before.column < before.main * 0.75, "off: the column keeps a comfortable line length", JSON.stringify(before));
      await page.focus(COMPOSER);
      await chord(page, ["Meta", "Shift", "l"]);
      await sleep(100);
      const after = await widths(page);
      check(after.column >= after.main * 0.9 && after.composer >= after.main * 0.9, "Cmd+Shift+L: the column and the message box use most of the window", JSON.stringify({ before, after }));
      check(!after.overflow, "nothing scrolls sideways", JSON.stringify(after));
      const said = await page.evaluate(() => document.querySelector("[data-shell-status]")?.textContent);
      check(said === "Wide reading on.", "the change is said", said);
      await sleep(700);
      const saved = (await calls(page, "appearance_set")).at(-1);
      check(saved?.appearance?.tokens?.["--ph-wide-reading"] === 1, "saved with the appearance in the vault", JSON.stringify(saved));
      await h.shot("on");
      // The palette turns it off again.
      await chord(page, ["Meta", "k"]);
      await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
      await page.keyboard.type("wide");
      const label = await page.evaluate(() => document.querySelector('[data-command="wide-reading"]')?.textContent ?? "");
      check(label.includes("Turn wide reading off"), "the palette offers to turn it off", label);
      await page.keyboard.press("Enter");
      await sleep(300);
      const off = await widths(page);
      check(off.column === before.column, "off again: back to the comfortable column", JSON.stringify({ before, off }));
      await sleep(700);
      const cleared = (await calls(page, "appearance_set")).at(-1);
      check(!("--ph-wide-reading" in (cleared?.appearance?.tokens ?? {})), "the default is saved as no override", JSON.stringify(cleared));
    },
  },
  {
    name: "f4-wide-persisted",
    sizes: [[1600, 1000], [640, 480]],
    sizesRequired: true,
    mock: { settings: { ...SETTINGS, appearance: { tokens: { "--ph-wide-reading": 1 } } }, threads: { school: SCHOOL_NOW } },
    async run(page, h) {
      await page.waitForSelector(COMPOSER, { timeout: 5000 });
      await sleep(300);
      const w = await widths(page);
      check(w.column >= w.main * 0.9 && !w.overflow, "a saved Wide reading applies at start", JSON.stringify(w));
      // Settings › Accessibility shows it on.
      await chord(page, ["Meta", ","]);
      await page.waitForSelector('[role="dialog"]', { timeout: 3000 });
      const tab = await page.$$eval("[role=tab], nav button, [data-settings-nav] *", (els) => els.find((e) => e.textContent.trim() === "Accessibility")?.click() ?? null);
      void tab;
      await sleep(300);
      const sw = await page.evaluate(() => {
        const label = [...document.querySelectorAll("label")].find((l) => l.textContent === "Wide reading");
        const control = label && document.getElementById(label.htmlFor);
        return control ? control.getAttribute("aria-checked") : null;
      });
      check(sw === "true", "Settings › Accessibility › Wide reading is on", String(sw));
      await page.evaluate(() => [...document.querySelectorAll("label")].find((l) => l.textContent === "Wide reading")?.scrollIntoView({ block: "center" }));
      await h.shot("settings");
    },
  },
  {
    name: "f4-continue",
    sizes: [[1100, 720], [640, 480]],
    mock: {
      settings: SETTINGS,
      threads: {
        school: [
          { role: "user", text: "What is the capital of France, and why?" },
          { role: "assistant", text: "The capital of France is Paris. It became the capital because", records: [{ kind: "stopped" }] },
        ],
      },
      turn: [{ kind: "text", delta: "it sat at the centre of the Frankish kingdom", delay: 200 }, { kind: "text", delta: " and grew around the royal court.", delay: 200 }],
    },
    async run(page, h) {
      await page.waitForSelector('[data-reply-again="continue"]', { timeout: 5000 });
      const actions = await page.evaluate(() => [...document.querySelectorAll("[data-reply-again]")].map((b) => b.getAttribute("data-reply-again")));
      check(actions.join() === "continue,send-again", "a stopped reply offers Continue beside Send again", actions.join());
      await h.shot("offered");
      await page.focus(COMPOSER);
      await h.focusVia('[data-reply-again="continue"]', 30).catch(async () => {
        await h.tab(-1);
        await h.focusVia('[data-reply-again="continue"]', 30);
      });
      const name = await page.evaluate(() => document.activeElement.textContent);
      check(name.includes("Continue this reply from where it stopped"), "Continue is reached by keyboard, with a full name", name);
      await page.keyboard.press("Enter");
      const started = await waitFor(page, () => document.querySelector('[data-testid="reply-status"]')?.textContent === "Continuing the reply.", undefined, 2000);
      check(started, "starting is said as “Continuing the reply.”");
      await h.waitText("around the royal court.");
      await sleep(300);
      const r = await page.evaluate(() => {
        const replies = [...document.querySelectorAll('[data-space-pane][data-shown] [data-role="assistant"]')];
        return {
          count: replies.length,
          text: replies.at(-1)?.innerText ?? "",
          stopped: !!replies.at(-1)?.querySelector('[data-record="stopped"]'),
          status: document.querySelector('[data-testid="reply-status"]')?.textContent,
        };
      });
      check(r.count === 1, "the continuation joins the same reply (one reply shown)", JSON.stringify(r));
      check(/became the capital because\s+it sat at the centre/.test(r.text), "the stopped text stays and the new words follow it", r.text);
      check(!r.stopped, "the reply no longer says it was stopped", JSON.stringify(r));
      check(r.status === "Phaethon continued: it sat at the centre of the Frankish kingdom and grew around the royal court.", "only the new words are read out", r.status);
      const sent = (await calls(page, "agent_send")).at(-1);
      check(sent.continueFrom === 1 && sent.prompt === "" && sent.replaceFrom === undefined, "the backend is asked to continue the saved reply, not to answer the question again", JSON.stringify(sent));
      const users = await page.evaluate(() => document.querySelectorAll('[data-space-pane][data-shown] [data-role="user"]').length);
      check(users === 1, "the question is not sent again as a new message", String(users));
    },
  },
  {
    name: "f4-continue-claude-code",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: {
      settings: { ...SETTINGS, backend: "claude-cli" },
      threads: {},
      holdOpen: true,
      turn: [{ kind: "text", delta: "Paris is the capital because" }],
    },
    async run(page) {
      // Claude Code: the reply is stopped live; it can be sent again but not continued.
      await page.waitForSelector(COMPOSER, { timeout: 5000 });
      await page.focus(COMPOSER);
      await page.keyboard.type("Capital of France?");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.body.innerText.includes("Paris is the capital because"), { timeout: 4000 });
      await page.keyboard.press("Escape");
      await page.waitForSelector('[data-reply-again="send-again"]', { timeout: 4000 });
      const r = await page.evaluate(() => ({
        cont: !!document.querySelector('[data-reply-again="continue"]'),
        said: document.querySelector('[data-testid="reply-status"]')?.textContent,
      }));
      check(!r.cont, "Claude Code: no Continue (only Send again)", JSON.stringify(r));
      check(r.said === "Reply stopped. Send again is under it.", "and the stop says only Send again", r.said);
    },
  },
];
