// Audit: the settings window. Every section top and bottom at three window
// sizes; the API key in each state; the backend switch; theme cards; swatch
// focus; a hue slider mid-drag; a changed control, its Reset and the section's
// Undo reset; every accessibility switch on; Spaces with grants, with
// grants.json problems, with none, and failing; About's copy feedback.
import { CONVERSATION, GRANTS, PANEL, SETTINGS, activeDesc, check, clickText, openSettings, park, scrollPanel } from "../audit-fixtures.mjs";

const SIZES3 = [[1100, 720], [760, 560], [640, 480]];
const WIDE = [[1100, 720]];
const SECTIONS = ["agent", "appearance", "accessibility", "spaces", "about"];

const sliderIn = (page, label) =>
  page.evaluateHandle((label) => {
    for (const t of document.querySelectorAll('[role="slider"]')) {
      const ids = (t.getAttribute("aria-labelledby") ?? "").split(" ");
      const text = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (text.includes(label)) return t;
    }
    return null;
  }, label);

export default [
  ...SECTIONS.map((tab) => ({
    name: `audit-settings-${tab}`,
    sizes: SIZES3,
    mock: { settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.two } },
    async run(page, h) {
      await openSettings(page, h, tab);
      await park(page);
      await h.shot("top");
      await scrollPanel(page, "end");
      await h.idle();
    },
  })),

  // ---- Agent ----
  {
    name: "audit-settings-key-none",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: { ...SETTINGS, hasAnthropicKey: false }, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.focus('input[type="password"]');
      await page.keyboard.press("Shift");
      await h.idle();
      await h.shot("input-focused");
      await clickText(page, '[role="dialog"]', "Save key");
      await h.waitText("Paste a key first");
      await park(page);
      await h.idle();
    },
  },
  {
    name: "audit-settings-key-invalid",
    sizes: WIDE,
    mock: { settings: { ...SETTINGS, hasAnthropicKey: false }, threads: {}, fail: { api_key_set: "That doesn't look like an Anthropic API key (it should start with sk-ant-)." } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.type('input[type="password"]', "not-a-real-key");
      await clickText(page, '[role="dialog"]', "Save key");
      await h.idle();
      await park(page);
      const alert = await page.evaluate(() => document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? "");
      console.log(`     key error shown as: ${alert}`);
    },
  },
  {
    name: "audit-settings-key-saving",
    sizes: WIDE,
    themes: ["light"],
    mock: { settings: { ...SETTINGS, hasAnthropicKey: false }, threads: {}, slow: { api_key_set: 60000 } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.type('input[type="password"]', "sk-ant-api03-xxxxxxxxxxxxxxxx");
      await clickText(page, '[role="dialog"]', "Save key");
      await h.idle();
      await park(page);
      const disabled = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes("Save key"))?.disabled);
      console.log(`     while saving, Save key disabled: ${disabled}`);
    },
  },
  {
    name: "audit-settings-key-saved",
    sizes: WIDE,
    mock: { settings: { ...SETTINGS, hasAnthropicKey: false }, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.type('input[type="password"]', "sk-ant-api03-xxxxxxxxxxxxxxxx");
      await clickText(page, '[role="dialog"]', "Save key");
      await h.waitText("A key is saved");
      await park(page);
      await h.idle();
      const status = await page.evaluate(() => document.querySelector('[role="dialog"] p[role="status"]')?.textContent);
      console.log(`     after save, status: ${status}; focus: ${await activeDesc(page)}`);
    },
  },
  {
    name: "audit-settings-backend-cli",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      const cards = await page.$$('[role="dialog"] [role="radio"]');
      await cards[1].hover();
      await h.idle();
      await h.shot("cli-hover");
      await cards[1].click();
      await h.waitText("Now using", { soft: true });
      await h.idle();
      await page.keyboard.press("Shift");
      await h.idle();
      await h.shot("cli-chosen");
      await park(page);
      await scrollPanel(page, "end");
      await h.idle();
    },
  },

  // ---- Appearance ----
  {
    name: "audit-settings-theme-cards",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: { school: CONVERSATION } },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      const cards = await page.$$('[role="radiogroup"][aria-label="Theme"] [role="radio"]');
      await cards[1].hover();
      await h.idle();
      await h.shot("light-hover");
      await cards[1].click();
      await park(page);
      await h.idle();
      await h.shot("light-chosen");
      await cards[2].click();
      await park(page);
      await h.idle();
      await h.shot("dark-chosen");
      // Keyboard: arrow back to Match system; the ring sits on the card.
      await page.keyboard.press("Shift");
      await page.keyboard.press("ArrowRight");
      await h.idle();
    },
  },
  {
    name: "audit-settings-colour",
    sizes: [[1100, 720], [760, 560]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      // Tab from the section list into the page until a swatch has focus.
      await page.focus('[data-testid="settings-tab-appearance"]');
      await h.focusVia('[role="radiogroup"][aria-label="Accent colour"] [role="radio"]');
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await h.idle();
      await page.evaluate(() => document.activeElement.scrollIntoView({ block: "center" }));
      await h.idle();
      await h.shot("swatch-focused");
      await h.hover('[role="radiogroup"][aria-label="Accent colour"] [role="radio"]:nth-child(5)');
      await h.idle();
      await h.shot("swatch-hover");
      // A hue slider mid-drag: mouse down on the thumb, move, no release.
      const thumb = await sliderIn(page, "Custom hue");
      const box = await thumb.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 6 });
      await h.idle();
      await h.shot("hue-mid-drag");
      await page.mouse.up();
      await park(page);
      await h.idle();
    },
  },
  {
    name: "audit-settings-changed-reset",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      const thumb = await sliderIn(page, "Text size");
      await thumb.focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await h.idle();
      await page.evaluate(() => document.activeElement.scrollIntoView({ block: "center" }));
      await h.idle();
      await h.shot("text-size-changed");
      await h.hover('button[aria-label^="Reset text size"]');
      await h.idle();
      await h.shot("reset-hover");
      await page.click('button[aria-label^="Reset text size"]');
      await h.idle();
      const f = await page.evaluate(() => document.activeElement?.getAttribute("role"));
      check(f === "slider", "after a row's Reset, focus is on its slider", f);
      await h.shot("after-row-reset");
      // Change two things, then reset the whole page: Undo reset appears.
      await page.keyboard.press("ArrowRight");
      await scrollPanel(page, 0);
      await clickText(page, PANEL, "Light");
      await h.idle();
      await page.click('button[aria-label="Reset appearance to defaults"]');
      await h.idle();
      await page.keyboard.press("Shift");
      await h.idle();
      await h.shot("undo-reset");
      await clickText(page, PANEL, "Undo reset");
      await h.idle();
      await park(page);
    },
  },
  {
    name: "audit-settings-quickpicks",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      const pick = await page.evaluateHandle(() => [...document.querySelectorAll('[role="group"] button')].find((b) => b.getAttribute("aria-label")?.startsWith("Larger")));
      await pick.evaluate((b) => b.scrollIntoView({ block: "center" }));
      await pick.hover();
      await h.idle();
      await h.shot("hover");
      await pick.click();
      await h.idle();
      await pick.evaluate((b) => b.scrollIntoView({ block: "center" }));
      await park(page);
      await h.idle();
    },
  },

  {
    // ARIA radio pattern: an arrow key moves focus AND checks the new radio.
    // Logs what happens (does not fail the run) so a fix can be confirmed.
    name: "audit-settings-radio-keys",
    sizes: WIDE,
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      const state = (sel) =>
        page.evaluate((s) => [...document.querySelectorAll(s)].map((r) => `${r.textContent.trim()}:${r.getAttribute("aria-checked")}${r === document.activeElement ? "(focus)" : ""}`).join(" "), sel);
      for (const group of ["Theme", "Accent colour"]) {
        const sel = `[role="radiogroup"][aria-label="${group}"] [role="radio"]`;
        await page.focus(sel);
        await page.keyboard.press("ArrowRight");
        await h.idle();
        const s = await state(sel);
        const focusedChecked = /:true\(focus\)/.test(s);
        console.log(`     ${group} after one ArrowRight: ${s} -> ${focusedChecked ? "ok" : "FOCUS MOVED WITHOUT CHECKING"}`);
      }
    },
  },

  // ---- Accessibility ----
  {
    name: "audit-settings-a11y-all-on",
    sizes: [[1100, 720], [760, 560]],
    mock: {
      settings: {
        ...SETTINGS,
        appearance: { increaseContrast: "on", reduceMotion: "on", tokens: { "--ph-focus-width": "4px", "--ph-tracking-normal": "0.05em", "--ph-leading-normal": 1.9, "--ph-icon-stroke": 2.25 } },
      },
      threads: {},
    },
    async run(page, h) {
      await openSettings(page, h, "accessibility");
      await park(page);
      await h.shot("top");
      const sw = await page.$('[role="switch"]');
      await sw.focus();
      await page.keyboard.press("Shift");
      await h.idle();
      await h.shot("switch-focused");
      await scrollPanel(page, "end");
      await h.idle();
    },
  },
  {
    name: "audit-settings-switch-hover",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "accessibility");
      await h.hover('[role="switch"]');
      await h.idle();
      await h.shot("off-hover");
      await page.click('[role="switch"]');
      await h.idle();
      await park(page);
    },
  },

  // ---- Spaces ----
  {
    name: "audit-settings-spaces-grants",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {}, grants: { school: GRANTS.many, work: [{ id: "w1", from: "school", path: "syllabus.md", created: "2026-10-08T10:00:00Z", scope: "always" }] }, grantProblems: ['Grant 7 was ignored: "from" names a space that does not exist ("garden").', "Grant 8 was ignored: its path leaves the space (../../etc)."] },
    async run(page, h) {
      await openSettings(page, h, "spaces");
      await park(page);
      await h.shot("top");
      await h.hover(`${PANEL} [data-revoke]`);
      await h.idle();
      await h.shot("revoke-hover");
      await scrollPanel(page, "end");
      await park(page);
      await h.idle();
    },
  },
  {
    name: "audit-settings-spaces-error",
    sizes: WIDE,
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, fail: { grants_list: "grants.json: expected `,` or `]` at line 3 column 5" } },
    async run(page, h) {
      await openSettings(page, h, "spaces");
      await park(page);
      await h.idle();
    },
  },

  // ---- About ----
  {
    name: "audit-settings-about-copy",
    sizes: WIDE,
    mock: { settings: { ...SETTINGS, vaultPath: "/Users/someone-with-a-long-name/Library/Mobile Documents/com~apple~CloudDocs/Phaethon/default" }, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "about");
      await clickText(page, PANEL, "Copy path");
      await h.idle();
      await park(page);
      await h.shot("copied");
      await new Promise((r) => setTimeout(r, 4000));
      const still = await page.evaluate((p) => document.querySelector(p).innerText.includes("Copied"), PANEL);
      console.log(`     4 s after copying, the button still says Copied: ${still}`);
    },
  },

  // ---- Window chrome of the dialog ----
  {
    name: "audit-settings-close",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: { school: CONVERSATION } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await h.hover('button[aria-label="Close settings"]');
      await h.idle();
      await h.shot("close-hover");
      await page.focus('button[aria-label="Close settings"]');
      await page.keyboard.press("Shift");
      await h.idle();
      await h.shot("close-focused");
      await page.focus('[data-testid="settings-tab-agent"]');
      await page.keyboard.press("ArrowDown");
      await h.idle();
      await h.shot("tab-focused");
      await h.hover('[data-testid="settings-tab-spaces"]');
      await h.idle();
    },
  },
  {
    name: "audit-settings-load-error",
    sizes: WIDE,
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, fail: { settings_get: "settings.json: invalid type: string \"yes\", expected a boolean at line 4" } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await park(page);
      await h.idle();
    },
  },
];
