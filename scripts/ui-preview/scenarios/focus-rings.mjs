import { PANEL, SETTINGS, check, clickText, openSettings, park } from "../audit-fixtures.mjs";
import { closeProviderPopup, openProviderConfiguration } from "../provider-flow.mjs";

const shown = "[data-space-pane][data-shown]";
const composer = `${shown} [data-composer-input]`;
const frame = `${shown} [data-composer]`;
const toggle = '[data-token="--ph-focus-rings"] [role="switch"]';
const width = '[data-token="--ph-focus-width"]';
const key = '[data-provider-popup] [data-key-input]';
const submit = '[data-provider-popup] form button[type="submit"]';
const sizes = [[1100, 720], [640, 480]];

async function click(page, selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 4000 });
  await page.$eval(selector, (element) => element.scrollIntoView({ block: "center" }));
  await page.click(selector);
}

async function rings(page, enabled) {
  await page.waitForFunction((value) => document.documentElement.dataset.focusRings === value, { timeout: 4000 }, enabled ? "on" : "off");
}

async function appearanceSaved(page, enabled) {
  await page.waitForFunction((enabled) => {
    const appearance = window.__calls.filter(([command]) => command === "appearance_set").at(-1)?.[1].appearance;
    return !!appearance && (appearance.tokens?.["--ph-focus-rings"] === 1) === enabled;
  }, { timeout: 5000 }, enabled);
  return page.evaluate(() => window.__calls.filter(([command]) => command === "appearance_set").at(-1)[1].appearance);
}

async function outline(page, selector) {
  return page.$eval(selector, (element) => {
    const style = getComputedStyle(element);
    return { focused: document.activeElement === element, visible: element.matches(":focus-visible"), style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
}

const absent = (paint) => paint.style === "none" || paint.width === 0;
const settings = (tokens = {}) => ({ ...SETTINGS, appearance: { tokens } });

export default [
  {
    name: "focus-rings-default-off",
    sizes,
    sizesRequired: true,
    mock: { settings: { ...settings(), hasAnthropicKey: false }, threads: {}, keyCheck: { ok: false, problem: "format", message: "That isn’t an Anthropic API key." } },
    async run(page, h) {
      await rings(page, false);
      await click(page, composer);
      const typing = await outline(page, composer);
      check(typing.focused && absent(typing) && absent(await outline(page, frame)), "clicking the composer keeps text focus without outlining the input or frame", JSON.stringify(typing));

      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "anthropic");
      await click(page, key);
      check((await outline(page, key)).focused && absent(await outline(page, key)), "pointer-focused settings fields have no ring by default");
      await park(page);
      const normal = await page.$eval(submit, (button) => ({ rim: getComputedStyle(button).backgroundImage, face: getComputedStyle(button.querySelector(".ui-button-face")).backgroundImage, border: parseFloat(getComputedStyle(button).borderWidth) }));
      await page.focus(key);
      await page.keyboard.press("Tab");
      const keyboard = await outline(page, submit);
      check(keyboard.focused && keyboard.visible && absent(keyboard), "Tab still moves focus to the next control while its ring stays off", JSON.stringify(keyboard));
      const focused = await page.$eval(submit, (button) => ({ rim: getComputedStyle(button).backgroundImage, face: getComputedStyle(button.querySelector(".ui-button-face")).backgroundImage, border: parseFloat(getComputedStyle(button).borderWidth) }));
      check(normal.rim !== "none" && normal.face !== "none" && normal.border > 0 && JSON.stringify(normal) === JSON.stringify(focused), "hiding focus rings preserves the button's rim and face", JSON.stringify(focused));

      await page.type(key, "not-an-api-key");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-key-outcome="format"]', { timeout: 4000 });
      const error = await page.$eval(key, (input) => ({ invalid: input.getAttribute("aria-invalid"), focused: document.activeElement === input }));
      check(error.invalid === "true" && error.focused && absent(await outline(page, key)), "validation still marks the field and returns focus without enabling a ring", JSON.stringify(error));
      await closeProviderPopup(page);
      await page.keyboard.press("Escape");
      await h.idle();
      check(!(await page.$('[role="dialog"]:has([data-settings-header])')) && await page.evaluate(() => !document.getElementById("root").inert && document.activeElement?.matches('[data-testid="open-settings"], [data-testid="titlebar-settings"]')), "Escape restores the original Settings control and releases the page");
    },
  },
  {
    name: "focus-rings-toggle-and-save",
    sizes,
    sizesRequired: true,
    mock: { settings: settings({ "--ph-focus-width": "4px" }), threads: {} },
    async run(page, h) {
      await openSettings(page, h, "accessibility");
      await rings(page, false);
      check(await page.$eval(toggle, (control) => control.getAttribute("aria-checked") === "false") && !(await page.$(width)), "the switch starts off and the unused thickness control is hidden");
      await click(page, toggle);
      await rings(page, true);
      await page.waitForSelector(width, { visible: true, timeout: 4000 });
      const saved = await appearanceSaved(page, true);
      check(saved.tokens["--ph-focus-width"] === "4px", "enabling rings retains the previously saved thickness", JSON.stringify(saved.tokens));
      const cached = await page.evaluate(() => JSON.parse(localStorage.getItem("phaethon.appearance.v1")));
      check(cached.tokens["--ph-focus-rings"] === 1, "the enabled preference is cached for the next startup");

      await click(page, '[data-testid="settings-tab-agent"]');
      await openProviderConfiguration(page, "anthropic");
      await page.focus(key);
      await page.keyboard.press("Shift");
      const enabled = await outline(page, key);
      check(enabled.focused && enabled.style === "solid" && enabled.width === 4, "the enabled preference paints the saved ring on another settings field", JSON.stringify(enabled));
      await closeProviderPopup(page);
      await click(page, '[data-testid="settings-tab-accessibility"]');
      await click(page, toggle);
      await rings(page, false);
      const off = await appearanceSaved(page, false);
      check(!("--ph-focus-rings" in off.tokens) && off.tokens["--ph-focus-width"] === "4px", "turning rings off saves the default without losing the thickness", JSON.stringify(off.tokens));
      check(!(await page.$(width)), "the thickness preview disappears when rings are off");
      await page.keyboard.press("Escape");
      await h.idle();
      await click(page, composer);
      check(absent(await outline(page, composer)) && absent(await outline(page, frame)), "the off preference also applies back in Chat");
      await openSettings(page, h, "accessibility");
      check(await page.$eval(toggle, (control) => control.getAttribute("aria-checked") === "false"), "reopening Settings retains the off choice");
    },
  },
  {
    name: "focus-rings-saved-reset-undo",
    sizes,
    sizesRequired: true,
    mock: { settings: settings({ "--ph-focus-rings": 1, "--ph-focus-width": "4px" }), threads: {} },
    async run(page, h) {
      await rings(page, true);
      await openSettings(page, h, "accessibility");
      check(await page.$eval(toggle, (control) => control.getAttribute("aria-checked") === "true") && !!(await page.$(width)), "a saved enabled preference restores the switch and thickness control");
      await click(page, 'button[aria-label="Reset accessibility to defaults"]');
      await rings(page, false);
      const reset = await appearanceSaved(page, false);
      check(!("--ph-focus-rings" in reset.tokens) && !("--ph-focus-width" in reset.tokens) && !(await page.$(width)), "reset restores the default off state and clears thickness overrides", JSON.stringify(reset.tokens));
      await clickText(page, PANEL, "Undo reset");
      await rings(page, true);
      const restored = await appearanceSaved(page, true);
      check(restored.tokens["--ph-focus-width"] === "4px" && await page.$eval(toggle, (control) => control.getAttribute("aria-checked") === "true"), "Undo restores both ring visibility and its saved thickness", JSON.stringify(restored.tokens));
    },
  },
];
