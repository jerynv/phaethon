// Shell round 3 (persona re-check fixes), all behaviour checks: check(...) fails the run.
//   s3-conv-current    the bar names the open conversation and its date; menu titles wrap to two lines (Priya 3)
//   s3-conv-delete     Delete in the Conversations menu: inline confirm, announced, the open one starts afresh (Sam 13)
//   s3-conv-delete-busy  Delete while a reply runs is refused, nothing deleted
//   s3-conv-tip        New conversation's tooltip gives only the shortcut as its description (Maya)
//   s3-needs-you-name  a space's name is never cut for its "Needs you" (Priya)
//   s3-undo-stays      the popover's Undo stays while it is open; closing ends it; words say what stays (Jordan 3, Sam 12)
//   s3-large-targets   with Larger click targets the title bar holds its chip, and spaces stand apart (Jordan)
import { check, park } from "../audit-fixtures.mjs";

const DAY = 86400000;
const now = Date.now();
const LONG_TITLE = "Can you go through every reading listed for the history seminar";
const current = [
  { role: "user", text: "What do I have due this week for C241?", attachments: [] },
  { role: "assistant", text: "Problem set 4 on Wednesday, and Test 1 on Thursday.", attachments: [] },
];
const archive = () => [
  {
    id: String(now - DAY),
    updated: now - DAY,
    messages: [
      { role: "user", text: "Summarise my M301 notes on eigenvalues", attachments: [] },
      { role: "assistant", text: "Three ideas: the characteristic polynomial, eigenspaces and diagonalisation.", attachments: [] },
    ],
  },
  {
    id: String(now - 2 * DAY),
    updated: now - 2 * DAY,
    messages: [
      { role: "user", text: `${LONG_TITLE} and which ones are optional?`, attachments: [] },
      { role: "assistant", text: "Four of the eleven are required.", attachments: [] },
    ],
  },
];
const conversations = (extra = {}) => ({
  threads: { school: structuredClone(current) },
  threadArchive: { school: archive() },
  currentUpdated: { school: now - 3 * 3600000 },
  ...extra,
});
const DYSLEXIC = { backend: "phaethon", hasAnthropicKey: true, model: "claude-opus-5-5", appearance: { readingFont: "opendyslexic" } };

const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const shellSaid = (page, text, timeout = 4000) =>
  page.waitForFunction((t) => document.querySelector("[data-shell-status]")?.textContent === t, { timeout }, text).then(() => true, () => false);
const shellStatus = (page) => page.evaluate(() => document.querySelector("[data-shell-status]")?.textContent ?? "");
const paneSaid = (page, text, timeout = 4000) =>
  page.waitForFunction((t) => document.querySelector('[data-testid="conversation-status"]')?.textContent === t, { timeout }, text).then(() => true, () => false);
const barText = (page) => page.evaluate(() => document.querySelector("[data-conversation-current]")?.textContent?.replace(/\s+/g, " ").trim() ?? "");
const openMenu = async (page) => {
  await page.click("[data-conversations-trigger]");
  await page.waitForSelector('[data-conversations-menu] [role="menuitemradio"]', { timeout: 5000 });
};
const menuGone = (page) => page.waitForFunction(() => !document.querySelector("[data-conversations-menu]"), { timeout: 3000 });
const active = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return a?.getAttribute("data-thread-id") ?? (a?.getAttribute("data-delete-thread") != null ? `delete:${a.getAttribute("data-delete-thread")}` : null) ??
      (a?.getAttribute("data-delete-cancel") != null ? `cancel:${a.getAttribute("data-delete-cancel")}` : a?.tagName);
  });
const waitActive = (page, want) =>
  page
    .waitForFunction(
      (want) => {
        const a = document.activeElement;
        const id = a?.getAttribute("data-thread-id") ?? (a?.getAttribute("data-delete-thread") != null ? `delete:${a.getAttribute("data-delete-thread")}` : null) ??
          (a?.getAttribute("data-delete-cancel") != null ? `cancel:${a.getAttribute("data-delete-cancel")}` : null);
        return id === want;
      },
      { timeout: 3000 },
      want,
    )
    .then(() => true, () => false);

export default [
  {
    name: "s3-conv-current",
    sizes: [[1100, 720], [760, 560]],
    mock: conversations({ settings: DYSLEXIC }),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await page.waitForSelector("[data-conversation-current]", { timeout: 5000 });
      let bar = await barText(page);
      check(bar.startsWith("What do I have due this week for C241?") && bar.includes("Today at"), "the bar names the open conversation and when it was last used", bar);
      // The title may be cut to fit, but the date never is.
      const fit = await page.evaluate(() => {
        const p = document.querySelector("[data-conversation-current]");
        const date = p.lastElementChild.getBoundingClientRect();
        const bar = p.closest("[data-conversations-bar]").getBoundingClientRect();
        return { dateRight: date.right, barRight: bar.right, scroll: document.documentElement.scrollWidth, w: innerWidth };
      });
      check(fit.dateRight <= fit.barRight && fit.scroll <= fit.w, "the bar fits the window, its date whole", JSON.stringify(fit));
      await openMenu(page);
      await h.idle();
      // In OpenDyslexic, a long title takes two lines instead of being cut at about 16 characters.
      const t = await page.evaluate((id) => {
        const el = document.querySelector(`[data-thread-id="${id}"] [title]`);
        const lh = parseFloat(getComputedStyle(el).lineHeight);
        return { lines: Math.round(el.getBoundingClientRect().height / lh), oneLineCut: el.scrollWidth > el.clientWidth + 1 };
      }, String(now - 2 * DAY));
      check(t.lines === 2 && !t.oneLineCut, "a long title wraps to two lines in the menu", JSON.stringify(t));
      await h.shot("menu");
      // Opening another conversation updates the bar.
      await page.click(`[data-thread-id="${now - DAY}"]`);
      await h.waitText("characteristic polynomial");
      await page.waitForFunction(() => document.querySelector("[data-conversation-current]")?.textContent.includes("Summarise my M301"), { timeout: 3000 });
      bar = await barText(page);
      check(bar.includes("Yesterday at"), "after opening one, the bar shows its title and date", bar);
      await menuGone(page);
      await page.click("[data-new-conversation]");
      await h.waitText("Start a conversation in School");
      await page.waitForFunction(() => document.querySelector("[data-conversation-current]")?.textContent === "New conversation", { timeout: 3000 });
      check(true, "a new conversation reads \"New conversation\" in the bar");
      await park(page);
    },
  },
  {
    name: "s3-conv-delete",
    sizes: [[1100, 720]],
    mock: conversations(),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await openMenu(page);
      const yesterday = String(now - DAY);
      // Delete a saved one: an inline confirm names it, focus on Cancel, nothing deleted yet.
      await page.click(`[data-delete-thread="${yesterday}"]`);
      await page.waitForSelector(`[data-delete-confirm="${yesterday}"]`, { timeout: 3000 });
      const confirmText = await page.$eval(`[data-delete-confirm="${yesterday}"] p`, (p) => p.textContent);
      check(confirmText === "Delete “Summarise my M301 notes on eigenvalues” for good? It can’t be opened again.", "the confirm names the conversation and says it is for good", confirmText);
      check(await waitActive(page, `cancel:${yesterday}`), "focus is on Cancel (the safe choice)", await active(page));
      const named = await page.$eval(`[data-delete-confirm="${yesterday}"]`, (g) => ({ role: g.getAttribute("role"), label: document.getElementById(g.getAttribute("aria-labelledby"))?.textContent }));
      check(named.role === "group" && named.label === confirmText, "the confirm is a group named by its question", JSON.stringify(named));
      check((await calls(page, "thread_delete")).length === 0, "nothing is deleted before confirming");
      await h.idle(); // past the menu's open animation
      await h.shot("confirm");
      // Cancel puts focus back on that row's Delete.
      await page.keyboard.press("Enter");
      check(await waitActive(page, `delete:${yesterday}`), "Cancel returns focus to Delete", await active(page));
      check(!(await page.$(`[data-delete-confirm="${yesterday}"]`)), "the confirm is gone after Cancel");
      // Delete for real, from the keyboard.
      await page.keyboard.press("Enter");
      check(await waitActive(page, `cancel:${yesterday}`), "Delete opens the confirm again", await active(page));
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction((id) => document.activeElement?.getAttribute("data-delete-confirm-button") === id, { timeout: 3000 }, yesterday);
      await page.keyboard.press("Enter");
      await page.waitForFunction((id) => !document.querySelector(`[data-thread-id="${id}"]`), { timeout: 3000 }, yesterday);
      const del = await calls(page, "thread_delete");
      check(JSON.stringify(del) === JSON.stringify([{ space: "school", id: yesterday }]), "thread_delete gets the space and that conversation's id", JSON.stringify(del));
      check(await shellSaid(page, "Deleted the conversation “Summarise my M301 notes on eigenvalues”."), "the delete is announced", await shellStatus(page));
      check(!!(await page.$("[data-conversations-menu]")), "the menu stays open");
      check(await waitActive(page, String(now - 2 * DAY)), "focus moves to the conversation that took its place", await active(page));
      await h.shot("deleted");
      // Delete the open one: a new conversation starts.
      await page.click('[data-delete-thread="current"]');
      await page.waitForSelector('[data-delete-confirm="current"]', { timeout: 3000 });
      const c2 = await page.$eval('[data-delete-confirm="current"] p', (p) => p.textContent);
      check(c2.endsWith("A new conversation starts in its place."), "deleting the open one says a new one starts", c2);
      await page.click('[data-delete-confirm-button="current"]');
      await h.waitText("Start a conversation in School");
      await page.waitForFunction(() => document.activeElement?.matches("[data-composer-input]"), { timeout: 3000 });
      const del2 = (await calls(page, "thread_delete")).at(-1);
      check(del2?.id === "current", "the open one is deleted as \"current\"", JSON.stringify(del2));
      check((await calls(page, "thread_new")).length === 0, "no thread_new (it would keep a copy in the list)");
      check(await paneSaid(page, "Deleted “What do I have due this week for C241?”. A new conversation has started."), "the new start is announced", "");
      check(!(await page.evaluate(() => document.body.innerText.includes("Problem set 4"))), "the deleted conversation is gone from the screen");
      await menuGone(page);
      await openMenu(page);
      const left = await page.$$eval('[data-conversations-menu] [role="menuitemradio"]', (els) => els.map((e) => e.dataset.threadId));
      check(left.join() === `current,${now - 2 * DAY}`, "the list has the new conversation and the one left", left.join());
      check(!(await page.$('[data-delete-thread="current"]')), "an empty new conversation has no Delete");
      await page.keyboard.press("Escape");
      await menuGone(page);
    },
  },
  {
    name: "s3-conv-delete-busy",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: conversations({ holdOpen: true, turn: [{ kind: "text", delta: "Looking at your syllabus, the first thing" }] }),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await h.send("And next week?");
      await h.waitText("Looking at your syllabus");
      await openMenu(page);
      await page.click(`[data-delete-thread="${now - DAY}"]`);
      await page.click(`[data-delete-confirm-button="${now - DAY}"]`);
      await page.waitForSelector('[data-conversations-problem][role="alert"]', { timeout: 3000 });
      check((await calls(page, "thread_delete")).length === 0, "nothing is deleted while a reply runs");
      await menuGone(page);
      check(await page.evaluate(() => document.activeElement?.matches("[data-conversations-trigger]")), "focus goes back to Conversations, next to the alert");
    },
  },
  {
    name: "s3-conv-tip",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: conversations(),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await page.hover("[data-new-conversation]");
      await page.waitForSelector('[role="tooltip"]', { timeout: 3000 });
      await h.idle();
      const cdp = await page.createCDPSession();
      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "[data-new-conversation]" });
      const { node } = await cdp.send("DOM.describeNode", { nodeId });
      const ax = nodes.find((n) => n.backendDOMNodeId === node.backendNodeId);
      const name = ax?.name?.value ?? "";
      const desc = ax?.description?.value ?? "";
      check(name === "New conversation", "the button is named by its words", name);
      check(desc === "Command N", "while its tooltip shows, it is described only by the shortcut, in words", desc);
      await h.shot("tip");
    },
  },
  {
    name: "s3-needs-you-name",
    sizes: [[1100, 720]],
    mock: {
      settings: DYSLEXIC,
      threads: { school: structuredClone(current) },
      spaces: [
        { id: "school", name: "School", description: "Courses, deadlines, study notes", hue: 250 },
        { id: "psych", name: "Psychology", description: "PSY101 lectures and essays", hue: 160 },
      ],
    },
    async run(page, h) {
      await h.idle();
      await page.evaluate(() => window.__setSpaceActivity("psych", { running: true, needsYou: true }));
      await page.waitForSelector('[data-space-id="psych"] [data-space-activity]', { timeout: 3000 });
      await h.idle();
      const r = await page.evaluate(() => {
        const b = document.querySelector('[data-space-id="psych"]');
        const name = [...b.querySelectorAll('[aria-hidden="true"]')].find((s) => s.textContent === "Psychology").parentElement;
        const badge = b.querySelector("[data-space-activity]").getBoundingClientRect();
        const box = b.getBoundingClientRect();
        return { cut: name.scrollWidth > name.clientWidth + 1, badgeIn: badge.right <= box.right + 0.5 && badge.left >= box.left, badge: b.querySelector("[data-space-activity]").textContent };
      });
      check(!r.cut, "the space's name shows whole while it needs you", JSON.stringify(r));
      check(r.badgeIn && r.badge === "Needs you", "\"Needs you\" still shows, inside the item", JSON.stringify(r));
      await page.evaluate(() => window.__setSpaceActivity("psych", { running: true, needsYou: false }));
      await h.idle();
      await h.shot("answering");
    },
  },
  {
    // Undo pressed before the core has answered the remove: the grant still comes back (the restore waits for the remove).
    name: "s3-undo-early",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: {
      threads: { school: structuredClone(current) },
      grants: { school: [{ id: "g-now", from: "work", path: "projects/now.md", created: "2026-10-10T09:00:00Z", scope: "always" }] },
      slow: { grant_revoke: 800 },
    },
    async run(page, h) {
      await page.click("[data-grants-chip]");
      await page.waitForSelector('[data-radix-popper-content-wrapper] [role="dialog"]', { timeout: 5000 });
      await page.click('[data-revoke="g-now"]');
      await page.waitForSelector('[data-undo="g-now"]', { timeout: 3000 });
      await page.click('[data-undo="g-now"]');
      // Past the slow remove (800 ms) and the restore after it.
      await new Promise((r) => setTimeout(r, 1800));
      const order = await page.evaluate(() => window.__calls.filter(([c]) => c === "grant_revoke" || c === "grant_restore").map(([c]) => c));
      const back = await page.evaluate(() => (window.__MOCK__.grants.school ?? []).some((g) => g.id === "g-now"));
      check(order.join() === "grant_revoke,grant_restore", "the restore is asked only after the remove", order.join());
      check(back, "an Undo pressed before the remove finished still puts the grant back");
      check(!!(await page.$('[data-revoke="g-now"]')), "and its row offers Remove again");
    },
  },
  {
    name: "s3-undo-stays",
    sizes: [[1100, 720]],
    mock: {
      threads: { school: structuredClone(current) },
      grants: {
        school: [
          { id: "g-cal", from: "work", path: "calendar", created: "2026-10-09T15:20:00Z", scope: "always" },
          { id: "g-now", from: "work", path: "projects/now.md", created: "2026-10-10T09:00:00Z", scope: "always" },
        ],
      },
    },
    async run(page, h) {
      await page.click("[data-grants-chip]");
      await page.waitForSelector('[data-radix-popper-content-wrapper] [role="dialog"]', { timeout: 5000 });
      await h.idle();
      const text = await page.$eval('[data-radix-popper-content-wrapper] [role="dialog"]', (d) => d.innerText);
      check(/already read stays in this space’s conversation/.test(text), "the popover says what was already read stays", text.split("\n").slice(0, 3).join(" / "));
      check(!/revok|take (it )?back/i.test(text), "one verb: Remove (no revoke, no take back)", text);
      await page.click('[data-revoke="g-now"]');
      await page.waitForSelector('[data-undo="g-now"]', { timeout: 3000 });
      check(
        await shellSaid(page, "School can no longer read Work / projects/now.md. Anything already read stays in School’s conversation. Undo is next to it until you close this list."),
        "Remove is announced with what stays and where Undo is",
        await shellStatus(page),
      );
      // Longer than the old six seconds: Undo is still there while the popover is open.
      await new Promise((r) => setTimeout(r, 7000));
      check(!!(await page.$('[data-undo="g-now"]')), "Undo is still offered after 7 s with the popover open");
      check((await calls(page, "grant_restore")).length === 0, "nothing restored yet");
      await h.shot("undo-waits");
      await page.click('[data-undo="g-now"]');
      await page.waitForFunction(() => (window.__MOCK__.grants.school ?? []).some((g) => g.id === "g-now"), { timeout: 3000 });
      check(true, "Undo after 7 s still puts the grant back");
      // Remove both, then close: the chip goes, focus goes to the conversation.
      await page.click('[data-revoke="g-now"]');
      await page.waitForSelector('[data-undo="g-now"]', { timeout: 3000 });
      await page.click('[data-revoke="g-cal"]');
      await page.waitForSelector('[data-undo="g-cal"]', { timeout: 3000 });
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("[data-grants-chip]"), { timeout: 3000 });
      await h.idle();
      const f = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
      check(f === "main", "closing with every row removed puts focus on the conversation, not the page", f);
      check((await calls(page, "grant_restore")).length === 1, "closing the list restores nothing");
    },
  },
  {
    name: "s3-large-targets",
    sizes: [[1100, 720], [760, 560]],
    mock: {
      settings: { backend: "phaethon", hasAnthropicKey: true, model: "claude-opus-5-5", appearance: { tokens: { "--ph-target-size": 44 } } },
      threads: { school: structuredClone(current) },
      grants: { school: [{ id: "g-cal", from: "work", path: "calendar", created: "2026-10-09T15:20:00Z", scope: "always" }] },
    },
    async run(page, h) {
      await h.idle();
      check((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ph-target-min").trim())) === "44px", "Larger click targets is on", "");
      const r = await page.evaluate(() => {
        const bar = document.querySelector("header").getBoundingClientRect();
        const chip = document.querySelector("[data-grants-chip]").getBoundingClientRect();
        const toggle = document.querySelector('button[aria-controls="spaces-sidebar"]').getBoundingClientRect();
        return { bar: [bar.top, bar.bottom], chip: [chip.top, chip.bottom, chip.height], toggle: [toggle.top, toggle.bottom] };
      });
      check(r.chip[2] >= 44 && r.chip[0] >= r.bar[0] && r.chip[1] <= r.bar[1], "the 44 px chip sits inside the title bar", JSON.stringify(r));
      check(r.toggle[0] >= r.bar[0] && r.toggle[1] <= r.bar[1], "the sidebar toggle sits inside the title bar", JSON.stringify(r));
      if (await page.evaluate(() => document.getElementById("spaces-sidebar")?.hidden)) {
        await page.click('button[aria-controls="spaces-sidebar"]');
        await page.waitForSelector("#spaces-sidebar:not([hidden])", { timeout: 5000 });
      }
      const gap = await page.evaluate(() => {
        const [a, b] = [...document.querySelectorAll("#spaces-sidebar [data-space-id]")].map((e) => e.getBoundingClientRect());
        return b.top - a.bottom;
      });
      check(gap >= 6, "spaces stand at least 6 px apart with Larger click targets", gap);
      await park(page);
    },
  },
];
