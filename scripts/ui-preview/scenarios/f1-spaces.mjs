// Space actions and most-recently-used order, all behaviour checks: check(...) fails the run.
//   f1-menu-pointer    right-click a space: its menu (Show in Finder, Export…, Edit name and colour…); Show in Finder sends only the id
//   f1-menu-keys       Shift+F10 and the context-menu key open it on the focused space, first item focused; Escape returns;
//                      ArrowRight reaches the More button, Enter opens it, ArrowLeft goes back
//   f1-menu-platforms(-linux)  the item says File Explorer on Windows and Files on Linux
//   f1-export-done     Export…: the notice names the file, takes focus with the message as its description, shows it; Escape returns
//   f1-export-fail     a failed export says why in plain words, Try again asks again; a cancelled save dialog shows nothing
//   f1-palette         the palette has Show space in Finder and Export space… for the space on screen
//   f1-mru-order       spaces are listed most recently used first; opening one moves it up and tells the core; Cmd+1…9 follow it
//   f1-mru-hold        the order holds while the pointer is over the sidebar or keyboard focus is in it, and catches up after
import { check, park } from "../audit-fixtures.mjs";

const chord = async (page, key) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
};
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const space = (id) => `#spaces-sidebar [data-space-id="${id}"]`;
const MENU = "[data-space-menu]";
const showSidebar = async (page) => {
  if (await page.evaluate(() => document.getElementById("spaces-sidebar")?.hidden)) {
    await page.click('button[aria-controls="spaces-sidebar"]');
    await page.waitForSelector("#spaces-sidebar:not([hidden])", { timeout: 5000 });
  }
};
/** The sidebar's spaces in order, the current one starred: "work*,school,art". */
const order = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("#spaces-sidebar [data-space-id]")].map((b) => b.dataset.spaceId + (b.getAttribute("aria-current") ? "*" : "")).join(),
  );
const waitOrder = (page, want, timeout = 3000) =>
  page
    .waitForFunction(
      (want) => [...document.querySelectorAll("#spaces-sidebar [data-space-id]")].map((b) => b.dataset.spaceId + (b.getAttribute("aria-current") ? "*" : "")).join() === want,
      { timeout },
      want,
    )
    .then(() => true, () => false);
const focused = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (a?.dataset.spaceId) return `space:${a.dataset.spaceId}`;
    if (a?.dataset.spaceMore) return `more:${a.dataset.spaceMore}`;
    if (a?.getAttribute("role") === "menuitem") return `item:${a.textContent.trim()}`;
    if (a?.closest("[data-space-action-notice]")) return `notice:${a.textContent.trim()}`;
    return a?.tagName + (a?.hasAttribute("data-composer-input") ? "[composer]" : "");
  });
const menuItems = (page) => page.$$eval(`${MENU} [role="menuitem"]`, (els) => els.map((e) => e.textContent.trim()));
const menuGone = (page) => page.waitForFunction((m) => !document.querySelector(m), { timeout: 3000 }, MENU);
const openMenuOn = async (page, id) => {
  await page.click(space(id), { button: "right" });
  await page.waitForSelector(`${MENU}[data-space-menu="${id}"] [role="menuitem"]`, { timeout: 3000 });
};
const choose = async (page, action) => {
  await page.click(`${MENU} [data-space-action="${action}"]`);
  await menuGone(page);
};
const notice = (page) =>
  page.evaluate(() => {
    const n = document.querySelector("[data-space-action-notice]");
    if (!n) return null;
    const a = document.activeElement;
    const described = a?.getAttribute("aria-describedby");
    return {
      kind: n.getAttribute("data-space-action-notice"),
      label: n.getAttribute("aria-label"),
      text: n.querySelector("p")?.textContent ?? "",
      focus: n.contains(a) ? a.textContent.trim() : null,
      description: described ? document.getElementById(described)?.textContent : null,
    };
  });
const waitNotice = (page) => page.waitForSelector("[data-space-action-notice]", { timeout: 3000 });
const used = (school, work, art) => [
  { id: "school", name: "School", description: "Courses, deadlines, study notes", hue: 240, lastUsed: school },
  { id: "work", name: "Work", description: "Projects, meetings, follow-ups", hue: 50, lastUsed: work },
  { id: "art", name: "Art", description: "", hue: 320, lastUsed: art },
];

export default [
  {
    name: "f1-menu-pointer",
    sizes: [[1100, 720]],
    mock: {},
    async run(page, h) {
      await showSidebar(page);
      await openMenuOn(page, "work");
      await h.idle();
      const m = await page.$eval(MENU, (el) => ({ role: el.getAttribute("role"), label: el.getAttribute("aria-label") }));
      check(m.role === "menu" && m.label === "Work: actions", "right-click on Work opens its menu, named for Work", JSON.stringify(m));
      const items = await menuItems(page);
      check(items.join("|") === "Show in Finder|Export…|Import courses…|Edit name and colour…", "the menu has Show in Finder, Export…, Import courses… and Edit name and colour…", items.join("|"));
      const more = await page.$eval('[data-space-more="work"]', (b) => ({ expanded: b.getAttribute("aria-expanded"), shown: getComputedStyle(b).opacity }));
      check(more.expanded === "true" && more.shown === "1", "Work’s More button shows, marked expanded, while its menu is open", JSON.stringify(more));
      await h.shot("open");
      await choose(page, "show");
      await h.idle();
      const sent = await calls(page, "space_show");
      check(JSON.stringify(sent) === JSON.stringify([{ id: "work" }]), "Show in Finder sends only the space’s id", JSON.stringify(sent));
      check((await focused(page)) === "space:work", "focus is back on Work", await focused(page));
      // Edit name and colour… opens Settings at Spaces.
      await openMenuOn(page, "school");
      await choose(page, "edit");
      await page.waitForSelector('[data-testid="settings-tab-spaces"][data-state="active"]', { timeout: 5000 });
      check(true, "Edit name and colour… opens Settings at Spaces");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
      check((await focused(page)) === "space:school", "closing Settings puts focus back on School", await focused(page));
      // The More button opens the same menu with a click.
      await page.hover(space("work"));
      await page.click('[data-space-more="work"]');
      await page.waitForSelector(`${MENU}[data-space-menu="work"]`, { timeout: 3000 });
      check((await menuItems(page)).length === 4, "Work’s More button opens the same menu");
      await page.keyboard.press("Escape");
      await menuGone(page);
    },
  },
  {
    name: "f1-menu-keys",
    sizes: [[1100, 720]],
    mock: {},
    async run(page, h) {
      await showSidebar(page);
      await page.focus(space("school"));
      await page.keyboard.down("Shift");
      await page.keyboard.press("F10");
      await page.keyboard.up("Shift");
      await page.waitForSelector(`${MENU}[data-space-menu="school"]`, { timeout: 3000 });
      await h.idle();
      check((await focused(page)) === "item:Show in Finder", "Shift+F10 opens School’s menu with its first item focused", await focused(page));
      await page.keyboard.press("ArrowDown");
      check((await focused(page)) === "item:Export…", "ArrowDown moves to Export…", await focused(page));
      await h.shot("keys");
      await page.keyboard.press("Escape");
      await menuGone(page);
      check((await focused(page)) === "space:school", "Escape closes it and focus is back on School", await focused(page));
      const keyshortcut = await page.$eval(space("school"), (b) => b.getAttribute("aria-keyshortcuts"));
      check(keyshortcut === "Shift+F10", "the space says its menu key", keyshortcut);
      await page.keyboard.press("ContextMenu");
      await page.waitForSelector(`${MENU}[data-space-menu="school"]`, { timeout: 3000 });
      await h.idle();
      check((await focused(page)) === "item:Show in Finder", "the context-menu key opens it too", await focused(page));
      await page.keyboard.press("Escape");
      await menuGone(page);
      // ArrowRight to More, Enter opens, Escape back to the space; ArrowLeft from More goes back.
      await page.keyboard.press("ArrowRight");
      check((await focused(page)) === "more:school", "ArrowRight goes to School’s More button", await focused(page));
      const more = await page.$eval('[data-space-more="school"]', (b) => ({ name: b.getAttribute("aria-label"), popup: b.getAttribute("aria-haspopup"), tab: b.tabIndex }));
      check(more.name === "More for School" && more.popup === "menu" && more.tab === -1, "More is named for its space, says it opens a menu and is not a Tab stop", JSON.stringify(more));
      await page.keyboard.press("Enter");
      await page.waitForSelector(`${MENU}[data-space-menu="school"]`, { timeout: 3000 });
      await h.idle();
      check((await focused(page)) === "item:Show in Finder", "Enter on More opens the menu with its first item focused", await focused(page));
      await page.keyboard.press("Escape");
      await menuGone(page);
      check((await focused(page)) === "space:school", "and Escape returns to the space", await focused(page));
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowLeft");
      check((await focused(page)) === "space:school", "ArrowLeft from More goes back to the space", await focused(page));
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowDown");
      check((await focused(page)) === "space:work", "ArrowDown from More goes to the next space", await focused(page));
      // Tab still steps space by space (More is skipped).
      await page.focus(space("school"));
      await page.keyboard.press("Tab");
      check((await focused(page)) === "space:work", "Tab goes from School straight to Work", await focused(page));
    },
  },
  {
    name: "f1-menu-platforms",
    sizes: [[1100, 720]],
    mock: { platform: "windows" },
    async run(page) {
      await showSidebar(page);
      await openMenuOn(page, "school");
      const items = await menuItems(page);
      check(items[0] === "Show in File Explorer", "on Windows the item is Show in File Explorer", items[0]);
      await page.keyboard.press("Escape");
      await menuGone(page);
    },
  },
  {
    name: "f1-menu-platforms-linux",
    sizes: [[1100, 720]],
    mock: { platform: "linux" },
    async run(page) {
      await showSidebar(page);
      await openMenuOn(page, "school");
      const items = await menuItems(page);
      check(items[0] === "Show in Files", "on Linux the item is Show in Files", items[0]);
      await page.keyboard.press("Escape");
      await menuGone(page);
    },
  },
  {
    name: "f1-export-done",
    mock: {},
    async run(page, h) {
      await showSidebar(page);
      await openMenuOn(page, "school");
      await choose(page, "export");
      await waitNotice(page);
      await h.idle();
      const sent = await calls(page, "space_export");
      check(JSON.stringify(sent) === JSON.stringify([{ id: "school" }]), "Export… sends only the space’s id (the core asks where to save)", JSON.stringify(sent));
      const n = await notice(page);
      check(n.kind === "exported" && n.text === "Exported School as School 2026-10-10.zip.", "the notice names the file", JSON.stringify(n));
      check(n.focus === "Show in Finder" && n.description === n.text, "focus is on its Show in Finder, which is described by the message (so it is heard)", JSON.stringify(n));
      await h.shot("notice");
      await page.keyboard.press("Enter");
      await h.idle();
      check((await calls(page, "export_show")).length === 1, "Show in Finder asks the core to show the exported file (no path from here)");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("[data-space-action-notice]"), { timeout: 3000 });
      const f = await focused(page);
      check(f === "space:school", "Escape dismisses it and focus is back on School", f);
    },
  },
  {
    name: "f1-export-fail",
    sizes: [[1100, 720]],
    mock: { fail: { space_export: "There isn’t enough space on the disk." } },
    async run(page, h) {
      await showSidebar(page);
      await openMenuOn(page, "work");
      await choose(page, "export");
      await waitNotice(page);
      await h.idle();
      const n = await notice(page);
      check(n.kind === "error" && n.text === "Work couldn’t be exported. There isn’t enough space on the disk.", "a failure says what and why in plain words", JSON.stringify(n));
      check(n.focus === "Try again" && n.description === n.text, "focus is on Try again, described by the message", JSON.stringify(n));
      await h.shot("failed");
      await page.keyboard.press("Enter");
      await h.idle();
      check((await calls(page, "space_export")).length === 2, "Try again asks again");
      await page.click("[data-notice-dismiss]");
      await page.waitForFunction(() => !document.querySelector("[data-space-action-notice]"), { timeout: 3000 });
      // A cancelled save dialog: nothing shown, focus where it was.
      await page.evaluate(() => {
        delete window.__MOCK__.fail;
        window.__MOCK__.exportResult = null;
      });
      await openMenuOn(page, "work");
      await choose(page, "export");
      await h.idle();
      check(!(await page.$("[data-space-action-notice]")), "cancelling the save dialog shows nothing");
      check((await focused(page)) === "space:work", "and focus is back on Work", await focused(page));
    },
  },
  {
    name: "f1-palette",
    sizes: [[1100, 720]],
    mock: {},
    async run(page, h) {
      await h.idle();
      await chord(page, "k");
      await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
      await page.keyboard.type("export");
      await h.idle();
      const opt = await page.evaluate(() => {
        const o = document.getElementById(document.activeElement.getAttribute("aria-activedescendant"));
        return { id: o?.getAttribute("data-command"), text: o?.textContent };
      });
      check(opt.id === "space-export" && opt.text.includes("Export space…") && opt.text.includes("School"), "\"export\" finds Export space… for School", JSON.stringify(opt));
      await page.keyboard.press("Enter");
      await waitNotice(page);
      check(JSON.stringify(await calls(page, "space_export")) === JSON.stringify([{ id: "school" }]), "Enter exports the space on screen");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("[data-space-action-notice]"), { timeout: 3000 });
      await chord(page, "k");
      await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
      await page.keyboard.type("folder");
      await h.idle();
      const show = await page.evaluate(() => document.getElementById(document.activeElement.getAttribute("aria-activedescendant"))?.textContent);
      check(show?.startsWith("Show space in Finder"), "\"folder\" finds Show space in Finder", show);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.__calls.some(([c]) => c === "space_show"), { timeout: 3000 });
      check(JSON.stringify(await calls(page, "space_show")) === JSON.stringify([{ id: "school" }]), "Enter shows the space on screen in Finder");
    },
  },
  {
    name: "f1-mru-order",
    sizes: [[1100, 720]],
    mock: { spaces: used(1000, 2000, null) },
    async run(page, h) {
      await showSidebar(page);
      await park(page);
      await page.mouse.move(700, 400);
      check(await waitOrder(page, "work*,school,art"), "most recently used first (Work, then School), never used last; the first is shown", await order(page));
      const touched = await calls(page, "space_touch");
      check(touched.some((a) => a.id === "work"), "showing Work tells the core it was used (by id)", JSON.stringify(touched));
      // Cmd+3 opens the third shown (Art); it moves to the top, and Cmd+1 is now Art.
      await chord(page, "3");
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "Art", { timeout: 3000 });
      check(await waitOrder(page, "art*,work,school"), "Art, just opened, moves to the top", await order(page));
      check((await calls(page, "space_touch")).some((a) => a.id === "art"), "and the core is told");
      await h.shot("after");
      await chord(page, "3");
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "School", { timeout: 3000 });
      check(await waitOrder(page, "school*,art,work"), "Cmd+3 follows the order shown: School, which then comes first", await order(page));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await h.idle();
      check(await waitOrder(page, "school*,art,work"), "a reload from the core keeps the same order (the core has the same times)", await order(page));
    },
  },
  {
    name: "f1-mru-hold",
    sizes: [[1100, 720]],
    mock: { spaces: used(1000, 2000, null) },
    async run(page, h) {
      await showSidebar(page);
      await page.mouse.move(700, 400);
      check(await waitOrder(page, "work*,school,art"), "starts Work, School, Art", await order(page));
      // Pointer: click School; nothing moves while the pointer stays over the sidebar.
      const overlay = await page.$eval("#spaces-sidebar", (n) => n.hasAttribute("data-overlay"));
      await page.click(space("school"));
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "School", { timeout: 3000 });
      await h.idle();
      if (overlay) {
        // A narrow window: choosing closes the sidebar, so nothing is under the pointer and the order catches up.
        await showSidebar(page);
        check(await waitOrder(page, "school*,work,art"), "narrow: the sidebar closed on choosing, and reopens with School first", await order(page));
        return;
      }
      check((await order(page)) === "work,school*,art", "School is chosen but stays where it was while the pointer is over the sidebar", await order(page));
      // A shortcut follows the order shown: Cmd+3 is Art.
      await chord(page, "3");
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "Art", { timeout: 3000 });
      await h.idle();
      check((await order(page)) === "work,school,art*", "Cmd+3 is the third shown (Art), and still nothing moves", await order(page));
      await h.shot("held");
      await page.mouse.move(700, 400);
      check(await waitOrder(page, "art*,school,work"), "once the pointer leaves, the order catches up: Art, School, Work", await order(page));
      // Keyboard: focus in the sidebar holds the order too.
      await page.focus(space("art"));
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      check((await focused(page)) === "space:work", "arrows reach Work", await focused(page));
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "Work", { timeout: 3000 });
      await h.idle();
      check((await order(page)) === "art,school,work*", "chosen from the keyboard, Work stays put while focus is in the sidebar", await order(page));
      check((await focused(page)) === "space:work", "and focus stays on it", await focused(page));
      // The menu holds it as well, even with the pointer gone.
      await page.keyboard.press("ContextMenu");
      await page.waitForSelector(MENU, { timeout: 3000 });
      await page.keyboard.press("Escape");
      await menuGone(page);
      check((await order(page)) === "art,school,work*", "opening and closing Work’s menu moves nothing", await order(page));
      await page.focus('[data-space-pane="work"] [data-composer-input]');
      check(await waitOrder(page, "work*,art,school"), "focus leaving the sidebar lets the order catch up: Work first", await order(page));
    },
  },
];
