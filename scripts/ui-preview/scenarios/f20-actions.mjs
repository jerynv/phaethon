// Quick actions: buttons under a reply (a ```phaethon-actions block, chat-actions.tsx; the ids the
// assistant may use are in src-tauri/src/app_guide.rs), and adding files or a folder to a space
// (space_add, copied into its files/ folder). Each scenario throws when the behaviour is wrong.
//   f20-buttons        a reply that says how to bring in a folder ends with buttons, not code: the app's
//                      words, unknown ids left out, at most three, in a named group
//   f20-add-folder     Add a folder… by keyboard: sends only the space and folder, says what was added
//                      (politely), focus stays, then Show in Finder
//   f20-add-refused    a refused add (too many files): an alert in words, nothing said as added
//   f20-add-cancelled  the picker cancelled: nothing said at all
//   f20-open-settings  Settings: Spaces under a reply opens Settings on Spaces
//   f20-attach         Attach files… under a reply opens this space's file picker
//   f20-streaming      while the reply is still coming, no buttons yet
//   f20-plus-menu      the + menu adds files or a folder to the space; the notice says what and offers Show in Finder
//   f20-space-menu     a space's menu has Add files… and Add a folder…, which add to that space
import { SETTINGS, check, park } from "../audit-fixtures.mjs";

const SHOWN = "[data-space-pane][data-shown]";
const CARD = `${SHOWN} [data-chat-actions]`;
const QUESTION = "I want to import my Documents/Scool/2026 folder into this space";
const PROSE = "Use **Add a folder…** to copy that folder into this space; the original stays where it is. Include your current resume so we can start there.";
const fence = (ids) => `\n\n\`\`\`phaethon-actions\n${ids.join("\n")}\n\`\`\``;
const thread = (ids = ["add-folder", "add-files", "open-terminal", "add-folder", "settings-spaces", "show-folder"]) => [
  { role: "user", text: QUESTION, attachments: [] },
  { role: "assistant", text: PROSE + fence(ids), attachments: [] },
];
const mock = (extra = {}, ids) => ({ settings: SETTINGS, threads: { school: thread(ids) }, ...extra });

const waitFor = (page, fn, arg, timeout = 4000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const calls = (page, cmd) => page.evaluate((c) => window.__calls.filter(([n]) => n === c).map(([, a]) => a), cmd);
const focused = (page, sel) => page.evaluate((s) => !!document.activeElement?.matches(s), sel);
const added = (page) => page.evaluate(() => window.__MOCK__.added ?? []);

async function card(page) {
  await page.waitForSelector(CARD, { timeout: 6000 });
}

export default [
  {
    name: "f20-buttons",
    sizes: [[1100, 720], [640, 480]],
    mock: mock(),
    async run(page) {
      await card(page);
      const c = await page.$eval(CARD, (el) => {
        const group = el.querySelector('[role="group"]');
        const reply = el.closest('[data-role="assistant"]');
        return {
          group: group?.getAttribute("aria-label"),
          buttons: [...group.querySelectorAll("button")].map((b) => ({ id: b.getAttribute("data-chat-action"), text: b.textContent.trim(), icon: !!b.querySelector("svg") })),
          code: reply.querySelectorAll("pre, code").length,
          raw: reply.textContent.includes("add-folder") || reply.textContent.includes("open-terminal"),
        };
      });
      check(c.group === "Quick actions", "the buttons are a group named Quick actions", c.group);
      check(
        c.buttons.map((b) => b.text).join("|") === "Add a folder…|Add files…|Settings: Spaces",
        "the app's words, in the reply's order, unknown ids and repeats left out, at most three",
        JSON.stringify(c.buttons),
      );
      check(c.buttons.every((b) => b.icon), "each with its icon");
      check(c.code === 0 && !c.raw, "no code block and no ids shown", JSON.stringify(c));
      await park(page);
    },
  },
  {
    name: "f20-add-folder",
    mock: mock(),
    async run(page, h) {
      await card(page);
      await h.focusVia(`${CARD} [data-chat-action="add-folder"]`);
      await page.keyboard.press("Enter");
      check(await waitFor(page, (c) => !!document.querySelector(`${c} [data-chat-action-added]`), CARD), "says what was added");
      const sent = await calls(page, "space_add");
      check(JSON.stringify(sent) === JSON.stringify([{ id: "school", folder: true }]), "sends only the space and that it's a folder", JSON.stringify(sent));
      const said = await page.$eval(`${CARD} [role="status"]`, (e) => e.textContent.trim());
      check(said === "Added Scool to School: 34 files, in files/Scool. 2 hidden files or links were left out.", "in words, in a polite status", said);
      check(await focused(page, `${CARD} [data-chat-action="add-folder"]`), "focus stays on the button");
      const desc = await page.$eval(`${CARD} [data-chat-action="add-folder"]`, (b) => document.getElementById(b.getAttribute("aria-describedby"))?.textContent ?? "");
      check(desc.startsWith("Added Scool"), "which is described by what it did", desc);
      await page.click(`${CARD} [data-chat-action-show]`);
      check(JSON.stringify(await calls(page, "space_show")) === JSON.stringify([{ id: "school" }]), "Show in Finder shows the space's folder");
      await park(page);
    },
  },
  {
    name: "f20-add-refused",
    mock: mock({ fail: { space_add: "That’s more than 5000 files, so nothing was added. Add a smaller folder, or the folders inside it one at a time." } }),
    async run(page, h) {
      await card(page);
      await h.focusVia(`${CARD} [data-chat-action="add-folder"]`);
      await page.keyboard.press("Enter");
      check(await waitFor(page, (c) => !!document.querySelector(`${c} [data-chat-action-error][role="alert"]`), CARD), "the refusal is an alert");
      const text = await page.$eval(`${CARD} [data-chat-action-error]`, (e) => e.textContent);
      check(text.includes("Nothing was added") && text.includes("more than 5000 files"), "in words", text);
      check(!(await page.$(`${CARD} [data-chat-action-added]`)), "nothing said as added");
      check(await focused(page, `${CARD} [data-chat-action="add-folder"]`), "focus stays on the button");
      await park(page);
    },
  },
  {
    name: "f20-add-cancelled",
    mock: mock({ addResult: null }),
    async run(page) {
      await card(page);
      await page.click(`${CARD} [data-chat-action="add-files"]`);
      check(await waitFor(page, () => (window.__MOCK__.added ?? []).length === 1), "asked the core");
      await new Promise((r) => setTimeout(r, 300));
      const status = await page.$eval(`${CARD} [role="status"]`, (e) => e.textContent.trim());
      check(status === "" && !(await page.$(`${CARD} [data-chat-action-error]`)), "cancelling says nothing", status);
      const label = await page.$eval(`${CARD} [data-chat-action="add-files"]`, (b) => b.textContent.trim());
      check(label === "Add files…", "and the button is as it was", label);
    },
  },
  {
    name: "f20-open-settings",
    mock: mock(),
    async run(page) {
      await card(page);
      await page.click(`${CARD} [data-chat-action="settings-spaces"]`);
      await page.waitForSelector('[role="dialog"]', { timeout: 4000 });
      check(await waitFor(page, () => document.querySelector('[role="dialog"] [role="tab"][aria-selected="true"]')?.textContent.includes("Spaces")), "Settings opens on Spaces");
      await park(page);
    },
  },
  {
    name: "f20-attach",
    mock: mock({}, ["attach-files"]),
    async run(page) {
      await card(page);
      await page.evaluate(() => {
        window.__picked = [];
        HTMLInputElement.prototype.click = function () {
          if (this.type === "file") window.__picked.push(this.closest("[data-space-pane]")?.getAttribute("data-space-pane") ?? "?");
        };
      });
      await page.click(`${CARD} [data-chat-action="attach-files"]`);
      const picked = await page.evaluate(() => window.__picked);
      check(picked.length === 1, "this space's file picker opens, once", JSON.stringify(picked));
    },
  },
  {
    name: "f20-streaming",
    mock: { settings: SETTINGS, threads: {}, holdOpen: true, turn: [{ kind: "text", delta: PROSE + "\n\n```phaethon-actions\nadd-folder\n" }] },
    async run(page, h) {
      await h.send("how do I add a folder?");
      await h.waitText("Use Add a folder");
      await new Promise((r) => setTimeout(r, 300));
      check(!(await page.$(`${SHOWN} [data-chat-action]`)), "no buttons while the reply is still coming");
      const code = await page.evaluate((s) => [...document.querySelectorAll(`${s} [data-role="assistant"] pre`)].map((p) => p.textContent), SHOWN);
      check(code.length === 0, "and no code either", JSON.stringify(code));
    },
  },
  {
    name: "f20-plus-menu",
    mock: { settings: SETTINGS, threads: {} },
    async run(page) {
      await page.focus(`${SHOWN} [aria-label="Add to message"]`);
      await page.keyboard.press("Enter"); // by keyboard: the first item takes focus
      await page.waitForSelector('[data-add-to-space="folder"]', { timeout: 3000 });
      const items = await page.$$eval('[role="menu"] [role="menuitem"]', (els) => els.map((e) => e.querySelector(".font-medium")?.textContent.trim()));
      check(items.join("|") === "Attach files…|Add files to this space…|Add a folder to this space…", "the + menu attaches to the message or adds to the space", items.join("|"));
      check(await waitFor(page, () => document.activeElement?.textContent.includes("Attach files…")), "Attach files… first");
      await new Promise((r) => setTimeout(r, 300)); // as a person would: the menu has settled
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => !!document.querySelector('[data-space-action-notice="added"]')), "a notice says what was added");
      const n = await page.$eval('[data-space-action-notice="added"]', (e) => ({ text: e.textContent, label: e.getAttribute("aria-label") }));
      check(n.text.includes("Added Scool to School: 34 files, in files/Scool.") && n.label === "Files added", "in words", JSON.stringify(n));
      check(JSON.stringify(await added(page)) === JSON.stringify([{ id: "school", folder: true }]), "to this space, as a folder");
      check(await focused(page, "[data-space-action-notice] [data-notice-show]"), "focus on its Show in Finder");
      await new Promise((r) => setTimeout(r, 400));
      const tip = await page.evaluate(() => [...document.querySelectorAll('[role="tooltip"]')].map((t) => t.textContent));
      check(tip.length === 0, "and the + button's tooltip isn't left over it", JSON.stringify(tip));
      await park(page);
    },
  },
  {
    name: "f20-space-menu",
    mock: { settings: SETTINGS, threads: {} },
    async run(page) {
      await page.click('[data-space-more="work"]');
      await page.waitForSelector('[data-space-menu="work"] [data-space-action="add-files"]', { timeout: 3000 });
      await page.click('[data-space-menu="work"] [data-space-action="add-files"]');
      check(await waitFor(page, () => !!document.querySelector('[data-space-action-notice="added"]')), "a notice says what was added");
      check(JSON.stringify(await added(page)) === JSON.stringify([{ id: "work", folder: false }]), "to that space, as files");
      const text = await page.$eval('[data-space-action-notice="added"]', (e) => e.textContent);
      check(text.includes("Added Resume.pdf to Work: 1 file, in files/Resume.pdf."), "in words", text);
    },
  },
];
