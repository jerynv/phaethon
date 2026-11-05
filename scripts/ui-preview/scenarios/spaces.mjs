// Spaces from the vault: creating one from the sidebar (pointer and keyboard
// only), renaming, describing and recolouring in Settings > Spaces, a folder
// added outside Phaethon appearing, a space that disappears, and a vault with
// none. Behaviour checks: each fails unless the right command is sent and the
// sidebar, title bar and focus follow.
//   spaces-rows  each space folded to one line (name never cut short, description, access summary) with
//                Edit / Done: aria-expanded, focus kept, unsaved text and a pending Undo survive folding
import { openSpaceDetails } from "../audit-fixtures.mjs";

const SETTINGS = { backend: "phaethon", hasAnthropicKey: true, model: "claude-opus-5-5", appearance: {}, vaultPath: "/Users/you/Phaethon/default", version: "0.1.0" };
const DIALOG = "[data-new-space-dialog]";
const PANEL = '[role="dialog"] [role="tabpanel"]:not([hidden])';

function check(ok, what, detail = "") {
  if (!ok) throw new Error(`${what}${detail ? `: ${detail}` : ""}`);
  console.log(`     ok: ${what}`);
}
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const title = (page) => page.evaluate(() => document.getElementById("space-title")?.textContent ?? "");
const sidebarNames = (page) => page.evaluate(() => [...document.querySelectorAll("#spaces-sidebar [data-space-id]")].map((b) => `${b.dataset.spaceId}:${b.querySelector("[data-space-name] > [aria-hidden]")?.textContent}${b.getAttribute("aria-current") ? "*" : ""}`));
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return a ? `${a.tagName.toLowerCase()}${a.dataset.spaceId ? `[${a.dataset.spaceId}]` : ""}${a.id === "main" ? "#main" : ""}${a.dataset.spaceField ? `{${a.dataset.spaceField}}` : ""}` : "";
});
const narrow = (page) => page.evaluate(() => document.getElementById("spaces-sidebar")?.hidden);
const showSidebar = async (page, h) => {
  if (await narrow(page)) {
    await h.click('button[aria-controls="spaces-sidebar"]');
    await page.waitForSelector("#spaces-sidebar:not([hidden])", { timeout: 5000 });
  }
};
/** Fits: nothing in the element sticks out sideways (no horizontal scroll, nothing cut off). */
const fitsWidth = (page, sel) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return "missing";
  if (el.scrollWidth > el.clientWidth + 1) return `scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`;
  const r = el.getBoundingClientRect();
  // Radix's hidden native radios (aria-hidden, there only for forms) are not drawn.
  const over = [...el.querySelectorAll("*:not(input[aria-hidden])")].filter((c) => {
    const b = c.getBoundingClientRect();
    return b.width > 0 && (b.right > r.right + 1 || b.left < r.left - 1);
  });
  return over.length ? over.slice(0, 3).map((c) => c.outerHTML.slice(0, 80)).join(" | ") : "";
}, sel);
const openSpacesSettings = async (page, h) => {
  await h.click('#spaces-sidebar:not([hidden]) [data-testid="open-settings"], header [data-testid="titlebar-settings"]');
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await h.click('[data-testid="settings-tab-spaces"]');
  await page.waitForSelector(`${PANEL} [data-space-row="school"]`, { timeout: 5000 });
  await h.idle();
};
const park = (page) => page.mouse.move(2, 400);
const settingsStatus = (page) => page.evaluate(() => document.querySelector('[role="dialog"] p[role="status"]')?.textContent ?? "");
/** Select a field's text and type over it. */
const retype = async (page, sel, text) => {
  await page.focus(sel);
  await page.evaluate((sel) => document.querySelector(sel).select(), sel);
  await page.keyboard.type(text);
};

export default [
  {
    name: "spaces-dialog",
    mock: {},
    async run(page, h) {
      await showSidebar(page, h);
      await h.click("[data-new-space]");
      await page.waitForSelector(DIALOG, { timeout: 5000 });
      await h.idle();
      check((await focused(page)) === "input", "the name field has focus when the dialog opens", await focused(page));
      const named = await page.evaluate((d) => {
        const el = document.querySelector(d);
        return { title: document.getElementById(el.getAttribute("aria-labelledby"))?.textContent, radios: el.querySelectorAll('[role="radio"]').length, checked: el.querySelector('[role="radio"][aria-checked="true"]')?.textContent };
      }, DIALOG);
      check(named.title === "New space" && named.radios === 8 && !!named.checked, "titled New space, eight colours, one chosen", JSON.stringify(named));
      check((await fitsWidth(page, DIALOG)) === "", "the dialog fits its width", await fitsWidth(page, DIALOG));
    },
  },
  {
    name: "spaces-create",
    mock: {},
    async run(page, h) {
      await showSidebar(page, h);
      await h.click("[data-new-space]");
      await page.waitForSelector(DIALOG);
      await h.click(`${DIALOG} [data-next-space]`);
      check((await calls(page, "space_create")).length === 0, "a missing name never reaches the backend");
      check(await page.$eval(`${DIALOG} input[required]`, (input) => input.getAttribute("aria-invalid") === "true" && document.activeElement === input), "name validation focuses the field");
      await page.keyboard.type("Garden");
      await page.type(`${DIALOG} input:not([required])`, "Plants and seeds");
      await page.evaluate((d) => [...document.querySelectorAll(`${d} [role="radio"]`)].find((r) => r.textContent === "Moss")?.click(), DIALOG);
      await h.click(`${DIALOG} [data-next-space]`);
      check((await calls(page, "space_create")).length === 0, "Continue only advances to Workspace");
      check(await page.$eval('[data-new-space-education]', (control) => control.getAttribute("aria-checked") === "false"), "Education is opt-in");
      await h.click(`${DIALOG} [data-create-space]`);
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "Garden");
      const sent = await calls(page, "space_create");
      check(JSON.stringify(sent) === JSON.stringify([{ name: "Garden", description: "Plants and seeds", hue: 130, educationEnabled: false }]), "the complete workspace choice reaches space_create", JSON.stringify(sent));
      check((await calls(page, "full_access_set"))[0]?.id === "garden" && (await calls(page, "full_access_set"))[0]?.on === true, "new spaces save the default full access selection");
      await page.waitForFunction((d) => !document.querySelector(d), { timeout: 3000 }, DIALOG);
      check(!(await page.$(DIALOG)), "successful creation closes the dialog");
      check(await page.$eval('[data-space-pane][data-shown]', (pane) => pane.dataset.spacePane === "garden"), "the created space opens");

    },
  },
  {
    // Keyboard only: Tab to New space, fill the form, choose a colour with the arrows, create.
    name: "spaces-keyboard",
    mock: {},
    async run(page, h) {
      await showSidebar(page, h);
      await page.focus("[data-new-space]");
      await page.keyboard.press("Enter");
      await page.waitForSelector(DIALOG);
      await page.keyboard.type("Side Project");
      await page.keyboard.press("Tab");
      await page.keyboard.type("Weekend things");
      await page.keyboard.press("Tab");
      check(await page.evaluate(() => document.activeElement?.getAttribute("role") === "radio"), "Tab reaches the colour choices");
      await page.keyboard.press("ArrowRight");
      await h.focusVia(`${DIALOG} [data-next-space]`, 5);
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-new-space-workspace]:not([hidden])');
      await page.select('[data-new-space-access]', "workspace");
      await page.focus('[data-new-space-education]');
      await page.keyboard.press("Space");
      await h.focusVia(`${DIALOG} [data-create-space]`, 5);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "Side Project");
      const sent = await calls(page, "space_create");
      check(sent.length === 1 && sent[0].educationEnabled === true, "keyboard creation saves the Education choice", JSON.stringify(sent));
      check((await calls(page, "full_access_set"))[0]?.on === false, "Workspace only saves the selected restriction");
      await showSidebar(page, h);
      await page.focus("[data-new-space]");
      await page.keyboard.press("Enter");
      await page.waitForSelector(DIALOG);
      check(await page.$eval(`${DIALOG} input[required]`, (input) => input.value === ""), "a second setup starts empty");
      await page.keyboard.press("Escape");
      await page.waitForFunction((d) => !document.querySelector(d), {}, DIALOG);
      check((await calls(page, "space_create")).length === 1, "Escape never creates another space");

    },
  },
  {
    name: "spaces-rename",
    mock: { settings: SETTINGS },
    async run(page, h) {
      await openSpacesSettings(page, h);
      await openSpaceDetails(page, ["school"]);
      const school = `${PANEL} [data-space-row="school"]`;
      await retype(page, `${school} [data-space-field="name"]`, "Uni");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      check((await calls(page, "space_update")).length === 0, "Enter and blur do not silently save draft text");
      await h.click(`${school} [data-space-save]`);
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "Uni");
      check((await calls(page, "space_update"))[0].name === "Uni", "Save changes persists the renamed space");
      await h.click(`${PANEL} [data-spaces-back]`);
      await openSpaceDetails(page, ["work"]);
      const work = `${PANEL} [data-space-row="work"]`;
      await retype(page, `${work} [data-space-field="name"]`, "Oops");
      await page.keyboard.press("Escape");
      check(await page.$eval(`${work} [data-space-field="name"]`, (input) => input.value === "Work"), "Escape cancels the draft and keeps Settings open");
      await retype(page, `${work} [data-space-field="name"]`, " ");
      await h.click(`${work} [data-space-save]`);
      check(await page.$eval(`${work} [data-space-field="name"]`, (input) => input.getAttribute("aria-invalid") === "true"), "Save rejects an empty name");
      await page.keyboard.press("Escape");
      await retype(page, `${work} [data-space-field="description"]`, "Clients and invoices");
      await page.evaluate((w) => [...document.querySelectorAll(`${w} [role="radio"]`)].find((radio) => radio.textContent === "Rose")?.click(), work);
      await h.click(`${work} [data-space-save]`);
      await page.waitForFunction(() => window.__calls.filter(([command]) => command === "space_update").length === 2);
      const last = (await calls(page, "space_update")).at(-1);
      check(last.description === "Clients and invoices" && last.hue === 10, "description and colour save together", JSON.stringify(last));
      await h.shot("saved");

    },
  },
  {
    name: "spaces-settings",
    mock: { settings: SETTINGS, spaces: [{ id: "school", name: "School", description: "Courses, deadlines, study notes", hue: 250 }, { id: "work", name: "Work", description: "Projects, meetings, follow-ups", hue: 50 }] },
    async run(page, h) {
      await openSpacesSettings(page, h);
      await openSpaceDetails(page);
      const checked = await page.evaluate((p) => [...document.querySelectorAll(`${p} [data-space-row]`)].map((r) => `${r.dataset.spaceRow}:${r.querySelector('[role="radio"][aria-checked="true"]')?.textContent}`), PANEL);
      check(checked.join() === "school:Current,work:Clay", "a preset hue is chosen; any other shows as Current", checked.join());
      check((await fitsWidth(page, PANEL)) === "", "Settings > Spaces fits its width", await fitsWidth(page, PANEL));
    },
  },
  {
    name: "spaces-rows",
    sizes: [[1280, 800], [800, 700]],
    mock: {
      settings: SETTINGS,
      grants: { school: [{ id: "g-cal", from: "work", path: "calendar", created: "2026-10-09T15:20:00Z", scope: "always" }] },
      spaces: [
        { id: "school", name: "School", description: "Courses, deadlines, study notes", hue: 240 },
        { id: "work", name: "Work", description: "Projects, meetings, follow-ups", hue: 50 },
        { id: "garden", name: "Allotment and community garden", description: "Seed orders, the rota, what to plant when, and the long list of who borrowed which tools last spring", hue: 130 },
      ],
    },
    async run(page, h) {
      await openSpacesSettings(page, h);
      const row = (id) => `${PANEL} [data-space-row="${id}"]`;
      check((await page.$$(`${PANEL} [data-space-row]:not([hidden])`)).length === 3, "Spaces starts as a compact list");
      const before = await page.$eval(PANEL, (panel) => ({ width: panel.clientWidth, gutter: getComputedStyle(panel).scrollbarGutter }));
      await openSpaceDetails(page, ["school"]);
      check((await page.$$(`${PANEL} [data-space-row]:not([hidden])`)).length === 1, "editing opens only the selected workspace");
      check(await page.$eval(`${row("school")} [data-space-field="name"]`, (input) => input.getClientRects().length > 0), "the selected editor is visible");
      const after = await page.$eval(PANEL, (panel) => ({ width: panel.clientWidth, gutter: getComputedStyle(panel).scrollbarGutter }));
      check(before.width === after.width && after.gutter.includes("stable"), "opening an editor keeps a stable scroll width", JSON.stringify({ before, after }));
      await retype(page, `${row("school")} [data-space-field="name"]`, "Draft name");
      await h.click(`${PANEL} [data-spaces-back]`);
      await openSpaceDetails(page, ["school"]);
      check(await page.$eval(`${row("school")} [data-space-field="name"]`, (input) => input.value === "Draft name"), "returning to an editor preserves its unsaved draft");
      await page.focus(`${row("school")} [data-space-field="name"]`);
      await page.keyboard.press("Escape");
      await h.click(`${row("school")} [data-revoke="g-cal"]`);
      await page.waitForSelector(`${row("school")} [data-undo="g-cal"]`);
      await h.click(`${PANEL} [data-spaces-back]`);
      await openSpaceDetails(page, ["school"]);
      await h.click(`${row("school")} [data-undo="g-cal"]`);
      await page.waitForSelector(`${row("school")} [data-revoke="g-cal"]`);
      check((await calls(page, "grant_restore")).length === 1, "a pending access Undo survives leaving the editor");
      await h.shot("workspace-editor");

    },
  },
  {
    // A folder added under spaces/ outside Phaethon shows up when the window regains focus.
    name: "spaces-new-folder",
    mock: {},
    async run(page, h) {
      await showSidebar(page, h);
      check((await sidebarNames(page)).length === 2, "two spaces at first");
      await page.evaluate(() => {
        window.__MOCK__.spaces.push({ id: "art", name: "Art", description: "", hue: 320 });
        window.dispatchEvent(new Event("focus"));
      });
      await page.waitForSelector('#spaces-sidebar [data-space-id="art"]', { timeout: 5000 });
      await h.idle();
      const names = await sidebarNames(page);
      check(names.join() === "school:School*,art:Art,work:Work", "the new folder (never used) goes after the space in use, with the other unused ones by name, and the current space stays current", names.join());
    },
  },
  {
    // The current space's folder goes away: the first space takes over, nothing breaks.
    name: "spaces-gone",
    mock: {},
    async run(page, h) {
      await showSidebar(page, h);
      await h.click('#spaces-sidebar [data-space-id="work"]');
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "Work", { timeout: 5000 });
      await page.evaluate(() => {
        window.__MOCK__.spaces = window.__MOCK__.spaces.filter((s) => s.id !== "work");
        window.dispatchEvent(new Event("focus"));
      });
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "School", { timeout: 5000 });
      await h.idle();
      await showSidebar(page, h);
      const names = await sidebarNames(page);
      check(names.join() === "school:School*", "School is current once Work is gone", names.join());
    },
  },
  {
    name: "spaces-none",
    mock: { spaces: [] },
    async run(page, h) {
      await page.waitForSelector("[data-no-spaces]", { timeout: 5000 });
      check((await title(page)) === "No spaces yet", "the title says there are no spaces", await title(page));
      await h.idle();
      await h.shot("empty");
      await h.click("[data-no-spaces] button");
      await page.waitForSelector(DIALOG, { timeout: 5000 });
      await page.keyboard.type("Home");
      await page.keyboard.press("Enter");
      await h.click(`${DIALOG} [data-create-space]`);
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "Home", { timeout: 5000 });
      await h.idle();
      check(!(await page.$("[data-no-spaces]")), "the first space replaces the empty state");
    },
  },
  {
    name: "spaces-create-access-retry",
    sizes: [[1100, 720]],
    mock: { fail: { full_access_set: "Settings are temporarily unavailable." } },
    async run(page, h) {
      await showSidebar(page, h);
      await h.click("[data-new-space]");
      await page.waitForSelector(DIALOG);
      await page.type(`${DIALOG} input[required]`, "Garden");
      await h.click(`${DIALOG} [data-next-space]`);
      await h.click(`${DIALOG} [data-create-space]`);
      await page.waitForFunction(() => document.querySelector('[data-new-space-dialog] [role="alert"]')?.textContent.includes("Space created. Access could not be saved."));
      check((await calls(page, "space_create")).length === 1, "the space exists once before retrying its access save");
      await page.evaluate(() => delete window.__MOCK__.fail.full_access_set);
      await h.click(`${DIALOG} [data-create-space]`);
      await page.waitForFunction(() => !document.querySelector('[data-new-space-dialog]'));
      check((await calls(page, "space_create")).length === 1 && (await calls(page, "full_access_set")).length === 2, "Retry setup saves access without creating a duplicate space");
    },
  },
  {
    name: "spaces-workspace-options",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS },
    async run(page, h) {
      await showSidebar(page, h);
      await h.click("[data-new-space]");
      await page.waitForSelector(DIALOG);
      await page.type(`${DIALOG} input[required]`, "Personal projects");
      await h.click(`${DIALOG} [data-next-space]`);
      check(await page.$eval('[data-new-space-access]', (select) => select.value === "full"), "the new workspace starts with full agent access");
      await page.select('[data-new-space-access]', "workspace");
      await h.click('[data-new-space-education]');
      await page.$$eval('[data-new-space-dialog] button', (buttons) => buttons.find((button) => button.textContent === "Back").click());
      check(await page.$eval(`${DIALOG} input[required]`, (input) => input.value === "Personal projects"), "Back preserves the workspace name");
      await h.click(`${DIALOG} [data-next-space]`);
      check(await page.$eval('[data-new-space-access]', (select) => select.value === "workspace") && await page.$eval('[data-new-space-education]', (control) => control.getAttribute("aria-checked") === "true"), "moving between steps preserves both permission and Education choices");
      await h.shot("workspace-options");
    },
  },
];
