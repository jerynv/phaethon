// Reading font (Settings > Accessibility): choosing a font by keyboard applies
// it to the whole app, saves it, and a saved choice applies at startup.

const settings = {
  backend: "phaethon",
  hasAnthropicKey: true,
  model: "claude-opus-5-5",
  appearance: {},
  vaultPath: "/Users/you/Phaethon/default",
  version: "0.1.0",
};
const conversation = [
  { role: "user", text: "What is due this week for C241?", attachments: [] },
  { role: "assistant", text: "Two things: **Problem set 4** on Wednesday, and *Test 1* on Thursday. Want a study plan?", attachments: [] },
];
const check = (ok, what, got) => {
  if (!ok) throw new Error(`check failed: ${what} (${got})`);
  console.log(`     check: ${what}`);
};
const bodyFont = (page) => page.evaluate(() => getComputedStyle(document.body).fontFamily);

export default [
  {
    name: "reading-font-pick",
    mock: { settings, threads: { school: conversation } },
    async run(page, h) {
      await h.click('#spaces-sidebar:not([hidden]) [data-testid="open-settings"], header [data-testid="titlebar-settings"]');
      await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
      await h.idle();
      await h.click('[data-testid="settings-tab-accessibility"]');
      await page.waitForSelector("[data-font-card]", { timeout: 5000 });
      check((await bodyFont(page)).includes("Atkinson"), "the default reading font is Atkinson Hyperlegible", await bodyFont(page));
      // Keyboard: focus the checked card, one arrow moves and chooses.
      await page.focus('[data-font-card="atkinson"]');
      await page.keyboard.press("ArrowRight");
      await h.idle();
      const picked = await page.evaluate(() => ({
        attr: document.documentElement.dataset.font ?? null,
        checked: document.querySelector('[data-font-card][data-state="checked"]')?.getAttribute("data-font-card"),
        focused: document.activeElement?.getAttribute("data-font-card"),
      }));
      check(picked.attr === "opendyslexic" && picked.checked === "opendyslexic" && picked.focused === "opendyslexic", "one arrow key moves to OpenDyslexic and chooses it", JSON.stringify(picked));
      check((await bodyFont(page)).includes("OpenDyslexic"), "the whole app now reads in OpenDyslexic", await bodyFont(page));
      await page.evaluate(() => document.fonts.ready);
      const loaded = await page.evaluate(() => document.fonts.check('16px "OpenDyslexic"'));
      check(loaded, "the OpenDyslexic font file actually loaded", String(loaded));
      await new Promise((r) => setTimeout(r, 900)); // saves are debounced
      const saved = await page.evaluate(() => window.__calls.filter((c) => c[0] === "appearance_set").map((c) => c[1].appearance.readingFont).pop());
      check(saved === "opendyslexic", "the choice is saved to the vault", String(saved));
      await h.idle();
    },
  },
  ...["opendyslexic", "lexend", "system"].map((font) => ({
    name: `reading-font-applied-${font}`,
    mock: { settings: { ...settings, appearance: { version: 1, readingFont: font, tokens: {} } }, threads: { school: conversation } },
    async run(page, h) {
      await h.waitText("Problem set 4");
      await page.evaluate(() => document.fonts.ready);
      const attr = await page.evaluate(() => document.documentElement.dataset.font);
      check(attr === font, `a saved ${font} choice applies at startup`, String(attr));
      await h.idle();
    },
  })),
];
