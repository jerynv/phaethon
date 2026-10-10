// Clear and Delete everything in the Conversations menu, the space's memory, and message times.
// All behaviour checks: check(...) fails the run.
//   f3-clear            Clear on a saved conversation: picks details, closes the menu, announces, shows what was kept
//   f3-clear-current    Clear on the open one: a new conversation starts, focus in the composer, the note stays
//   f3-clear-fails      no key / offline: nothing changes, said in the confirm; Cancel or Clear without keeping anything
//   f3-forget           Delete everything says what goes (files only it uses, kept details), removes it, announces
//   f3-narrow           640x480: the three choices fit, each a target apart, the menu scrolls instead of spilling
//   f3-forced           forced colours: Clear and Delete everything are told from Cancel by more than colour
//   f3-times            message times: short, after the text, full date for screen readers, none for old saves
import { check, park } from "../audit-fixtures.mjs";

const DAY = 86400000;
const now = Date.now();
const current = [
  { role: "user", text: "What do I have due this week for C241?", attachments: [] },
  { role: "assistant", text: "Problem set 4 on Wednesday, and Test 1 on Thursday.", attachments: [] },
];
const yesterday = String(now - DAY);
const older = String(now - 2 * DAY);
const archive = () => [
  {
    id: yesterday,
    updated: now - DAY,
    messages: [
      { role: "user", text: "Summarise my M301 notes on eigenvalues", attachments: [{ name: "notes.pdf", path: "attachments/2026-10-09/notes.pdf", mediaType: "application/pdf" }] },
      { role: "assistant", text: "Three ideas: the characteristic polynomial, eigenspaces and diagonalisation.", attachments: [] },
    ],
  },
  {
    id: older,
    updated: now - 2 * DAY,
    messages: [
      { role: "user", text: "Which history readings are optional?", attachments: [] },
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
const TITLE = "Summarise my M301 notes on eigenvalues";

const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const shellSaid = (page, text, timeout = 4000) =>
  page.waitForFunction((t) => document.querySelector("[data-shell-status]")?.textContent === t, { timeout }, text).then(() => true, () => false);
const shellStatus = (page) => page.evaluate(() => document.querySelector("[data-shell-status]")?.textContent ?? "");
const paneSaid = (page, text, timeout = 4000) =>
  page.waitForFunction((t) => document.querySelector('[data-testid="conversation-status"]')?.textContent === t, { timeout }, text).then(() => true, () => false);
const openMenu = async (page) => {
  await page.click("[data-conversations-trigger]");
  await page.waitForSelector('[data-conversations-menu] [role="menuitemradio"]', { timeout: 5000 });
};
const menuGone = (page) => page.waitForFunction(() => !document.querySelector("[data-conversations-menu]"), { timeout: 3000 });
const focused = (page, attr, id) =>
  page.waitForFunction((attr, id) => document.activeElement?.getAttribute(attr) === id, { timeout: 3000 }, attr, id).then(() => true, () => false);
const activeDesc = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return a ? `${a.tagName} ${[...a.attributes].map((x) => `${x.name}=${x.value}`).join(" ")}`.slice(0, 200) : "none";
  });
const askDelete = async (page, id) => {
  await page.click(`[data-delete-thread="${id}"]`);
  await page.waitForSelector(`[data-delete-confirm="${id}"]`, { timeout: 3000 });
};
const describedBy = (page, sel) =>
  page.$eval(sel, (el) => (el.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ").replace(/\s+/g, " "));

/** The three choices: each inside the window, and each at least a target from the next. */
const choicesFit = (page, id) =>
  page.evaluate((id) => {
    const els = ["data-delete-cancel", "data-clear-button", "data-delete-confirm-button"].map((a) => document.querySelector(`[${a}="${id}"]`));
    els.forEach((e) => e.scrollIntoView({ block: "nearest" }));
    const r = els.map((e) => e.getBoundingClientRect());
    const gap = (a, b) => Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom);
    const min = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ph-target-min")) || 24;
    const menu = document.querySelector("[data-conversations-menu]").getBoundingClientRect();
    return {
      gap: Math.min(gap(r[0], r[1]), gap(r[0], r[2]), gap(r[1], r[2])),
      min,
      inside: r.every((b) => b.left >= menu.left - 0.5 && b.right <= menu.right + 0.5 && b.right <= innerWidth),
      targets: r.every((b) => b.height >= min && b.width >= min),
      scroll: document.documentElement.scrollWidth <= innerWidth,
    };
  }, id);

export default [
  {
    name: "f3-clear",
    sizes: [[1100, 720]],
    mock: conversations({ slow: { thread_clear: 700 } }),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await openMenu(page);
      await askDelete(page, yesterday);
      check(await focused(page, "data-delete-cancel", yesterday), "the confirm opens on Cancel", await activeDesc(page));
      const q = await page.$eval(`[data-delete-confirm="${yesterday}"] p`, (p) => p.textContent);
      check(q === `Clear or delete “${TITLE}”?`, "the confirm asks clear or delete, naming the conversation", q);
      const clearSays = await describedBy(page, `[data-clear-button="${yesterday}"]`);
      check(/keeps a few key details/.test(clearSays) && /School’s memory/.test(clearSays) && /sent once more/.test(clearSays), "Clear is described by what it keeps, where, and that it is sent again", clearSays);
      const label = await page.$eval(`[data-clear-button="${yesterday}"]`, (b) => b.textContent);
      check(label === "Clear", "the safe choice says Clear", label);
      await h.idle();
      await h.shot("confirm");
      // Clear: while the details are picked out the confirm stays (Escape doesn't drop it), then the menu closes.
      await page.keyboard.press("ArrowDown");
      check(await focused(page, "data-clear-button", yesterday), "ArrowDown from Cancel reaches Clear first", await activeDesc(page));
      await page.keyboard.press("Enter");
      await page.waitForFunction((id) => document.querySelector(`[data-clear-button="${id}"]`)?.textContent === "Keeping details…", { timeout: 2000 }, yesterday);
      check(await shellSaid(page, "Picking out what to keep…"), "the wait is announced", await shellStatus(page));
      await h.shot("clearing");
      await page.keyboard.press("Escape");
      check(!!(await page.$(`[data-delete-confirm="${yesterday}"]`)), "Escape while picking out details keeps the confirm (its outcome shows there)");
      await menuGone(page);
      const cleared = await calls(page, "thread_clear");
      check(JSON.stringify(cleared) === JSON.stringify([{ space: "school", id: yesterday }]), "thread_clear gets the space and that conversation", JSON.stringify(cleared));
      check((await calls(page, "thread_forget")).length === 0 && (await calls(page, "thread_delete")).length === 0, "nothing else is called");
      check(await shellSaid(page, `Cleared “${TITLE}”. Kept 2 details in School’s memory.`), "the clear and how much was kept are announced", await shellStatus(page));
      check(await page.evaluate(() => document.activeElement?.matches("[data-conversations-trigger]")), "focus is back on Conversations, beside the note", await activeDesc(page));
      check(await page.evaluate(() => document.body.innerText.includes("Problem set 4")), "the open conversation is untouched");
      // The note shows what was kept, and opens the memory file.
      const note = await page.$eval("[data-kept-note]", (n) => n.innerText.replace(/\s+/g, " "));
      check(note.includes(`Cleared “${TITLE}”. Kept 2 details in School’s memory.`), "the note says what happened", note);
      check(!(await page.$("[data-kept-note][role]")), "the note isn't a second live region (it was announced once)");
      check((await page.$eval("[data-kept-show]", (b) => b.getAttribute("aria-expanded"))) === "false", "Show what was kept starts collapsed");
      await h.click("[data-kept-show]");
      const list = await page.$$eval("[data-kept-list] li", (li) => li.map((l) => l.textContent));
      check(list.join("|") === "Test 1 for C241 is on Thursday.|Problem set 4 is due Wednesday.", "the kept details are listed", list.join("|"));
      check((await page.$eval("[data-kept-show]", (b) => b.getAttribute("aria-expanded"))) === "true", "and the button says it is expanded");
      await h.click("[data-kept-open]");
      const opened = await calls(page, "file_open");
      check(opened.at(-1)?.path === "MEMORY.md" && opened.at(-1)?.space === "school", "Open MEMORY.md opens the space's memory file", JSON.stringify(opened));
      await park(page);
      await h.shot("kept");
      // The conversation is gone from the list.
      await openMenu(page);
      const left = await page.$$eval('[data-conversations-menu] [role="menuitemradio"]', (els) => els.map((e) => e.dataset.threadId));
      check(left.join() === `current,${older}`, "the cleared conversation has left the list", left.join());
      await page.keyboard.press("Escape");
      await menuGone(page);
      await h.click("[data-kept-dismiss]");
      check(!(await page.$("[data-kept-note]")), "Dismiss puts the note away");
    },
  },
  {
    name: "f3-clear-current",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: conversations({ keep: ["Test 1 for C241 is on Thursday."] }),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await openMenu(page);
      await askDelete(page, "current");
      const q = await page.$eval('[data-delete-confirm="current"] p', (p) => p.textContent);
      check(q.endsWith("A new conversation starts in its place."), "clearing the open one says a new one starts", q);
      await h.click('[data-clear-button="current"]');
      await h.waitText("Start a conversation in School");
      await page.waitForFunction(() => document.activeElement?.matches("[data-composer-input]"), { timeout: 3000 });
      check(await paneSaid(page, "Cleared “What do I have due this week for C241?”. Kept 1 detail in School’s memory. A new conversation has started."), "the clear and the new start are said once", "");
      check((await calls(page, "thread_clear")).at(-1)?.id === "current", "the open one is cleared as \"current\"");
      check(!!(await page.$("[data-kept-note]")), "the note under the bar shows what was kept");
      await park(page);
      await h.shot("after");
    },
  },
  {
    name: "f3-clear-fails",
    sizes: [[1100, 720]],
    mock: conversations({ clearFails: "Phaethon couldn’t reach Anthropic. Check your internet connection, then try again." }),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await openMenu(page);
      await askDelete(page, yesterday);
      // By keyboard: a pointer moving out of the menu sends focus to the menu itself (Radix).
      await park(page);
      await page.focus(`[data-clear-button="${yesterday}"]`);
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-clear-failed]", { timeout: 3000 });
      const alert = await page.$eval("[data-clear-failed]", (a) => a.textContent.replace(/\s+/g, " "));
      check(/nothing was cleared/.test(alert) && /internet connection/.test(alert), "it says plainly that nothing was cleared, and why", alert);
      check(await shellSaid(page, "Nothing was cleared: Phaethon couldn’t pick out what to keep. Phaethon couldn’t reach Anthropic. Check your internet connection, then try again."), "and it is announced", await shellStatus(page));
      check(/nothing was cleared/.test(await describedBy(page, `[data-clear-plain="${yesterday}"]`)), "the next step is described by why");
      check(await focused(page, "data-delete-cancel", yesterday), "focus goes to Cancel, the safe choice", await activeDesc(page));
      check(!(await page.$(`[data-clear-button="${yesterday}"]`)) && !!(await page.$(`[data-clear-plain="${yesterday}"]`)), "the next step is Clear without keeping anything");
      check((await calls(page, "thread_delete")).length === 0 && (await calls(page, "thread_forget")).length === 0, "nothing was removed");
      const q = await page.$eval(`[data-delete-confirm="${yesterday}"] p`, (p) => p.textContent);
      check(q === `Clear “${TITLE}” without keeping anything?`, "the question changes to match", q);
      await h.idle();
      await h.shot("failed");
      // Cancel leaves everything as it was; asking again starts from the two choices.
      await page.keyboard.press("Enter");
      check(await focused(page, "data-delete-thread", yesterday), "Cancel goes back to Delete", await activeDesc(page));
      await page.keyboard.press("Enter");
      await page.waitForSelector(`[data-clear-button="${yesterday}"]`, { timeout: 3000 });
      check(!(await page.$("[data-clear-failed]")), "a new confirm asks afresh");
      // Then clear without keeping anything.
      await h.click(`[data-clear-button="${yesterday}"]`);
      await page.waitForSelector(`[data-clear-plain="${yesterday}"]`, { timeout: 3000 });
      await h.click(`[data-clear-plain="${yesterday}"]`);
      await page.waitForFunction((id) => !document.querySelector(`[data-thread-id="${id}"]`), { timeout: 3000 }, yesterday);
      const del = await calls(page, "thread_delete");
      check(JSON.stringify(del) === JSON.stringify([{ space: "school", id: yesterday }]), "it removes only the messages (thread_delete)", JSON.stringify(del));
      check(await shellSaid(page, `Cleared “${TITLE}” without keeping anything.`), "and says so", await shellStatus(page));
      check(await focused(page, "data-thread-id", older), "focus moves to the conversation that took its place", await activeDesc(page));
      check(!(await page.$("[data-kept-note]")), "no kept note");
    },
  },
  {
    name: "f3-forget",
    sizes: [[1100, 720]],
    mock: conversations({ preview: { files: 2, sharedFiles: 1, facts: 3 }, forgotten: { files: 2, filesLeft: 0, facts: 3 } }),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await openMenu(page);
      await askDelete(page, yesterday);
      await page.waitForFunction(() => /2 files attached only here/.test(document.querySelector("[data-forget-says]")?.textContent ?? ""), { timeout: 3000 });
      const says = await describedBy(page, `[data-delete-confirm-button="${yesterday}"]`);
      check(
        says === "Delete everything removes the messages, the 2 files attached only here and the 3 details kept from it. Nothing is kept, and it can’t be undone. 1 file another conversation also uses stays.",
        "Delete everything is described by exactly what goes and what stays",
        says,
      );
      const look = await page.$eval(`[data-delete-confirm-button="${yesterday}"]`, (b) => ({ text: b.textContent, icon: !!b.querySelector("svg"), bg: getComputedStyle(b).backgroundColor }));
      check(look.text === "Delete everything" && look.icon, "it reads Delete everything, with an icon", JSON.stringify(look));
      check((await calls(page, "thread_forget_preview")).some((a) => a.id === yesterday), "what it takes comes from the core");
      await h.idle();
      await h.shot("confirm");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      check(await focused(page, "data-delete-confirm-button", yesterday), "Delete everything is the far choice (two steps from Cancel)", await activeDesc(page));
      await page.keyboard.press("Enter");
      await page.waitForFunction((id) => !document.querySelector(`[data-thread-id="${id}"]`), { timeout: 3000 }, yesterday);
      check(JSON.stringify(await calls(page, "thread_forget")) === JSON.stringify([{ space: "school", id: yesterday }]), "thread_forget gets that conversation");
      check(await shellSaid(page, `Deleted “${TITLE}” with its 2 files and its 3 kept details.`), "the delete and what went with it are announced", await shellStatus(page));
      check(!!(await page.$("[data-conversations-menu]")), "the menu stays open");
      check(await focused(page, "data-thread-id", older), "focus moves to the conversation that took its place", await activeDesc(page));
      // A file that couldn't be removed is said.
      await page.evaluate(() => (window.__MOCK__.forgotten = { files: 0, filesLeft: 1, facts: 0 }));
      await askDelete(page, older);
      await h.click(`[data-delete-confirm-button="${older}"]`);
      await page.waitForSelector("[data-conversations-problem]", { timeout: 3000 });
      const problem = await page.$eval("[data-conversations-problem]", (p) => p.textContent);
      check(/1 file attached to it couldn’t be removed/.test(problem), "a file left behind is reported", problem);
    },
  },
  {
    name: "f3-narrow",
    sizes: [[640, 480]],
    sizesRequired: true,
    mock: conversations({ preview: { files: 2, sharedFiles: 1, facts: 3 } }),
    async run(page, h) {
      await h.waitText("Problem set 4");
      await openMenu(page);
      await askDelete(page, yesterday);
      await h.idle();
      const fit = await choicesFit(page, yesterday);
      check(fit.inside && fit.scroll, "the three choices fit the menu and the window, no sideways scroll", JSON.stringify(fit));
      check(fit.gap >= fit.min && fit.targets, "each is a full target and at least a target from the next", JSON.stringify(fit));
      await h.shot("confirm");
    },
  },
  {
    name: "f3-forced",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: conversations(),
    async run(page, h) {
      const cdp = await page.createCDPSession();
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "forced-colors", value: "active" }] });
      await h.waitText("Problem set 4");
      await openMenu(page);
      await askDelete(page, yesterday);
      await h.idle();
      const r = await page.evaluate((id) => {
        const w = (a) => parseFloat(getComputedStyle(document.querySelector(`[${a}="${id}"]`)).borderTopWidth);
        const g = getComputedStyle(document.querySelector(`[data-delete-confirm="${id}"]`));
        return { frame: g.borderTopStyle !== "none" && parseFloat(g.borderTopWidth) > 0, cancel: w("data-delete-cancel"), clear: w("data-clear-button"), del: w("data-delete-confirm-button") };
      }, yesterday);
      check(r.frame && r.clear > r.cancel && r.del > r.cancel, "the confirm keeps its frame; Clear and Delete everything have heavier borders than Cancel", JSON.stringify(r));
      // Closed before the final shot: --axe would read author colours under emulated forced colours (as s3-conv-forced).
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await menuGone(page);
    },
  },
  {
    name: "f3-times",
    sizes: [[1100, 720]],
    mock: {
      threads: {
        school: [
          { role: "user", text: "Saved before times were kept.", attachments: [] },
          { role: "assistant", text: "So no time shows here.", attachments: [] },
          { role: "user", text: "When is Test 1?", attachments: [], at: new Date(new Date(now - DAY).setHours(14, 41, 0, 0)).getTime() },
          { role: "assistant", text: "Thursday.", attachments: [], at: new Date(new Date(now - DAY).setHours(14, 42, 0, 0)).getTime() },
        ],
      },
    },
    async run(page, h) {
      await h.waitText("Thursday.");
      const times = await page.$$eval('[role="article"]', (arts) =>
        arts.map((a) => {
          const t = a.querySelector("time");
          if (!t) return null;
          const shown = t.querySelector('[aria-hidden="true"]')?.textContent;
          const spoken = t.querySelector(".sr-only")?.textContent;
          // After the message's own text in reading order: nothing of the text follows the time.
          const text = [...a.querySelectorAll("p, span")].filter((n) => !t.contains(n) && n.textContent.trim() && !n.closest("button"));
          const afterText = text.length > 0 && text.every((n) => !(t.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING));
          return { shown, spoken, title: t.title, iso: t.dateTime, afterText };
        }),
      );
      check(times[0] === null && times[1] === null, "old saved messages show no time (not a made-up one)", JSON.stringify(times));
      check(/^Yesterday \d{1,2}:41/.test(times[2]?.shown ?? "") && /^Yesterday \d{1,2}:42/.test(times[3]?.shown ?? ""), "older times say Yesterday and the time", JSON.stringify(times));
      check(/^Sent \w+day, /.test(times[2]?.spoken ?? "") && /^Finished /.test(times[3]?.spoken ?? ""), "screen readers hear the full date, saying sent or finished", JSON.stringify(times));
      check(times[2]?.title === times[2]?.spoken.replace(/^Sent /, "") && !Number.isNaN(Date.parse(times[2]?.iso)), "the full date is the tooltip and a machine-readable datetime", JSON.stringify(times[2]));
      check(times.slice(2).every((t) => t.afterText), "the time comes after the message's text, never before it", JSON.stringify(times));
      // A new message and its reply get the time they were sent and finished.
      await h.send("And Test 2?");
      await h.waitText("Done.");
      await page.waitForFunction(() => document.querySelectorAll('[role="article"] time').length === 4, { timeout: 4000 });
      const fresh = await page.$$eval('[role="article"] time', (ts) => ts.slice(-2).map((t) => t.querySelector('[aria-hidden="true"]').textContent));
      check(fresh.every((t) => /^\d{1,2}:\d{2}/.test(t)), "today's messages show only the time", fresh.join("|"));
      await park(page);
      await h.shot("times");
    },
  },
];
