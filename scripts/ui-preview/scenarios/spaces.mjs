// Spaces from the vault: creating one from the sidebar (pointer and keyboard
// only), renaming, describing and recolouring in Settings > Spaces, a folder
// added outside Phaethon appearing, a space that disappears, and a vault with
// none. Behaviour checks: each fails unless the right command is sent and the
// sidebar, title bar and focus follow.

const SETTINGS = { backend: "phaethon", hasAnthropicKey: true, model: "claude-opus-5-5", appearance: {}, vaultPath: "/Users/you/Phaethon/default", version: "0.1.0" };
const DIALOG = "[data-new-space-dialog]";
const PANEL = '[role="dialog"] [role="tabpanel"]:not([hidden])';

function check(ok, what, detail = "") {
  if (!ok) throw new Error(`${what}${detail ? `: ${detail}` : ""}`);
  console.log(`     ok: ${what}`);
}
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const title = (page) => page.evaluate(() => document.getElementById("space-title")?.textContent ?? "");
const sidebarNames = (page) => page.evaluate(() => [...document.querySelectorAll("#spaces-sidebar [data-space-id]")].map((b) => `${b.dataset.spaceId}:${b.querySelector("span.truncate > [aria-hidden]")?.textContent}${b.getAttribute("aria-current") ? "*" : ""}`));
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
      await page.waitForSelector(DIALOG, { timeout: 5000 });
      // An empty name is refused in place, with nothing sent.
      await h.click(`${DIALOG} [data-create-space]`);
      await h.idle();
      const empty = await page.evaluate((d) => {
        const input = document.querySelector(`${d} input`);
        return { invalid: input.getAttribute("aria-invalid"), said: document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent, focus: document.activeElement === input };
      }, DIALOG);
      check(empty.invalid === "true" && empty.said === "Give the space a name." && empty.focus, "an empty name is flagged on the field, which takes focus", JSON.stringify(empty));
      check((await calls(page, "space_create")).length === 0, "nothing was created");
      await h.shot("empty-name");
      await page.keyboard.type("Garden");
      await page.type(`${DIALOG} input[aria-describedby]:not([aria-required])`, "Plants and seeds");
      await page.evaluate((d) => [...document.querySelectorAll(`${d} [role="radio"]`)].find((r) => r.textContent === "Moss")?.click(), DIALOG);
      await h.click(`${DIALOG} [data-create-space]`);
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "Garden", { timeout: 5000 });
      await h.idle();
      const sent = await calls(page, "space_create");
      check(JSON.stringify(sent) === JSON.stringify([{ name: "Garden", description: "Plants and seeds", hue: 130 }]), "space_create got the name, description and colour", JSON.stringify(sent));
      const names = await sidebarNames(page);
      const wide = !(await narrow(page));
      if (wide) {
        check(names.join() === "garden:Garden*,school:School,work:Work", "Garden, just made and opened, is the most recently used space: first, and current", names.join());
        check((await focused(page)) === "button[garden]", "focus is on Garden in the sidebar", await focused(page));
      } else {
        check((await focused(page)) === "main#main", "the narrow sidebar closed and focus is on the conversation", await focused(page));
      }
      const hue = await page.evaluate(() => document.documentElement.style.getPropertyValue("--ph-space-h"));
      check(hue === "130", "the window takes Garden’s colour", hue);
      const said = await page.evaluate(() => [...document.querySelectorAll('p[role="status"]')].map((p) => p.textContent).join("|"));
      check(said.includes("Created Garden."), "the creation is announced", said);
      check(!(await page.$(DIALOG)), "the dialog closed");
    },
  },
  {
    // Keyboard only: Tab to New space, fill the form, choose a colour with the arrows, create.
    name: "spaces-keyboard",
    mock: {},
    async run(page, h) {
      await showSidebar(page, h);
      await page.focus("#spaces-sidebar [data-space-id]");
      // Arrow keys reach New space at the end of the list.
      await page.keyboard.press("End");
      check(await page.evaluate(() => document.activeElement?.hasAttribute("data-new-space")), "End moves to New space");
      await page.keyboard.press("Enter");
      await page.waitForSelector(DIALOG, { timeout: 5000 });
      await h.idle();
      await page.keyboard.type("Side Project");
      await page.keyboard.press("Tab");
      await page.keyboard.type("Weekend things");
      await page.keyboard.press("Tab");
      const onRadio = await page.evaluate(() => document.activeElement?.getAttribute("role"));
      check(onRadio === "radio", "Tab reaches the colours", onRadio);
      const before = await page.evaluate(() => document.activeElement?.textContent);
      await page.keyboard.press("ArrowRight");
      const after = await page.evaluate(() => ({ label: document.activeElement?.textContent, checked: document.activeElement?.getAttribute("aria-checked") }));
      check(after.label !== before && after.checked === "true", "an arrow key moves to and chooses the next colour", `${before} -> ${JSON.stringify(after)}`);
      // Tab past Cancel to Create space.
      await h.focusVia(`${DIALOG} [data-create-space]`, 4);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "Side Project", { timeout: 5000 });
      await h.idle();
      const sent = await calls(page, "space_create");
      check(sent.length === 1 && sent[0].name === "Side Project" && sent[0].description === "Weekend things", "created from the keyboard", JSON.stringify(sent));
      const f = await focused(page);
      check(f === "button[side-project]" || f === "main#main", "focus lands on the new space (or the conversation when the sidebar hides)", f);
      // Escape cancels a second dialog and returns focus to New space.
      if (await narrow(page)) await showSidebar(page, h);
      await page.focus("[data-new-space]");
      await page.keyboard.press("Enter");
      await page.waitForSelector(DIALOG, { timeout: 5000 });
      await h.idle();
      check((await page.evaluate((d) => document.querySelector(`${d} input`).value, DIALOG)) === "", "a new dialog starts empty");
      await page.keyboard.type("Never mind");
      await page.keyboard.press("Escape");
      await page.waitForFunction((d) => !document.querySelector(d), { timeout: 5000 }, DIALOG);
      await h.idle();
      check(await page.evaluate(() => document.activeElement?.hasAttribute("data-new-space")), "Escape cancels and returns focus to New space", await focused(page));
      check((await calls(page, "space_create")).length === 1, "cancelling created nothing");
    },
  },
  {
    name: "spaces-rename",
    mock: { settings: SETTINGS },
    async run(page, h) {
      await openSpacesSettings(page, h);
      const school = `${PANEL} [data-space-row="school"]`;
      const work = `${PANEL} [data-space-row="work"]`;
      // Rename with Enter.
      await retype(page, `${school} [data-space-field="name"]`, "Uni");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "Uni", { timeout: 5000 });
      await h.idle();
      check(JSON.stringify(await calls(page, "space_update")) === JSON.stringify([{ id: "school", name: "Uni", description: null, hue: null }]), "space_update renamed school, nothing else", JSON.stringify(await calls(page, "space_update")));
      check((await settingsStatus(page)) === "Renamed to Uni.", "the rename is confirmed in the status region", await settingsStatus(page));
      const names = await sidebarNames(page);
      check(names.join() === "school:Uni*,work:Work", "the sidebar shows the new name; the id is unchanged", names.join());
      // Describe with blur (Tab away).
      await retype(page, `${work} [data-space-field="description"]`, "Clients and invoices");
      await page.keyboard.press("Tab");
      await page.waitForFunction(() => window.__calls.filter(([c]) => c === "space_update").length === 2, { timeout: 5000 });
      await h.idle();
      check((await settingsStatus(page)) === "Work’s description saved.", "leaving the field saves the description", await settingsStatus(page));
      // Escape undoes an unsaved edit and keeps Settings open.
      await retype(page, `${work} [data-space-field="name"]`, "Oops");
      await page.keyboard.press("Escape");
      await h.idle();
      const esc = await page.evaluate((w) => ({ value: document.querySelector(`${w} [data-space-field="name"]`).value, open: !!document.querySelector('[role="dialog"]') }), work);
      check(esc.value === "Work" && esc.open, "Escape puts the saved name back and Settings stays open", JSON.stringify(esc));
      check((await calls(page, "space_update")).length === 2, "the undone edit was not saved");
      // An empty name is refused in place.
      await retype(page, `${work} [data-space-field="name"]`, " ");
      await page.keyboard.press("Enter");
      await h.idle();
      const bad = await page.evaluate((w) => document.querySelector(`${w} [data-space-field="name"]`).getAttribute("aria-invalid"), work);
      check(bad === "true" && (await calls(page, "space_update")).length === 2, "an empty name is flagged and not saved");
      await page.keyboard.press("Escape");
      await h.idle();
      // Recolour.
      await page.evaluate((w) => [...document.querySelectorAll(`${w} [role="radio"]`)].find((r) => r.textContent === "Rose")?.click(), work);
      await page.waitForFunction(() => window.__calls.filter(([c]) => c === "space_update").length === 3, { timeout: 5000 });
      await h.idle();
      const hue = await page.evaluate(() => document.querySelector('#spaces-sidebar [data-space-id="work"]')?.style.getPropertyValue("--ph-space-h"));
      check(hue === "10", "the sidebar shows Work in its new colour", hue);
      check((await settingsStatus(page)) === "Work’s colour is now Rose.", "the colour change is confirmed", await settingsStatus(page));
      await h.shot("saved");
      // Escape on a clean field closes Settings; the title bar kept the new name.
      await page.focus(`${work} [data-space-field="name"]`);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
      await h.idle();
      check((await title(page)) === "Uni", "the title bar shows the new name", await title(page));
    },
  },
  {
    name: "spaces-settings",
    mock: { settings: SETTINGS, spaces: [{ id: "school", name: "School", description: "Courses, deadlines, study notes", hue: 250 }, { id: "work", name: "Work", description: "Projects, meetings, follow-ups", hue: 50 }] },
    async run(page, h) {
      await openSpacesSettings(page, h);
      const checked = await page.evaluate((p) => [...document.querySelectorAll(`${p} [data-space-row]`)].map((r) => `${r.dataset.spaceRow}:${r.querySelector('[role="radio"][aria-checked="true"]')?.textContent}`), PANEL);
      check(checked.join() === "school:Current,work:Clay", "a preset hue is chosen; any other shows as Current", checked.join());
      check((await fitsWidth(page, PANEL)) === "", "Settings > Spaces fits its width", await fitsWidth(page, PANEL));
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
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "Home", { timeout: 5000 });
      await h.idle();
      check(!(await page.$("[data-no-spaces]")), "the first space replaces the empty state");
    },
  },
];
