// A model per space (Team Model). Behaviour checks: check(...) fails the run.
//   f2-picker        the composer shows the space's model; a choice is saved for that space only, each space shows its own
//   f2-saved         a model saved in a space's file shows on load; Use the default goes back to it
//   f2-running       a change while a reply runs is saved and said, and never stops the reply
//   f2-palette       ⌘K › Change model… and Use the default model, by keyboard only
//   f2-cli           Claude Code answers: no picker, the palette and Settings say Claude Code picks its own model
//   f2-settings      Settings › Assistant: Default model, and the spaces with their own model with a way back
//   f2-fit           at 640x480 (and with --scale 2) the picker, Send and the open menu fit
import { SETTINGS, check, openSettings, park, PANEL } from "../audit-fixtures.mjs";

const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const shown = '[data-space-pane][data-shown]';
const picker = `${shown} [data-model-picker]`;
const shellSaid = (page, text, timeout = 4000) =>
  page.waitForFunction((t) => document.querySelector("[data-shell-status]")?.textContent === t, { timeout }, text).then(() => true, () => false);
const shellStatus = (page) => page.evaluate(() => document.querySelector("[data-shell-status]")?.textContent ?? "");
const pickerState = (page) =>
  page.$eval(picker, (b) => ({ text: b.textContent.trim(), label: b.getAttribute("aria-label"), model: b.dataset.model, space: b.dataset.modelPicker }));
const focused = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return a ? `${a.getAttribute("role") ?? a.tagName.toLowerCase()}|${a.getAttribute("data-model-option") ?? ""}|${a.textContent?.trim().slice(0, 50)}` : "none";
  });
async function openPicker(page) {
  await page.waitForSelector(picker, { timeout: 5000 });
  await page.click(picker);
  await page.waitForSelector('[data-model-menu] [role="menuitemradio"]', { timeout: 3000 });
}
async function choose(page, value) {
  await page.click(`[data-model-menu] [data-model-option="${value}"]`);
  await page.waitForFunction(() => !document.querySelector("[data-model-menu]"), { timeout: 3000 });
}
// By the space's place in the sidebar, which is most recently used first.
async function goTo(page, id) {
  const n = await page.$$eval("[data-space-id]", (els, id) => els.findIndex((e) => e.dataset.spaceId === id) + 1, id);
  await page.keyboard.down("Meta");
  await page.keyboard.press(String(n));
  await page.keyboard.up("Meta");
  await page.waitForFunction((id) => document.querySelector("[data-space-pane][data-shown]")?.dataset.spacePane === id, { timeout: 5000 }, id);
  await page.waitForSelector("[data-space-pane][data-shown] [data-model-picker]", { timeout: 5000 });
}
async function palette(page, query) {
  await page.keyboard.down("Meta");
  await page.keyboard.press("k");
  await page.keyboard.up("Meta");
  await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
  await page.keyboard.type(query);
}

export default [
  {
    name: "f2-picker",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await page.waitForSelector(picker, { timeout: 5000 });
      let p = await pickerState(page);
      check(p.space === "school" && p.text === "Opus 5.5" && p.model === "claude-opus-5-5", "School's composer shows the default model, Opus 5.5", JSON.stringify(p));
      check(p.label === "Model in School: Claude Opus 5.5, the default", "its name says the space, the full model name and that it is the default", p.label);
      await openPicker(page);
      await h.idle();
      const items = await page.$$eval('[data-model-menu] [role="menuitemradio"]', (els) => els.map((e) => [e.dataset.modelOption, e.getAttribute("aria-checked"), e.textContent.trim()]));
      console.log(`     items: ${JSON.stringify(items)}`);
      check(items[0][0] === "__default__" && items[0][1] === "true" && /^DefaultClaude Opus 5\.5, as set in Settings/.test(items[0][2]), "Default (Claude Opus 5.5) comes first, and is checked", JSON.stringify(items[0]));
      check(items.length === 4 && items.slice(1).every(([, , t]) => /^Claude /.test(t)), "then each model by its name", JSON.stringify(items));
      const f = await focused(page);
      check(f.startsWith("menuitemradio|__default__"), "the menu opens on the model in use", f);
      await park(page);
      await h.shot("menu");
      await choose(page, "claude-sonnet-5-5");
      const sets = await calls(page, "space_model_set");
      check(sets.length === 1 && sets[0].space === "school" && sets[0].model === "claude-sonnet-5-5", "choosing Sonnet saves it for School (space_model_set)", JSON.stringify(sets));
      check(await shellSaid(page, "School now uses Claude Sonnet 5.5."), "and says so", await shellStatus(page));
      p = await pickerState(page);
      check(p.text === "Sonnet 5.5" && p.label === "Model in School: Claude Sonnet 5.5", "the button now shows Sonnet, as School's own", JSON.stringify(p));
      check((await calls(page, "settings_set_model")).length === 0, "the default model is not touched");

      await goTo(page, "work");
      p = await pickerState(page);
      check(p.space === "work" && p.text === "Opus 5.5", "Work still uses the default", JSON.stringify(p));
      await openPicker(page);
      await choose(page, "claude-haiku-5-5");
      check(await shellSaid(page, "Work now uses Claude Haiku 5.5."), "Work's change is said", await shellStatus(page));
      await goTo(page, "school");
      p = await pickerState(page);
      check(p.text === "Sonnet 5.5", "back in School: Sonnet, its own", JSON.stringify(p));
      await goTo(page, "work");
      check((await pickerState(page)).text === "Haiku 5.5", "and Work: Haiku, its own");
      const saved = await page.evaluate(() => window.__MOCK__.spaceModels);
      check(saved.school === "claude-sonnet-5-5" && saved.work === "claude-haiku-5-5", "each space's choice is kept by the backend", JSON.stringify(saved));
      await park(page);
    },
  },
  {
    name: "f2-saved",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, spaceModels: { school: "claude-haiku-5-5" } },
    async run(page, h) {
      await page.waitForSelector(picker, { timeout: 5000 });
      await page.waitForFunction((sel) => document.querySelector(sel)?.dataset.model === "claude-haiku-5-5", { timeout: 3000 }, picker);
      check((await pickerState(page)).text === "Haiku 5.5", "a model saved for School shows when the app opens");
      await openPicker(page);
      const checked = await page.$eval('[data-model-menu] [aria-checked="true"]', (e) => e.dataset.modelOption);
      check(checked === "claude-haiku-5-5", "and is the checked choice", checked);
      await choose(page, "__default__");
      const sets = await calls(page, "space_model_set");
      check(sets.at(-1).model === null && sets.at(-1).space === "school", "Use the default saves null for School", JSON.stringify(sets));
      check(await shellSaid(page, "School now uses the default model, Claude Opus 5.5."), "and says which model that is", await shellStatus(page));
      const p = await pickerState(page);
      check(p.text === "Opus 5.5" && /the default$/.test(p.label), "the button shows the default again", JSON.stringify(p));
      // A new default in Settings is followed by a space on the default.
      await openSettings(page, h, "agent");
      await page.select("[data-model-select]", "claude-sonnet-5-5");
      await page.waitForFunction(() => window.__calls.some(([c]) => c === "settings_set_model"), { timeout: 3000 });
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
      await page.waitForFunction((sel) => document.querySelector(sel)?.dataset.model === "claude-sonnet-5-5", { timeout: 3000 }, picker).catch(() => {});
      check((await pickerState(page)).text === "Sonnet 5.5", "School follows the new default", JSON.stringify(await pickerState(page)));
    },
  },
  {
    name: "f2-running",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, holdOpen: true, turn: [{ kind: "text", delta: "Working on it" }] },
    async run(page, h) {
      await h.send("Plan my week");
      await page.waitForSelector(`${shown} [data-stop]`, { timeout: 5000 });
      await openPicker(page);
      const note = await page.$eval("[data-model-note]", (e) => e.textContent);
      check(/next message/.test(note) && /now running keeps its model/.test(note), "the menu says a change applies from the next message", note);
      await choose(page, "claude-sonnet-5-5");
      check(await shellSaid(page, "School now uses Claude Sonnet 5.5. The reply now running keeps its model."), "the change is said, with what happens to the reply", await shellStatus(page));
      check((await calls(page, "agent_cancel")).length === 0 && !!(await page.$(`${shown} [data-stop]`)), "the reply keeps running");
      check((await calls(page, "agent_send")).length === 1, "and isn't sent again");
      await park(page);
    },
  },
  {
    name: "f2-palette",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await page.waitForSelector(picker, { timeout: 5000 });
      await page.focus(`${shown} [data-composer-input]`);
      await palette(page, "change model");
      await page.waitForFunction(() => document.querySelector('[role="option"][aria-selected="true"]')?.dataset.command === "change-model", { timeout: 3000 });
      const hint = await page.$eval('[data-command="change-model"]', (e) => e.textContent);
      check(/in School: Claude Opus 5\.5/.test(hint), "Change model… says the space and its model", hint);
      check(!(await page.$('[data-command="default-model"]')), "no Use the default while School uses it");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-model-menu] [role="menuitemradio"]', { timeout: 3000 });
      await h.idle();
      let f = await focused(page);
      check(f.startsWith("menuitemradio|__default__"), "the model menu opens with focus on the model in use", f);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      f = await focused(page);
      check(f.startsWith("menuitemradio|claude-sonnet-5-5"), "arrows move through the models", f);
      await park(page);
      await h.shot("menu");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector("[data-model-menu]"), { timeout: 3000 });
      let sets = await calls(page, "space_model_set");
      check(sets.at(-1)?.model === "claude-sonnet-5-5" && sets.at(-1)?.space === "school", "Enter chooses Sonnet for School", JSON.stringify(sets));
      check(await shellSaid(page, "School now uses Claude Sonnet 5.5."), "and it is said", await shellStatus(page));
      f = await page.evaluate(() => document.activeElement?.dataset.modelPicker ?? document.activeElement?.tagName);
      check(f === "school", "focus goes back to the model button", f);

      await palette(page, "default model");
      await page.waitForFunction(() => document.querySelector('[role="option"][aria-selected="true"]')?.dataset.command === "default-model", { timeout: 3000 });
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.__calls.filter(([c]) => c === "space_model_set").length === 2, { timeout: 3000 });
      sets = await calls(page, "space_model_set");
      check(sets.at(-1).model === null, "Use the default model puts School back on the default", JSON.stringify(sets.at(-1)));
      check(await shellSaid(page, "School now uses the default model, Claude Opus 5.5."), "and says so", await shellStatus(page));
      check((await pickerState(page)).text === "Opus 5.5", "the button follows");
    },
  },
  {
    name: "f2-cli",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: { ...SETTINGS, backend: "claude-cli" }, threads: {}, spaceModels: { school: "claude-haiku-5-5" } },
    async run(page, h) {
      // Claude Code answering: its own models (the aliases its help gives), not Phaethon's own choice for the space.
      await page.waitForSelector(picker, { timeout: 5000 });
      const label = await page.$eval(picker, (b) => [b.getAttribute("aria-label"), b.textContent.trim()]);
      check(label[0] === "Model in School: Claude Code default, the model Claude Code chooses" && label[1] === "Claude Code default", "the button says Claude Code picks unless the space names one", JSON.stringify(label));
      await palette(page, "model");
      check(!(await page.$('[data-command="default-model"]')), "no Use the default model (that is Phaethon's own)");
      await page.waitForFunction(() => document.querySelector('[role="option"][aria-selected="true"]')?.dataset.command === "change-model", { timeout: 3000 });
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-model-menu] [data-model-option="opus"]', { timeout: 3000 });
      await page.click('[data-model-menu] [data-model-option="opus"]');
      check(await shellSaid(page, "School now uses Claude Code · Opus."), "choosing Opus says so", await shellStatus(page));
      check((await calls(page, "space_model_set")).at(-1)?.model === "claude:opus", "saved as claude:opus", JSON.stringify(await calls(page, "space_model_set")));
      await openSettings(page, h, "agent");
      const text = await page.$eval(PANEL, (e) => e.innerText);
      check(/Chosen by Claude Code/.test(text) && /A space can name another one/.test(text), "Settings says Claude Code chooses unless a space names one", text.slice(0, 300));
      await park(page);
    },
  },
  {
    name: "f2-settings",
    sizes: [[1100, 720], [760, 560]],
    mock: { settings: SETTINGS, threads: {}, spaceModels: { work: "claude-sonnet-5-5", school: "claude-haiku-5-5" } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.waitForSelector("[data-own-models]", { timeout: 3000 });
      const label = await page.$eval("[data-model-select]", (s) => s.labels?.[0]?.textContent);
      check(label === "Default model", "the setting is the Default model", label);
      const desc = await page.$eval("[data-model-select]", (s) => document.getElementById(s.getAttribute("aria-describedby"))?.textContent ?? "");
      check(/A space can choose its own/.test(desc), "and says a space can choose its own", desc);
      const rows = await page.$$eval("[data-own-model]", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
      check(rows.length === 2 && /School: Claude Haiku 5\.5/.test(rows[0]) && /Work: Claude Sonnet 5\.5/.test(rows[1]), "it lists each space with its own model", JSON.stringify(rows));
      await page.$eval("[data-own-models]", (e) => e.scrollIntoView({ block: "center" }));
      await park(page);
      await h.shot("list");
      await page.focus('[data-own-model-reset="school"]');
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector('[data-own-model="school"]'), { timeout: 3000 });
      await h.idle();
      const sets = await calls(page, "space_model_set");
      check(sets.length === 1 && sets[0].space === "school" && sets[0].model === null, "Use the default resets School only", JSON.stringify(sets));
      const said = await page.evaluate(() => document.querySelector('[role="dialog"] p[role="status"]')?.textContent ?? "");
      check(said === "School now uses the default model, Claude Opus 5.5.", "and is said", said);
      let f = await page.evaluate(() => document.activeElement?.getAttribute("data-own-model-reset"));
      check(f === "work", "focus moves to the next space's button", f);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector("[data-own-models]"), { timeout: 3000 });
      await h.idle();
      f = await page.evaluate(() => document.activeElement?.hasAttribute("data-model-select"));
      check(f, "with none left, focus goes to the Default model");
    },
  },
  {
    name: "f2-fit",
    sizes: [[640, 480], [1100, 720]],
    sizesRequired: true,
    mock: { settings: SETTINGS, threads: {}, spaceModels: { school: "claude-sonnet-5-5" } },
    async run(page, h) {
      await page.waitForSelector(picker, { timeout: 5000 });
      await h.idle();
      const box = await page.evaluate((sel) => {
        const r = (el) => el.getBoundingClientRect();
        const b = document.querySelector(sel);
        const composer = b.closest("[data-composer]");
        const send = composer.querySelector('[aria-label="Send message"]');
        const tb = b.parentElement;
        return {
          picker: r(b).toJSON(),
          send: r(send).toJSON(),
          composer: r(composer).toJSON(),
          overflow: tb.scrollWidth - tb.clientWidth,
          textClipped: b.querySelector("span").scrollWidth > b.querySelector("span").clientWidth + 1,
          vw: window.innerWidth,
        };
      }, picker);
      console.log(`     ${JSON.stringify({ picker: [box.picker.x, box.picker.width], send: [box.send.x, box.send.width], composer: [box.composer.x, box.composer.width], overflow: box.overflow })}`);
      check(box.overflow <= 0, "the toolbar doesn't overflow", `${box.overflow}`);
      check(box.picker.right <= box.send.left && box.send.right <= box.composer.right, "the picker sits before Send, inside the composer");
      check(!box.textClipped, "the model's name shows whole");
      await openPicker(page);
      await h.idle();
      const menu = await page.$eval("[data-model-menu]", (m) => ({ ...m.getBoundingClientRect().toJSON(), sh: m.scrollHeight, ch: m.clientHeight }));
      check(menu.left >= 0 && menu.right <= box.vw && menu.top >= 0, "the open menu stays in the window", JSON.stringify(menu));
      await park(page);
    },
  },
];
