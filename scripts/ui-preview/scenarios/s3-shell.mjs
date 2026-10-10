// Shell round 3 (persona re-check fixes), all behaviour checks: check(...) fails the run.
//   s3-conv-current    the bar names the open conversation and its date; menu titles wrap to two lines (Priya 3)
//   s3-conv-delete     Delete in the Conversations menu: inline confirm, announced, the open one starts afresh (Sam 13)
//   s3-conv-delete-busy  Delete while a reply runs is refused, nothing deleted
//   s3-conv-keys       arrows skip the rows' Delete (ArrowRight reaches it); Delete/Backspace on a row asks (Dev)
//   s3-conv-versions   Edit/Regenerate copies read "Earlier version" with their time, in the menu and the confirm (Sam)
//   s3-conv-forced     forced colours: the confirm keeps its frame, Delete has an icon and a heavier border (Tomás)
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
      const clash = await page.evaluate(() => {
        const trigger = document.querySelector("[data-conversations-trigger]").getBoundingClientRect();
        return [...document.querySelectorAll("[data-conversation-current] > span")].some((n) => {
          const r = n.getBoundingClientRect();
          return r.right > trigger.left + 0.5 && r.bottom > trigger.top && r.top < trigger.bottom;
        });
      });
      check(!clash, "neither the title nor the date runs into the Conversations button");
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
      // Priya: an empty conversation shows no title, so "New conversation" isn't there twice (it read as a second button).
      await page.waitForFunction(() => !document.querySelector("[data-conversation-current]"), { timeout: 3000 }).catch(() => {});
      const words = await page.$eval("[data-conversations-bar]", (b) => b.innerText.match(/New conversation/g)?.length ?? 0);
      check(!(await page.$("[data-conversation-current]")) && words === 1, "an empty conversation shows no title; \"New conversation\" is only the button", `${words}`);
      await h.shot("empty");
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
      // Sam: it says which one (when, how long) and what stays behind, and is described by both.
      const more = await page.$eval(`[data-delete-confirm="${yesterday}"]`, (g) => ({
        stamp: g.querySelector("[data-delete-stamp]")?.textContent,
        stays: g.querySelector("[data-delete-stays]")?.textContent.replace(/\s+/g, " "),
        described: (g.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" | "),
      }));
      check(/^Yesterday at .+ · 2 messages$/.test(more.stamp ?? ""), "the confirm says when it was last used", JSON.stringify(more));
      check(more.stays === "Files you attached to it stay in School’s attachments folder, and what was already sent to Anthropic isn’t affected.", "the confirm says attachments stay and what was sent to Anthropic isn't affected", JSON.stringify(more));
      check(more.described.includes("Yesterday at") && more.described.includes("attachments folder"), "the group is described by both lines", more.described);
      check((await calls(page, "thread_delete")).length === 0, "nothing is deleted before confirming");
      await h.idle(); // past the menu's open animation
      const apart = await page.evaluate((id) => {
        const c = document.querySelector(`[data-delete-cancel="${id}"]`).getBoundingClientRect();
        const d = document.querySelector(`[data-delete-confirm-button="${id}"]`).getBoundingClientRect();
        const min = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ph-target-min")) || 24;
        return { gap: Math.max(d.left - c.right, c.left - d.right, d.top - c.bottom), min };
      }, yesterday);
      check(apart.gap >= apart.min, "Cancel and Delete are at least a target apart, so a slip off Cancel can't delete", JSON.stringify(apart));
      await h.shot("confirm");
      // Cancel puts focus back on that row's Delete.
      await page.keyboard.press("Enter");
      check(await waitActive(page, `delete:${yesterday}`), "Cancel returns focus to Delete", await active(page));
      check(!(await page.$(`[data-delete-confirm="${yesterday}"]`)), "the confirm is gone after Cancel");
      // Escape in the confirm backs out of the confirm only; the menu stays open.
      await page.keyboard.press("Enter");
      await page.waitForSelector(`[data-delete-confirm="${yesterday}"]`, { timeout: 3000 });
      await page.keyboard.press("Escape");
      check(await waitActive(page, `delete:${yesterday}`), "Escape in the confirm returns focus to Delete", await active(page));
      check(!!(await page.$('[role="menu"]')) && !(await page.$(`[data-delete-confirm="${yesterday}"]`)), "and the menu stays open");
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
    // Dev: arrows go conversation to conversation (Delete is beside each, on ArrowRight), and the
    // Delete or Backspace key on a conversation asks to delete it.
    name: "s3-conv-keys",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: conversations(),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await h.focusVia("[data-conversations-trigger]");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-conversations-menu] [role="menuitemradio"]', { timeout: 5000 });
      check(await waitActive(page, "current"), "the menu opens on the open conversation", await active(page));
      const [yesterday, older] = [String(now - DAY), String(now - 2 * DAY)];
      await page.keyboard.press("ArrowDown");
      check(await waitActive(page, yesterday), "ArrowDown goes to the next conversation, not to a Delete", await active(page));
      const keys = await page.$eval(`[data-thread-id="${yesterday}"]`, (r) => r.getAttribute("aria-keyshortcuts"));
      check(keys === "Delete", "each conversation tells assistive tech its Delete key", keys);
      await page.keyboard.press("ArrowRight");
      check(await waitActive(page, `delete:${yesterday}`), "ArrowRight goes to its Delete", await active(page));
      await page.keyboard.press("ArrowLeft");
      check(await waitActive(page, yesterday), "ArrowLeft comes back", await active(page));
      // Delete key: the same inline confirm, focus on Cancel; Cancel goes back to the conversation.
      await page.keyboard.press("Delete");
      check(await waitActive(page, `cancel:${yesterday}`), "the Delete key opens the confirm, on Cancel", await active(page));
      check((await calls(page, "thread_delete")).length === 0, "nothing is deleted yet");
      await page.keyboard.press("Enter");
      check(await waitActive(page, yesterday), "Cancel goes back to the conversation the key was pressed on", await active(page));
      // Backspace too, then confirm.
      await page.keyboard.press("Backspace");
      check(await waitActive(page, `cancel:${yesterday}`), "Backspace opens the confirm too", await active(page));
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction((id) => document.activeElement?.getAttribute("data-delete-confirm-button") === id, { timeout: 3000 }, yesterday);
      await page.keyboard.press("Enter");
      await page.waitForFunction((id) => !document.querySelector(`[data-thread-id="${id}"]`), { timeout: 3000 }, yesterday);
      const del = await calls(page, "thread_delete");
      check(JSON.stringify(del) === JSON.stringify([{ space: "school", id: yesterday }]), "Backspace, then Delete, deletes that one", JSON.stringify(del));
      check(await waitActive(page, older), "focus moves to the conversation that took its place", await active(page));
      // ArrowUp skips Delete items too.
      await page.keyboard.press("ArrowUp");
      check(await waitActive(page, "current"), "ArrowUp goes to the conversation above, not its Delete", await active(page));
      await h.shot("after");
      await page.keyboard.press("Escape");
      await menuGone(page);
    },
  },
  {
    // Sam: versions kept by Edit or Regenerate (same title) are told apart: time of day and "Earlier version".
    name: "s3-conv-versions",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: conversations({
      threadArchive: {
        school: [
          { id: String(now - 3 * DAY - 3600000), updated: now - 3 * DAY - 3600000, messages: structuredClone(current).slice(0, 2) },
          { id: String(now - 3 * DAY), updated: now - 3 * DAY, messages: structuredClone(current) },
          ...archive(),
        ],
      },
    }),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await openMenu(page);
      await h.idle();
      const stamps = await page.$$eval('[data-conversations-menu] [role="menuitemradio"]', (rows) =>
        Object.fromEntries(rows.map((r) => [r.dataset.threadId, r.querySelector("[data-thread-stamp]")?.textContent])),
      );
      const [v1, v2] = [String(now - 3 * DAY - 3600000), String(now - 3 * DAY)];
      check(/^Earlier version · \S+ at .+ · 2 messages$/.test(stamps[v1] ?? "") && /^Earlier version · \S+ at /.test(stamps[v2] ?? ""), "older copies of the open conversation read \"Earlier version\" with their time", JSON.stringify(stamps));
      check(stamps[v1] !== stamps[v2], "two versions from the same day can be told apart", JSON.stringify(stamps));
      check(stamps.current === "Current · 2 messages", "the open one is still Current", stamps.current);
      check(/^Yesterday at .+ · 2 messages$/.test(stamps[String(now - DAY)] ?? "") && !/Earlier/.test(stamps[String(now - DAY)]), "a conversation with its own title is unchanged", JSON.stringify(stamps));
      await h.shot("menu");
      await page.click(`[data-delete-thread="${v1}"]`);
      await page.waitForSelector(`[data-delete-confirm="${v1}"]`, { timeout: 3000 });
      const s = await page.$eval(`[data-delete-confirm="${v1}"] [data-delete-stamp]`, (p) => p.textContent);
      check(s === stamps[v1], "the confirm shows which version it is about", s);
      await h.shot("confirm");
    },
  },
  {
    // Tomás: in forced colours the delete confirm keeps its frame, and Delete is told from Cancel by more than colour.
    name: "s3-conv-forced",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: conversations(),
    async run(page, h) {
      // Puppeteer refuses forced-colors, so through CDP (as shoot.mjs --forced-colors does).
      const cdp = await page.createCDPSession();
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "forced-colors", value: "active" }] });
      await h.waitText("Problem set 4");
      await openMenu(page);
      const id = String(now - DAY);
      await page.click(`[data-delete-thread="${id}"]`);
      await page.waitForSelector(`[data-delete-confirm="${id}"]`, { timeout: 3000 });
      await h.idle();
      const r = await page.evaluate((id) => {
        const g = getComputedStyle(document.querySelector(`[data-delete-confirm="${id}"]`));
        const cancel = document.querySelector(`[data-delete-cancel="${id}"]`);
        const del = document.querySelector(`[data-delete-confirm-button="${id}"]`);
        return {
          frame: g.borderTopStyle !== "none" && parseFloat(g.borderTopWidth) > 0,
          delIcon: !!del.querySelector("svg"),
          cancelIcon: !!cancel.querySelector("svg"),
          delBorder: parseFloat(getComputedStyle(del).borderTopWidth),
          cancelBorder: parseFloat(getComputedStyle(cancel).borderTopWidth),
        };
      }, id);
      check(r.frame, "the confirm keeps a frame in forced colours", JSON.stringify(r));
      check(r.delIcon && !r.cancelIcon && r.delBorder > r.cancelBorder, "Delete has an icon and a heavier border; Cancel has neither", JSON.stringify(r));
      // No mid-run shot here: --axe would read the author colours under forced colours and
      // report contrast that isn't shown (shoot.mjs turns that rule off only for --forced-colors).
      await cdp.send("Emulation.setEmulatedMedia", { features: [] });
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
  {
    // With Claude Code answering, a single-file grant says it isn't used (Claude Code gets granted folders only).
    name: "s3-chip-claude-code",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: {
      settings: { backend: "claude-cli", hasAnthropicKey: false, model: "claude-opus-5-5" },
      threads: { school: structuredClone(current) },
      grants: {
        school: [
          { id: "g-cal", from: "work", path: "calendar", created: "2026-10-09T15:20:00Z", scope: "always" },
          { id: "g-pdf", from: "work", path: "intake.pdf", created: "2026-10-10T09:00:00Z", scope: "always" },
        ],
      },
    },
    async run(page, h) {
      await page.click("[data-grants-chip]");
      await page.waitForSelector('[data-radix-popper-content-wrapper] [role="dialog"]', { timeout: 5000 });
      await h.idle();
      const notes = await page.evaluate(() =>
        [...document.querySelectorAll("[data-revoke]")].map((b) => ({ id: b.getAttribute("data-revoke"), note: !!b.closest("li")?.querySelector("[data-cli-cant-read]") })),
      );
      const by = Object.fromEntries(notes.map((n) => [n.id, n.note]));
      check(by["g-pdf"] === true && by["g-cal"] === false, "only the single-file grant says Claude Code can't read it", JSON.stringify(notes));
      const intro = await page.$eval('[data-radix-popper-content-wrapper] [role="dialog"]', (d) => d.innerText);
      check(intro.includes("Claude Code can’t ask") && !intro.includes("Phaethon asks you first"), "the intro doesn't promise that Claude Code will ask");
      await h.shot("cli-note");
    },
  },
];
