// The sidebar under the current space: its views, the conversations bar's
// controls and recent conversations; its Search entry; the title bar's
// breadcrumb as the one location header; and the compact header that takes
// the views and the bar while the sidebar is hidden (wide window with the
// sidebar toggled off, and a narrow window, where the overlaid sidebar's rows
// still open a conversation).

import { showSidebar } from "../audit-fixtures.mjs";

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
];
const mock = () => ({ threads: { school: structuredClone(current) }, threadArchive: { school: structuredClone(archive) } });
const historyMock = (total) => ({
  ...mock(),
  threadArchive: { school: Array.from({ length: total - 1 }, (_, i) => ({ ...archive[0], id: String(now - (i + 1) * DAY), updated: now - (i + 1) * DAY })) },
});

function expect(cond, message) {
  if (!cond) throw new Error(message);
}
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd), cmd);
const crumb = (page) => page.evaluate(() => document.querySelector('nav[aria-label="Where you are"] [aria-current="page"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "");
const rows = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-sidebar-thread]")).map((b) => ({ id: b.getAttribute("data-sidebar-thread"), current: b.getAttribute("aria-current"), text: b.textContent.trim() })),
  );

async function expectComposerReachable(page, h) {
  await page.waitForFunction(() => document.getElementById("spaces-sidebar")?.hidden && !document.querySelector("[data-sidebar-scrim], [data-conversations-menu]") && document.activeElement?.matches("[data-composer-input]"), { timeout: 3000 });
  await h.click("[data-composer-input]");
  expect(await page.$eval("[data-composer-input]", (input) => document.activeElement === input), "the composer cannot receive pointer focus after dismissing the sidebar");
}

export default [
  ...[6, 7].map((total) => ({
    name: `sidebar-conversations-history-${total}`,
    sizes: [[1100, 720]],
    mock: historyMock(total),
    async run(page, h) {
      await page.waitForFunction((total) => document.querySelectorAll("[data-sidebar-thread]").length === Math.min(total, 6), {}, total);
      const more = await page.$("[data-sidebar-history-all]");
      expect(!!more === (total > 6), `older-history affordance is wrong at ${total} conversations`);
      if (more) {
        await h.click("[data-sidebar-history-all]");
        await page.waitForFunction((total) => document.querySelectorAll("[data-conversations-menu] [data-thread-id]").length === total, {}, total);
      }
    },
  })),
  {
    name: "sidebar-conversations-overlay-history",
    sizesRequired: true,
    sizes: [[640, 480]],
    mock: historyMock(15),
    async run(page, h) {
      await showSidebar(page);
      await h.click("[data-sidebar-history-all]");
      await page.waitForFunction(() => document.querySelectorAll("[data-conversations-menu] [data-thread-id]").length === 15, { timeout: 3000 });
      await h.idle();
      expect(await page.$eval("[data-history-list]", (list) => list.scrollHeight > list.clientHeight), "the narrow history fixture does not exercise scrolling");
      const ids = await page.$$eval("[data-conversations-menu] [data-thread-id]", (items) => items.map((item) => item.dataset.threadId));
      for (const id of ids) {
        const item = await page.$(`[data-conversations-menu] [data-thread-id="${id}"]`);
        await item.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
        expect(await item.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }), `history row ${id} is obstructed after scrolling`);
      }
      await h.click(`[data-conversations-menu] [data-thread-id="${ids.at(-1)}"]`);
      await h.waitText("characteristic polynomial");
      await expectComposerReachable(page, h);
      const opened = await calls(page, "thread_open");
      expect(opened.length === 1 && opened[0][1].space === "school" && opened[0][1].id === ids.at(-1), `the oldest conversation was not opened once: ${JSON.stringify(opened)}`);
    },
  },
  {
    name: "sidebar-conversations-overlay-new",
    sizesRequired: true,
    sizes: [[640, 480]],
    mock: mock(),
    async run(page, h) {
      for (const fromMenu of [false, true]) {
        await showSidebar(page);
        if (fromMenu) await h.click("#spaces-sidebar [data-conversations-trigger]");
        await h.click(fromMenu ? "[data-conversations-menu] [data-menu-new-conversation]" : "#spaces-sidebar [data-new-conversation]");
        await h.waitText("Start a conversation in School");
        await expectComposerReachable(page, h);
        expect((await calls(page, "thread_new")).length === (fromMenu ? 2 : 1), "New conversation from the overlaid sidebar did not call thread_new once");
      }
    },
  },
  {
    name: "sidebar-conversations-overlay-current-from-study",
    sizesRequired: true,
    sizes: [[640, 480]],
    mock: historyMock(7),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await page.type("[data-composer-input]", "Keep this draft");
      await h.click('[data-space-pane][data-shown] [data-space-header] [data-view-tab="study"]');
      await page.waitForSelector('[data-space-view="study"][data-view-shown]', { timeout: 3000 });
      await showSidebar(page);
      await h.click("[data-sidebar-history-all]");
      await h.click('[data-conversations-menu] [data-thread-id="current"]');
      await h.waitText("Problem set 4");
      await expectComposerReachable(page, h);
      expect(await page.$eval("[data-composer-input]", (input) => input.value === "Keep this draft"), "returning to the current conversation from the full menu lost the draft");
      expect((await calls(page, "thread_open")).length === 0, "selecting the current conversation from Study reloaded it");
    },
  },
  {
    name: "sidebar-current-conversation-views",
    sizes: [[1100, 720], [640, 480]],
    mock: mock(),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await page.type("[data-composer-input]", "Keep this draft");
      for (const view of ["study", "grades", "plan"]) {
        await h.click(`[data-view-tab="${view}"]`);
        await page.waitForSelector(`[data-space-pane][data-shown] [data-space-view="${view}"][data-view-shown]`, { timeout: 5000 });
        if (await page.$eval("#spaces-sidebar", (sidebar) => sidebar.hidden)) {
          await page.click('button[aria-controls="spaces-sidebar"]');
        }
        await page.waitForSelector('#spaces-sidebar:not([hidden]) [data-sidebar-thread="current"]', { timeout: 5000 });
        expect(!(await page.$('#spaces-sidebar [data-sidebar-thread][aria-current="page"]')), "a learning view does not also mark Chat as the current page");
        await h.click('#spaces-sidebar [data-sidebar-thread="current"]');
        await page.waitForFunction(() => !!document.querySelector('[data-space-pane][data-shown] [data-space-view="chat"][data-view-shown]') && document.activeElement?.matches("[data-composer-input]"), { timeout: 5000 });
        expect(await page.$eval("[data-composer-input]", (input) => input.value === "Keep this draft"), `returning from ${view} lost the draft`);
        expect((await calls(page, "thread_open")).length === 0, `returning from ${view} reloaded the current conversation`);
      }
    },
  },
  {
    name: "sidebar-conversations-loading",
    sizes: [[1100, 720]],
    mock: { ...mock(), slow: { threads_list: 800 } },
    async run(page, h) {
      await h.waitText("Loading conversations…");
      expect(!(await page.$eval('[data-sidebar-conversations]', (section) => section.textContent.includes("No conversations yet."))), "loading was mistaken for an empty history");
      await page.waitForSelector("[data-sidebar-thread]", { timeout: 5000 });
      expect((await rows(page)).length === 2, "loaded conversations did not replace the pending state");
    },
  },
  {
    name: "sidebar-conversations-retry",
    sizes: [[1100, 720]],
    mock: { ...mock(), fail: { threads_list: "temporarily unavailable" } },
    async run(page, h) {
      await h.waitText("Conversations couldn’t be loaded.");
      expect(!(await page.$eval('[data-sidebar-conversations]', (section) => section.textContent.includes("No conversations yet."))), "a history failure was mistaken for an empty history");
      await page.evaluate(() => delete window.__MOCK__.fail.threads_list);
      await h.click("[data-conversations-trigger]");
      await page.waitForSelector("[data-conversations-menu] [data-thread-id]", { timeout: 5000 });
      await page.keyboard.press("Escape");
      await page.waitForSelector("[data-sidebar-thread]", { timeout: 5000 });
      expect((await rows(page)).length === 2, "retry did not refresh the sidebar history");
    },
  },
  {
    name: "sidebar-conversations",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: mock(),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await page.waitForSelector("[data-sidebar-thread]", { timeout: 3000 });
      // Docked: no pane header; the views and the bar's controls are in the sidebar, under the space.
      const docked = await page.evaluate(() => ({
        header: !!document.querySelector("[data-space-pane][data-shown] [data-space-header]"),
        tabs: !!document.querySelector("#spaces-sidebar [data-sidebar-conversations] [data-view-switcher]"),
        trigger: !!document.querySelector("#spaces-sidebar [data-conversations-host] [data-conversations-trigger]"),
        newButtons: document.querySelectorAll("[data-new-conversation]:not([inert] *)").length,
        stamp: document.querySelector('nav[aria-label="Where you are"]')?.textContent ?? "",
      }));
      expect(!docked.header && docked.tabs && docked.trigger, `docked layout ${JSON.stringify(docked)}`);
      expect(docked.newButtons === 1, `${docked.newButtons} New conversation buttons reachable`);
      expect(!/ago|Just now|Today|Yesterday/.test(docked.stamp), `breadcrumb carries a date: ${docked.stamp}`);
      let list = await rows(page);
      expect(list.length === 2, `sidebar lists ${list.length} conversations`);
      expect(list[0].current === "page", "the open conversation is not marked current");
      expect((await crumb(page)).startsWith("What do I have due"), `breadcrumb reads “${await crumb(page)}”`);

      // Open the saved one from the sidebar.
      await h.click(`[data-sidebar-thread="${archive[0].id}"]`);
      await h.waitText("characteristic polynomial");
      await page.waitForFunction(() => document.activeElement?.matches("[data-composer-input]"), { timeout: 3000 });
      const [[, args]] = await calls(page, "thread_open");
      expect(args.space === "school" && args.id === archive[0].id, `thread_open args ${JSON.stringify(args)}`);
      await page.waitForFunction(() => document.querySelector('[data-testid="conversation-status"]')?.textContent.startsWith("Opened the conversation “Summarise my M301"), { timeout: 2000 });
      await page.waitForFunction(() => document.querySelector('[data-sidebar-thread][aria-current="page"]')?.textContent.includes("Summarise my M301"), { timeout: 3000 });
      expect((await crumb(page)).startsWith("Summarise my M301"), `breadcrumb after open reads “${await crumb(page)}”`);

      // New conversation from the sidebar.
      await h.click("#spaces-sidebar [data-new-conversation]");
      await h.waitText("Start a conversation in School");
      expect((await calls(page, "thread_new")).length === 1, "the sidebar’s New conversation did not call thread_new");
      await page.waitForFunction(() => document.activeElement?.matches("[data-composer-input]"), { timeout: 3000 });
      expect((await crumb(page)) === "New conversation", `breadcrumb on a new conversation reads “${await crumb(page)}”`);

      // The Conversations menu, from the sidebar's header.
      await h.click("#spaces-sidebar [data-conversations-trigger]");
      await page.waitForSelector("[data-conversations-menu]", { timeout: 3000 });
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("[data-conversations-menu]"), { timeout: 3000 });

      // Another view, from the sidebar: the breadcrumb names it; opening a conversation from there goes back to Chat.
      await h.click('#spaces-sidebar [data-view-tab="study"]');
      await page.waitForFunction(() => document.querySelector('nav[aria-label="Where you are"] [aria-current="page"]')?.textContent.trim() === "Study", { timeout: 2000 });
      await page.click('[data-sidebar-thread]:not([aria-current])');
      await page.waitForFunction(() => document.querySelector('[data-space-pane][data-shown] [data-space-view="chat"][data-view-shown]'), { timeout: 3000 });
      await page.waitForFunction(() => document.querySelector('nav[aria-label="Where you are"] [aria-current="page"]')?.textContent.trim() !== "Study", { timeout: 3000 });

      // Search entry opens Search conversations.
      await h.click("[data-sidebar-search]");
      await page.waitForSelector('[data-search-dialog] dialog[open]', { timeout: 3000 });
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[data-search-dialog] dialog[open]'), { timeout: 3000 });

      // Sidebar hidden: the compact header takes the views and the bar, and New conversation still works.
      await h.click('button[aria-controls="spaces-sidebar"]');
      await page.waitForSelector("[data-space-pane][data-shown] [data-space-header] [data-conversations-trigger]", { timeout: 3000 });
      expect(!!(await page.$("[data-space-pane][data-shown] [data-space-header] [data-view-switcher]")), "no views in the compact header");
      await h.click("[data-space-pane][data-shown] [data-space-header] [data-new-conversation]");
      await page.waitForFunction(() => window.__calls.filter(([c]) => c === "thread_new").length === 2, { timeout: 3000 });
      await h.click('button[aria-controls="spaces-sidebar"]');
      await page.waitForSelector("#spaces-sidebar [data-conversations-host] [data-conversations-trigger]", { timeout: 3000 });
      await h.idle();
    },
  },
  {
    name: "sidebar-conversations-narrow",
    sizesRequired: true,
    sizes: [[640, 480]],
    themes: ["light"],
    mock: mock(),
    async run(page, h) {
      await h.waitText("Problem set 4");
      // Sidebar closed: the compact header has the views and the bar.
      await page.waitForSelector("[data-space-pane][data-shown] [data-space-header] [data-view-switcher]", { timeout: 3000 });
      await page.waitForSelector("[data-space-pane][data-shown] [data-space-header] [data-conversations-trigger]", { timeout: 3000 });
      // Open the overlaid sidebar and open a saved conversation from it: it closes, the conversation opens.
      await page.click('button[aria-controls="spaces-sidebar"]');
      await page.waitForSelector("#spaces-sidebar[data-overlay]:not([hidden]) [data-sidebar-thread]", { timeout: 5000 });
      await h.click(`[data-sidebar-thread="${archive[0].id}"]`);
      await h.waitText("characteristic polynomial");
      await page.waitForFunction(() => document.getElementById("spaces-sidebar")?.hidden, { timeout: 3000 });
      expect((await calls(page, "thread_open")).length === 1, "thread_open not called from the narrow sidebar");
      await page.waitForSelector("[data-space-pane][data-shown] [data-space-header] [data-conversations-trigger]", { timeout: 3000 });
      await h.idle();
    },
  },
];
