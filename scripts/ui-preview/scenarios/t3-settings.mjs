// Settings, persona re-check round 2 (Team T). Each scenario fails unless the
// thing it names happens in the page.
//   t3-undo           Remove in Settings › Spaces has Undo, kept until Settings closes (jordan3)
//   t3-incoming       each space lists which other spaces can read it (sam3)
//   t3-provider-controls  compact provider actions have clear accessible names
//   t3-bounded        Settings leaves the workspace visible and its footer entry aligns left
//   t3-words          MANUAL.md and application folders are easy to find
//   t3-cli-missing    Claude Code not installed: say how to install, don't switch (linda6)
//   t3-cli-installed  installed: an explicit default action switches assistants
//   t3-word-spacing   a word-spacing control; Text comes first in Appearance (priya15, N5)
//   t3-slider-click   a click on a track steps toward it, never jumps (jordan5); Close has a tooltip
//   t3-compact        at 760x560 and 200% the header and tabs take at most a quarter of the height (tomas6)
//   t3-provider-setup  keyboard setup leaves the current default unchanged
//   t3-about-files    About lists file locations and copies the instructions path
//   t3-space-folder   a space's folder in plain words, not "Folder: spaces/school" (linda r3)
import { SETTINGS, check, openSettings, openSpaceDetails, park, PANEL } from "../audit-fixtures.mjs";
import { openProviderConfiguration, closeProviderPopup, providerPopup, useProviderDefault } from "../provider-flow.mjs";

const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const css = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const panelText = (page) => page.evaluate((p) => document.querySelector(p)?.innerText ?? "", PANEL);
const status = (page) => page.evaluate(() => document.querySelector('[role="dialog"] p[role="status"]')?.textContent ?? "");
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return a ? `${a.tagName.toLowerCase()}|${a.getAttribute("aria-label") ?? ""}|${a.textContent?.trim().slice(0, 60) ?? ""}` : "none";
});
/** The slider thumb whose label is `label`. */
const sliderBy = (page, label) =>
  page.evaluateHandle(
    (label) =>
      [...document.querySelectorAll('[role="dialog"] [role="slider"]')].find((t) =>
        (t.getAttribute("aria-labelledby") ?? "").split(" ").some((id) => document.getElementById(id)?.textContent === label),
      ) ?? null,
    label,
  );

const CAL = { id: "g-cal", from: "work", path: "calendar", created: "2026-10-09T15:20:00Z", scope: "always" };

export default [
  {
    name: "t3-bounded",
    sizes: [[1100, 720], [640, 480]],
    sizesRequired: true,
    themes: ["light", "dark"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await page.waitForSelector('[data-testid="open-settings"]');
      const sidebar = await page.$eval('[data-testid="open-settings"]', (button) => ({ id: button.closest('nav').id, visible: button.getClientRects().length > 0 }));
      if (!sidebar.visible) await h.click(`button[aria-controls="${sidebar.id}"]`);
      const footer = await page.$eval('[data-testid="open-settings"]', (button) => {
        const face = button.querySelector('.ui-button-face');
        const icon = button.querySelector('svg');
        return { justify: getComputedStyle(face).justifyContent, inset: icon.getBoundingClientRect().left - button.getBoundingClientRect().left, iconWidth: icon.getBoundingClientRect().width };
      });
      check(footer.justify === "flex-start" && footer.inset <= footer.iconWidth + 2, "the Settings entry aligns its Vic face and icon to the navigation rail", JSON.stringify(footer));
      await page.click('[data-testid="open-settings"]');
      await page.waitForSelector('[role="dialog"] h3');
      await h.click('[data-testid="settings-tab-appearance"]');
      await h.idle();
      const bounds = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]').getBoundingClientRect();
        const close = document.querySelector('[aria-label="Close settings"]').getBoundingClientRect();
        const panel = document.querySelector('[role="dialog"] [role="tabpanel"]:not([hidden])');
        return { left: dialog.left, top: dialog.top, right: dialog.right, bottom: dialog.bottom, width: dialog.width, height: dialog.height, viewport: [innerWidth, innerHeight], scale: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ph-ui-scale')), closeIn: close.left >= dialog.left && close.top >= dialog.top && close.right <= dialog.right && close.bottom <= dialog.bottom, scrollable: panel.scrollHeight > panel.clientHeight && panel.clientHeight > 100 };
      });
      check(bounds.left >= 15 && bounds.top >= 15 && bounds.right <= bounds.viewport[0] - 15 && bounds.bottom <= bounds.viewport[1] - 15, "Settings leaves a visible workspace margin on every side", JSON.stringify(bounds));
      check(bounds.width <= 960 * bounds.scale && bounds.height <= 700 * bounds.scale, "Settings stays within its desktop size limits at the chosen text size", JSON.stringify(bounds));
      check(bounds.closeIn && bounds.scrollable, "Close stays visible while the Settings content scrolls", JSON.stringify(bounds));
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
      await page.waitForFunction(() => document.activeElement === document.querySelector('[data-testid="open-settings"]'));
      check(await page.$eval('[data-testid="open-settings"]', (button) => document.activeElement === button), "Escape returns focus to the Settings entry");
    },
  },
  {
    name: "t3-undo",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, grants: { school: [CAL] } },
    async run(page, h) {
      await openSettings(page, h, "spaces");
      const row = `${PANEL} [data-space-row="school"]`;
      await openSpaceDetails(page, ["school"]);
      await page.focus(`${row} [data-revoke="g-cal"]`);
      await page.keyboard.press("Enter");
      await page.waitForSelector(`${row} [data-undo="g-cal"]`, { timeout: 3000 });
      await h.idle();
      const revokes = await calls(page, "grant_revoke");
      check(revokes.length === 1 && revokes[0].id === "g-cal", "Remove takes the access away at once (grant_revoke)", JSON.stringify(revokes));
      const f = await focused(page);
      check(f.startsWith("button|Undo removing"), "focus moves to that row's Undo", f);
      const said = await status(page);
      check(/Undo/.test(said) && /already read stays/.test(said), "the status says it was removed, that what was read stays, and that Undo is there", said);
      await park(page);
      await h.shot("pending");
      // Jordan dwells about a second per target: Undo must not vanish on a timer.
      await new Promise((r) => setTimeout(r, 7000));
      check(!!(await page.$(`${row} [data-undo="g-cal"]`)), "Undo is still there after 7 seconds");
      await page.click(`${row} [data-undo="g-cal"]`);
      await page.waitForSelector(`${row} [data-revoke="g-cal"]`, { timeout: 3000 });
      await h.idle();
      const restores = await calls(page, "grant_restore");
      check(restores.length === 1 && restores[0].id === "g-cal", "Undo puts the same access back (grant_restore, the id only)", JSON.stringify(restores));
      check((await focused(page)).startsWith("button|Remove School"), "focus goes back to Remove", await focused(page));
      check(/School can read Work \/ calendar again/.test(await status(page)), "and Undo is announced", await status(page));
      // Remove again, then close Settings: the removal stands, and the row is gone on reopening.
      await page.click(`${row} [data-revoke="g-cal"]`);
      await page.waitForSelector(`${row} [data-undo="g-cal"]`, { timeout: 3000 });
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
      await openSettings(page, h, "spaces");
      await openSpaceDetails(page, ["school"]);
      const text = await page.$eval(row, (el) => el.innerText);
      check(!(await page.$(`${row} [data-undo]`)) && !(await page.$(`${row} [data-revoke]`)) && /Can’t read anything outside School/.test(text), "after closing, the removal stands and Undo is gone", text.slice(0, 200));
    },
  },
  {
    name: "t3-incoming",
    sizes: [[1100, 720], [760, 560]],
    mock: { settings: SETTINGS, threads: {}, grants: { school: [CAL] } },
    async run(page, h) {
      await openSettings(page, h, "spaces");
      const work = `${PANEL} [data-space-row="work"]`;
      const folded = await page.$eval(`${work} [data-space-summary]`, (el) => el.textContent);
      check(folded === "Read by School", "folded, Work's row says School reads it", folded);
      await openSpaceDetails(page);
      const text = await page.$eval(work, (el) => el.innerText);
      check(/School\sreads\scalendar/.test(text), "Work's row says School reads its calendar", text);
      const list = await page.$eval(work, (el) => el.querySelector('ul[aria-label^="Who can read"]')?.getAttribute("aria-label"));
      check(list === "Who can read Work", "as a list named Who can read Work", list);
      const school = await page.$eval(`${PANEL} [data-space-row="school"]`, (el) => el.innerText);
      check(/No other space can read School/.test(school), "School's row says nothing reads it", school);
      await page.$eval(work, (el) => el.scrollIntoView({ block: "center" }));
      await park(page);
      await h.shot("work");
      // Removing from the reading side's row works the same way (with Undo).
      await page.click(`${work} [data-revoke="g-cal"]`);
      await page.waitForSelector(`${work} [data-undo="g-cal"]`, { timeout: 3000 });
      const revokes = await calls(page, "grant_revoke");
      check(revokes.length === 1 && revokes[0].id === "g-cal", "Remove on Work's row takes School's access away", JSON.stringify(revokes));
      await park(page);
    },
  },
  {
    name: "t3-provider-controls",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.waitForSelector('[data-provider-row="claude-cli"]');
      const actions = await page.$$(`${PANEL} [data-provider-configure], ${PANEL} [data-provider-default], ${PANEL} [data-backend], ${PANEL} [data-provider-add]`);
      check(actions.length >= 4, "configured providers expose one management action each and Add provider", `${actions.length}`);
      for (const action of actions) {
        const ax = await page.accessibility.snapshot({ root: action, interestingOnly: false });
        check(ax?.role === "button" && ["Manage Anthropic", "Manage Claude Code", "Manage Codex", "Manage Gemini CLI", "Add provider"].includes(ax.name), "each provider action names its provider without the row's status prose", JSON.stringify({ role: ax?.role, name: ax?.name }));
      }
      check((await page.$$(`${PANEL} [role="radio"]`)).length === 0, "provider setup uses explicit actions");
    },
  },
  {
    name: "t3-words",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      check(!!(await page.$('[data-provider-configure="anthropic"]')), "Assistant exposes provider setup directly");
      await h.click('[data-testid="settings-tab-about"]');
      await h.idle();
      const about = await panelText(page);
      check(about.includes("spaces/<space>/.phaethon/") && about.includes("spaces/<space>/attachments/"), "About lists conversation and attachment folders", about);
      check(about.includes("MANUAL.md applies to every space.") && about.includes(`${SETTINGS.vaultPath}/MANUAL.md`), "About identifies the shared instructions file", about);
      await page.$eval("[data-files-heading]", (el) => el.scrollIntoView({ block: "start" }));
      await park(page);
    },
  },
  {
    name: "t3-cli-missing",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, claudeCli: { installed: false } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "claude-cli");
      await useProviderDefault(page, "claude-cli");
      await page.waitForSelector("[data-cli-missing]", { timeout: 3000 });
      await h.idle();
      const asked = await calls(page, "claude_cli_status");
      const set = await calls(page, "settings_set_backend");
      check(asked.length >= 1, "it checks whether Claude Code is installed first", `${asked.length}`);
      check(set.length === 0, "and does not switch when it isn't", JSON.stringify(set));
      const current = await page.$eval('[data-provider-row="anthropic"]', (el) => el.textContent);
      check(current.includes("Default"), "Anthropic remains the default", current);
      const msg = await page.$eval("[data-cli-missing]", (el) => ({ text: el.innerText, link: el.querySelector("a")?.href ?? "" }));
      check(/isn’t installed/.test(msg.text) && /install/i.test(msg.text) && msg.link.startsWith("https://"), "it says Claude Code isn't installed and how to install it", JSON.stringify(msg));
      check(/isn’t installed/.test(await status(page)), "and says so in the status line", await status(page));
      await park(page);
    },
  },
  {
    // The first-run card uses the same installation check.
    name: "t3-cli-missing-setup",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: { ...SETTINGS, hasAnthropicKey: false }, threads: {}, claudeCli: { installed: false } },
    async run(page, h) {
      await page.waitForSelector("[data-setup-cli]", { timeout: 5000 });
      await page.$eval("[data-setup-cli]", (el) => el.scrollIntoView({ block: "center" }));
      await page.click("[data-setup-cli]");
      await page.waitForFunction(() => /isn’t installed/.test(document.body.innerText), { timeout: 3000 });
      await h.idle();
      const set = await calls(page, "settings_set_backend");
      check(set.length === 0, "the setup card does not switch when Claude Code isn't installed", JSON.stringify(set));
      check(!(await page.$("[data-setup-done]")), "and does not say it now uses Claude Code");
      const text = await page.evaluate(() => document.body.innerText);
      check(!/Error:/.test(text), "the message is plain words, no 'Error:' prefix");
      await park(page);
    },
  },
  {
    name: "t3-cli-installed",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, claudeCli: { installed: true, path: "/usr/local/bin/claude" } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "claude-cli");
      await useProviderDefault(page, "claude-cli");
      await page.waitForFunction(() => window.__calls.some(([c]) => c === "settings_set_backend"), { timeout: 3000 });
      await h.idle();
      const set = await calls(page, "settings_set_backend");
      check(set.length === 1 && set[0].backend === "claude-cli", "installed: it switches to Claude Code", JSON.stringify(set));
      check(!(await page.$("[data-cli-missing]")), "with no install message");
    },
  },
  {
    name: "t3-word-spacing",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      const groups = await page.$$eval(`${PANEL} h4`, (hs) => hs.map((x) => x.textContent));
      check(groups[0] === "Text", "Text (with the reading font) is the first group in Appearance", groups.join());
      const fontTop = await page.$eval(`${PANEL} [data-font-card]`, (el) => el.getBoundingClientRect().top);
      check(fontTop < 720 * 0.6, "the reading font shows without scrolling", `${fontTop}`);
      await h.shot("appearance");
      await h.click('[data-testid="settings-tab-accessibility"]');
      await h.idle();
      const ws = await sliderBy(page, "Word spacing");
      check(await ws.evaluate((t) => !!t), "Accessibility › Reading has a Word spacing slider");
      await ws.focus();
      await page.keyboard.press("Home");
      await h.idle();
      const low = { vt: await ws.evaluate((t) => t.getAttribute("aria-valuetext")), token: await css(page, "--ph-word-spacing") };
      check(low.token.startsWith("-") && /Tighter/.test(low.vt), "word spacing goes below zero for wide fonts", JSON.stringify(low));
      // Priya: OpenDyslexic's own space is wide, so the floor is about −0.2em, not −0.1em.
      check(parseFloat(low.token) <= -0.2 && low.token.endsWith("em"), "word spacing goes down to −0.2em", JSON.stringify(low));
      await page.keyboard.press("End");
      await h.idle();
      const high = await page.evaluate(() => ({
        token: getComputedStyle(document.documentElement).getPropertyValue("--ph-word-spacing").trim(),
        body: getComputedStyle(document.querySelector('[role="dialog"] h3')).wordSpacing,
        sample: getComputedStyle(document.querySelector("[data-reading-sample]")).wordSpacing,
      }));
      check(parseFloat(high.token) >= 0.16, "and up to at least 0.16em (WCAG 1.4.12)", JSON.stringify(high));
      check(parseFloat(high.body) > 0 && parseFloat(high.sample) > 0, "it applies to all text, the sample too", JSON.stringify(high));
      await new Promise((r) => setTimeout(r, 900));
      const saved = (await calls(page, "appearance_set")).at(-1)?.appearance?.tokens ?? {};
      check(typeof saved["--ph-word-spacing"] === "string" && saved["--ph-word-spacing"].endsWith("em"), "it is saved with the appearance", JSON.stringify(saved));
      await ws.evaluate((t) => t.scrollIntoView({ block: "center" }));
      await park(page);
      await h.shot("wide");
      // The page's Reset puts it back.
      await page.$$eval('[role="dialog"] button', (bs) => bs.find((b) => /Reset/.test(b.textContent) && /word spacing/i.test(b.getAttribute("aria-label") ?? ""))?.click());
      await h.idle();
      check((await css(page, "--ph-word-spacing")) === "0", "Reset puts word spacing back to none", await css(page, "--ph-word-spacing"));
    },
  },
  {
    name: "t3-slider-click",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "accessibility");
      const thumb = await sliderBy(page, "Text size");
      const track = await thumb.evaluateHandle((t) => t.closest("[data-setting-row]").querySelector("[data-slider-track]"));
      let box = await track.boundingBox();
      // A slip onto the track at 80%: one step toward it, not a jump to 175%.
      await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
      await h.idle();
      const one = await thumb.evaluate((t) => Number(t.getAttribute("aria-valuenow")));
      check(Math.abs(one - 1.05) < 1e-6, "a click on the track moves text size one step (100% to 105%)", `${one}`);
      check(await thumb.evaluate((t) => document.activeElement === t), "and the thumb has focus, so arrows go on from there");
      // Toward the left of the thumb steps down.
      // Text size changes reflow the page, so use the track’s current position.
      box = await track.boundingBox();
      await page.mouse.click(box.x + box.width * 0.02, box.y + box.height / 2);
      await h.idle();
      const back = await thumb.evaluate((t) => Number(t.getAttribute("aria-valuenow")));
      check(Math.abs(back - 1) < 1e-6, "a click left of it steps back down", `${back}`);
      // The thumb still drags.
      box = await track.boundingBox();
      const tb = await thumb.boundingBox();
      await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.5, tb.y + tb.height / 2, { steps: 8 });
      await page.mouse.up();
      await h.idle();
      const dragged = await thumb.evaluate((t) => Number(t.getAttribute("aria-valuenow")));
      check(dragged > 1.3, "dragging the thumb still moves it as far as you drag", `${dragged}`);
      // Close shows its name on hover.
      await h.hover('button[aria-label="Close settings"]');
      await page.waitForSelector('[data-slot="tooltip-content"]', { timeout: 3000 });
      const tip = await page.$eval('[data-slot="tooltip-content"]', (el) => el.textContent);
      check(tip.startsWith("Close settings"), "Close shows a visible tooltip with its name", tip);
      await h.idle();
      await h.shot("close-tip");
      await park(page);
    },
  },
  {
    name: "t3-compact",
    sizes: [[760, 560]],
    sizesRequired: true,
    mock: { settings: { ...SETTINGS, appearance: { tokens: { "--ph-text-scale": 2 } } }, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      const m = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]').getBoundingClientRect();
        const panel = document.querySelector('[role="dialog"] [role="tabpanel"]:not([hidden])').getBoundingClientRect();
        const tabs = [...document.querySelectorAll('[role="dialog"] [role="tab"]')].map((t) => t.getBoundingClientRect());
        return { dh: d.height, top: panel.top - d.top, tabsIn: tabs.every((t) => t.right <= d.right + 1 && t.left >= d.left - 1 && t.height >= 24), title: document.querySelector('[role="dialog"] h2')?.textContent };
      });
      console.log(`     header ${Math.round(m.top)} of ${Math.round(m.dh)} px`);
      // Six sections wrap to a second row here (nothing hidden): up to 30% of the window.
      check(m.top / m.dh <= 0.3, "the header and tabs take at most 30% of the window", `${Math.round((m.top / m.dh) * 100)}%`);
      check(m.tabsIn, "every tab is fully in view and at least 24px tall");
      check(m.title === "Settings", "the window is still titled Settings", m.title);
      await park(page);
    },
  },
  {
    name: "t3-provider-setup",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "anthropic", { keyboard: true, catalog: true });
      const setup = await page.$eval(providerPopup, (el) => ({ text: el.innerText, key: !!el.querySelector("[data-key-input]"), model: !!el.querySelector("[data-model-select]") }));
      check(setup.key && setup.model, "keyboard provider selection opens its key and model controls", JSON.stringify(setup));
      check(!/privacy policy|subscription|What is sent/.test(setup.text), "setup keeps its copy focused on configuration", setup.text);
      check((await calls(page, "settings_set_backend")).length === 0 && (await calls(page, "settings_set_provider")).length === 0, "opening setup leaves the default unchanged");
      await park(page);
      await closeProviderPopup(page, { keyboard: true });
      await h.click('[data-testid="settings-tab-about"]');
      await h.idle();
      const about = await panelText(page);
      check(about.includes("Files") && !/privacy policy|Deleting a conversation|keeps its own copy/.test(about), "About exposes files without policy tutorials", about);
    },
  },
  {
    name: "t3-about-files",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "about");
      const shown = await page.$eval("[data-about-files]", (el) => ({ text: el.innerText, details: !!el.querySelector("details") }));
      check(shown.text.includes(SETTINGS.vaultPath) && shown.text.includes("spaces/<space>/.phaethon/") && shown.text.includes("spaces/<space>/attachments/"), "file locations are directly visible", JSON.stringify(shown));
      check(!shown.details && !/privacy policy|Deleting a conversation|keeps its own copy/.test(shown.text), "file locations need no disclosure or tutorial", JSON.stringify(shown));
      await page.$eval("[data-about-files]", (el) => el.scrollIntoView({ block: "center" }));
      await park(page);
      await h.shot("file-paths");
      const copyInstructions = await page.evaluateHandle(() => [...document.querySelectorAll("[data-about-files] [data-setting-row]")].find((row) => row.textContent.includes("Instructions"))?.querySelector("button"));
      await copyInstructions.focus();
      await page.keyboard.press("Enter");
      await h.idle();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      check(copied === `${SETTINGS.vaultPath}/MANUAL.md`, "the instructions path copies from the keyboard", copied);
      check((await status(page)).includes("Path of MANUAL.md copied."), "copying the instructions path is announced", await status(page));
      await park(page);
    },
  },
  {
    // Linda: a space's folder is said in words, not as the path "spaces/school".
    name: "t3-space-folder",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "spaces");
      await openSpaceDetails(page);
      const text = await panelText(page);
      check(!/Folder: |spaces\/school/.test(text), "no \"Folder: spaces/school\" path", text.slice(0, 400));
      const f = await page.$$eval("[data-space-folder]", (els) => els.map((e) => ({ text: e.textContent, mono: getComputedStyle(e).fontFamily.includes("Mono") })));
      check(f[0]?.text === "Kept in the folder named “school”, inside the spaces folder of your Phaethon folder." && !f[0].mono, "it says where in plain words", JSON.stringify(f));
      await park(page);
    },
  },
];
