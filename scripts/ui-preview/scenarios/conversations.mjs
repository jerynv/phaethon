// Conversations: New conversation (button and Cmd+N), the list of past
// conversations, reopening one, refusal while a reply runs, the Claude Code
// backend's note, keyboard-only use, and fit in a small window. A check that
// fails throws, so shoot.mjs reports the scenario FAILED.

const DAY = 86400000;
const now = Date.now();

const current = [
  { role: "user", text: "What do I have due this week for C241?", attachments: [] },
  { role: "assistant", text: "Problem set 4 on Wednesday, and Test 1 on Thursday.", attachments: [] },
];
const archive = [
  {
    id: String(now - DAY),
    updated: now - DAY,
    messages: [
      { role: "user", text: "Summarise my M301 notes on eigenvalues", attachments: [] },
      { role: "assistant", text: "Your notes cover three ideas: the characteristic polynomial, eigenspaces and diagonalisation.", attachments: [] },
    ],
  },
  {
    id: String(now - 9 * DAY),
    updated: now - 9 * DAY,
    messages: [
      {
        role: "user",
        text: "Can you go through every reading listed for the history seminar and tell me which ones are actually required?",
        attachments: [],
      },
      { role: "assistant", text: "Four of the eleven are required.", attachments: [] },
      { role: "user", text: "Thanks", attachments: [] },
      { role: "assistant", text: "You’re welcome.", attachments: [] },
    ],
  },
];
const mock = () => ({ threads: { school: structuredClone(current) }, threadArchive: { school: structuredClone(archive) } });

function expect(cond, message) {
  if (!cond) throw new Error(message);
}
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd), cmd);
const composerFocused = (page) => page.evaluate(() => document.activeElement?.matches("[data-composer-input]") ?? false);
/** The closed menu is gone (after its short exit animation), so the next open is a fresh one. */
const menuGone = (page) => page.waitForFunction(() => !document.querySelector("[data-conversations-menu]"), { timeout: 3000 });
/** Radix moves menu focus in a timeout after the key, so wait for it. */
const focusOn = (page, id, what) =>
  page
    .waitForFunction((id) => document.activeElement?.getAttribute("data-thread-id") === id, { timeout: 3000 }, id)
    .catch(async () => {
      const at = await page.evaluate(() => document.activeElement?.getAttribute("data-thread-id") ?? document.activeElement?.outerHTML.slice(0, 160));
      throw new Error(`${what} went to ${at}, not ${id}`);
    });
const statusText =(page) => page.evaluate(() => document.querySelector('[data-testid="conversation-status"]')?.textContent ?? "");
const openMenu = async (page, h) => {
  await h.click("[data-conversations-trigger]");
  await page.waitForSelector('[data-conversations-menu] [role="menuitemradio"]', { timeout: 5000 });
};
const items = (page) =>
  page.$$eval('[data-conversations-menu] [role="menuitemradio"]', (els) =>
    els.map((e) => ({ id: e.dataset.threadId, text: e.textContent, checked: e.getAttribute("aria-checked") })),
  );
/** Nothing sticks out sideways: no horizontal page scroll, and the menu fits the window. */
const fits = async (page) => {
  const r = await page.evaluate(() => {
    const menu = document.querySelector("[data-conversations-menu]")?.getBoundingClientRect();
    return {
      scroll: document.documentElement.scrollWidth,
      w: innerWidth,
      h: innerHeight,
      menu: menu && { left: menu.left, right: menu.right, bottom: menu.bottom },
    };
  });
  expect(r.scroll <= r.w, `page scrolls sideways (${r.scroll} > ${r.w})`);
  if (r.menu) expect(r.menu.left >= 0 && r.menu.right <= r.w && r.menu.bottom <= r.h, `menu outside the window: ${JSON.stringify(r)}`);
};

export default [
  {
    name: "conv-new",
    mock: mock(),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await h.click("[data-new-conversation]");
      await h.waitText("Start a conversation in School");
      await page.waitForFunction(() => document.activeElement?.matches("[data-composer-input]"), { timeout: 3000 });
      expect(!(await page.evaluate(() => document.body.innerText.includes("Problem set 4"))), "old messages still shown");
      expect((await calls(page, "thread_new")).length === 1, "thread_new not called once");
      await page.waitForFunction(() => document.querySelector('[data-testid="conversation-status"]')?.textContent === "New conversation started.", { timeout: 2000 });
      // The reply loaded with the old thread is not spoken again.
      expect((await page.$eval('[data-testid="reply-status"]', (e) => e.textContent)) === "", "reply status replayed");
      await h.idle();
    },
  },
  {
    name: "conv-history",
    mock: mock(),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await openMenu(page, h);
      const list = await items(page);
      expect(list.length === 3, `expected 3 conversations, got ${list.length}`);
      expect(list[0].id === "current" && list[0].checked === "true", "current is not first and checked");
      expect(list[0].text.includes("Current") && list[0].text.includes("2 messages"), `current row: ${list[0].text}`);
      expect(list[1].text.includes("Yesterday at"), `yesterday row: ${list[1].text}`);
      expect(list[2].text.includes("…") && list[2].text.includes("4 messages"), `long title row: ${list[2].text}`);
      expect(
        await page.evaluate(() => document.activeElement?.closest("[data-conversations-menu]") !== null),
        "focus is not in the menu",
      );
      await fits(page);
      await h.idle();
    },
  },
  {
    name: "conv-open",
    mock: mock(),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await openMenu(page, h);
      await h.click(`[data-thread-id="${archive[0].id}"]`);
      await h.waitText("characteristic polynomial");
      await page.waitForFunction(() => document.activeElement?.matches("[data-composer-input]"), { timeout: 3000 });
      expect(!(await page.evaluate(() => document.body.innerText.includes("Problem set 4"))), "old conversation still shown");
      const [[, args]] = await calls(page, "thread_open");
      expect(args.space === "school" && args.id === archive[0].id, `thread_open args ${JSON.stringify(args)}`);
      await page.waitForFunction(() => document.querySelector('[data-testid="conversation-status"]')?.textContent.startsWith("Opened the conversation “Summarise my M301"), { timeout: 2000 });
      // The one we left is in the list now, and the opened one is current.
      await menuGone(page);
      await openMenu(page, h);
      const list = await items(page);
      expect(list.length === 3, `expected 3, got ${list.length}`);
      expect(list[0].text.includes("Summarise my M301"), `current is ${list[0].text}`);
      expect(list.some((i) => i.id !== "current" && i.text.includes("What do I have due")), "left conversation not archived");
      await page.keyboard.press("Escape");
      await h.idle();
    },
  },
  {
    name: "conv-shortcut",
    mock: mock(),
    async run(page, h) {
      await h.waitText("Problem set 4");
      const ks = await page.$eval("[data-new-conversation]", (e) => e.getAttribute("aria-keyshortcuts"));
      expect(ks === "Meta+N", `aria-keyshortcuts ${ks}`);
      await page.focus("[data-composer-input]");
      await page.keyboard.down("Meta");
      await page.keyboard.press("n");
      await page.keyboard.up("Meta");
      await h.waitText("Start a conversation in School");
      await page.waitForFunction(() => document.activeElement?.matches("[data-composer-input]"), { timeout: 3000 });
      expect((await calls(page, "thread_new")).length === 1, "Cmd+N did not start a new conversation");
      await h.idle();
    },
  },
  {
    name: "conv-shortcut-windows",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { ...mock(), platform: "windows" },
    async run(page, h) {
      await h.waitText("Problem set 4");
      const ks = await page.$eval("[data-new-conversation]", (e) => e.getAttribute("aria-keyshortcuts"));
      expect(ks === "Control+N", `aria-keyshortcuts ${ks}`);
      await page.focus("[data-composer-input]");
      await page.keyboard.down("Control");
      await page.keyboard.press("n");
      await page.keyboard.up("Control");
      await h.waitText("Start a conversation in School");
      expect((await calls(page, "thread_new")).length === 1, "Ctrl+N did not start a new conversation");
    },
  },
  {
    name: "conv-busy",
    mock: {
      ...mock(),
      holdOpen: true,
      turn: [{ kind: "text", delta: "Looking at your syllabus, the first thing" }],
    },
    async run(page, h) {
      await h.waitText("Problem set 4");
      await h.send("And next week?");
      await h.waitText("Looking at your syllabus");
      await h.click("[data-new-conversation]");
      await page.waitForSelector('[data-conversations-problem][role="alert"]', { timeout: 3000 });
      await h.waitText("Phaethon is still replying");
      expect((await calls(page, "thread_new")).length === 0, "thread_new called while busy");
      expect(await page.evaluate(() => document.body.innerText.includes("Problem set 4")), "thread was emptied while busy");
      // Opening a saved one is refused too.
      await openMenu(page, h);
      await h.click(`[data-thread-id="${archive[0].id}"]`);
      expect((await calls(page, "thread_open")).length === 0, "thread_open called while busy");
      await menuGone(page);
      await h.shot("refused");
      // Stopping the reply clears the alert.
      await page.focus("[data-composer-input]");
      await page.keyboard.press("Escape");
      await h.waitText("Reply stopped.");
      await page.waitForFunction(() => !document.querySelector("[data-conversations-problem]"), { timeout: 3000 });
      // The backend refuses too: its message is shown when it does.
      await page.evaluate(() => (window.__MOCK__.fail = { thread_new: "Phaethon is still replying in this space. Stop the reply or wait for it to finish, then try again." }));
      await h.click("[data-new-conversation]");
      await page.waitForSelector("[data-conversations-problem]", { timeout: 3000 });
      await h.waitText("Phaethon is still replying in this space");
      await h.idle();
    },
  },
  {
    name: "conv-keyboard",
    mock: mock(),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await h.focusVia("[data-conversations-trigger]");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-conversations-menu] [role="menuitemradio"]', { timeout: 5000 });
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-thread-id") === "current", { timeout: 3000 });
      // ArrowDown goes conversation to conversation; each one's Delete is beside it, on ArrowRight.
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-delete-thread") === "current", { timeout: 3000 });
      await page.keyboard.press("ArrowLeft");
      await focusOn(page, "current", "ArrowLeft from Delete");
      await page.keyboard.press("ArrowDown");
      await focusOn(page, archive[0].id, "ArrowDown");
      await h.idle(); // past the menu's open animation
      await h.shot("menu");
      // Escape closes and returns focus to the button.
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.activeElement?.matches("[data-conversations-trigger]"), { timeout: 3000 });
      // Open again and choose with Enter.
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-thread-id") === "current", { timeout: 3000 });
      await page.keyboard.press("ArrowDown");
      await focusOn(page, archive[0].id, "ArrowDown");
      // From a Delete, ArrowDown moves on as from its conversation.
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction((id) => document.activeElement?.getAttribute("data-delete-thread") === id, { timeout: 3000 }, archive[0].id);
      await page.keyboard.press("ArrowDown");
      await focusOn(page, archive[1].id, "ArrowDown from a Delete");
      await page.keyboard.press("Enter");
      await h.waitText("Four of the eleven");
      await page.waitForFunction(() => document.activeElement?.matches("[data-composer-input]"), { timeout: 3000 });
      // Tab from the composer reaches New conversation again (no trap), and Enter on it works.
      await page.keyboard.down("Shift");
      await h.focusVia("[data-new-conversation]");
      await page.keyboard.up("Shift");
      await page.keyboard.press("Enter");
      await h.waitText("Start a conversation in School");
      await page.waitForFunction(() => document.activeElement?.matches("[data-composer-input]"), { timeout: 3000 });
      expect(await composerFocused(page), "composer not focused after New conversation");
      await page.waitForFunction(() => document.querySelector('[data-testid="conversation-status"]')?.textContent === "New conversation started.", { timeout: 2000 });
      expect((await statusText(page)) === "New conversation started.", "not announced");
      await menuGone(page);
    },
  },
  {
    name: "conv-cli",
    mock: { ...mock(), settings: { backend: "claude-cli", hasAnthropicKey: false, model: "claude-opus-5-5" } },
    async run(page, h) {
      await h.click("[data-conversations-trigger]");
      await page.waitForSelector("[data-conversations-cli]", { timeout: 5000 });
      expect((await items(page)).length === 0, "CLI backend lists conversations");
      await page.keyboard.press("Escape");
      await menuGone(page);
      await h.click("[data-new-conversation]");
      await page.waitForFunction(() => document.activeElement?.matches("[data-composer-input]"), { timeout: 3000 });
      expect((await calls(page, "thread_new")).length === 1, "thread_new not called for the CLI backend");
      // The menu's own New conversation works too, and focus still lands in the composer.
      await h.click("[data-conversations-trigger]");
      await page.waitForSelector("[data-conversations-cli]", { timeout: 5000 });
      await h.click("[data-menu-new-conversation]");
      await page.waitForFunction(() => document.activeElement?.matches("[data-composer-input]"), { timeout: 3000 });
      expect((await calls(page, "thread_new")).length === 2, "menu New conversation did not call thread_new");
      await menuGone(page);
      await h.click("[data-conversations-trigger]");
      await page.waitForSelector("[data-conversations-cli]", { timeout: 5000 });
      await h.idle();
    },
  },
  {
    name: "conv-fit",
    sizes: [[640, 480]],
    mock: {
      threads: { school: structuredClone(current) },
      threadArchive: {
        school: Array.from({ length: 14 }, (_, i) => ({
          id: String(now - (i + 1) * DAY),
          updated: now - (i + 1) * DAY - i * 3600000,
          messages: [
            { role: "user", text: `${["Plan", "Summarise", "Compare", "Explain"][i % 4]} week ${i + 1} of the reading list, including every optional chapter`, attachments: [] },
            { role: "assistant", text: "Done.", attachments: [] },
          ],
        })),
      },
    },
    async run(page, h) {
      await h.waitText("Problem set 4");
      await fits(page);
      await openMenu(page, h);
      expect((await items(page)).length === 15, "not all 15 listed");
      await fits(page);
      // The list scrolls inside the menu; the last one can be reached.
      // End goes to the menu's own New conversation; one up is the oldest conversation (Delete items are not arrow stops).
      await page.keyboard.press("End");
      await page.waitForFunction(() => document.activeElement?.matches("[data-menu-new-conversation]"), { timeout: 3000 });
      await page.keyboard.press("ArrowUp");
      await focusOn(page, String(now - 14 * DAY), "End, ArrowUp");
      const last = await page.evaluate(() => {
        const el = document.activeElement;
        const r = el.getBoundingClientRect();
        return { id: el.getAttribute("data-thread-id"), bottom: r.bottom, h: innerHeight };
      });
      expect(last.id === String(now - 14 * DAY) && last.bottom <= last.h, `End reached ${JSON.stringify(last)}`);
      await h.idle();
    },
  },
];
