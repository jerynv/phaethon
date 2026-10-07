// Settings window scenarios: each section, a saved appearance applied at
// startup, and a behaviour check that a slider change applies and saves.

const settings = {
  backend: "phaethon",
  hasAnthropicKey: true,
  model: "claude-opus-5-5",
  appearance: {},
  vaultPath: "/Users/you/Phaethon/default",
  version: "0.1.0",
};

/** Opens Settings with the sidebar's button, or the title bar's when a narrow window hides the sidebar. Returns that button's test id. */
const open = async (page, h, tab) => {
  const opener = await page.evaluate(() => (document.querySelector('#spaces-sidebar:not([hidden]) [data-testid="open-settings"]') ? "open-settings" : "titlebar-settings"));
  await h.click('#spaces-sidebar:not([hidden]) [data-testid="open-settings"], header [data-testid="titlebar-settings"]');
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  if (tab) {
    await h.idle(); // let the open animation and initial focus settle
    await h.click(`[data-testid="settings-tab-${tab}"]`);
  }
  await h.idle();
  return opener;
};

const css = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

export default [
  {
    name: "settings-agent",
    mock: { settings: { ...settings, hasAnthropicKey: false } },
    run: (page, h) => open(page, h, "agent"),
  },
  {
    name: "settings-appearance",
    mock: { settings },
    run: (page, h) => open(page, h, "appearance"),
  },
  {
    name: "settings-appearance-scrolled",
    mock: { settings },
    async run(page, h) {
      await open(page, h, "appearance");
      await page.evaluate(() => document.querySelector('[role="tabpanel"]:not([hidden])')?.scrollBy(0, 99999));
      await h.idle();
    },
  },
  {
    name: "settings-accessibility",
    mock: { settings: { ...settings, appearance: { increaseContrast: "on", tokens: { "--ph-focus-width": "4px", "--ph-tracking-normal": "0.03em" } } } },
    run: (page, h) => open(page, h, "accessibility"),
  },
  {
    name: "settings-spaces",
    mock: { settings },
    run: (page, h) => open(page, h, "spaces"),
  },
  {
    name: "settings-about",
    mock: { settings },
    run: (page, h) => open(page, h, "about"),
  },
  {
    // A saved appearance in the vault must apply at startup, before Settings opens.
    name: "appearance-applied",
    mock: {
      threads: {},
      settings: { ...settings, appearance: { version: 1, theme: "dark", tokens: { "--ph-accent-h": 290, "--ph-text-scale": 1.25, "--ph-radius-scale": 1.6 } } },
    },
    async run(page, h) {
      await h.idle();
      const got = {
        accent: await css(page, "--ph-accent-h"),
        scale: await css(page, "--ph-text-scale"),
        radius: await css(page, "--ph-radius"),
        dark: await page.evaluate(() => document.documentElement.classList.contains("dark")),
      };
      console.log(`     appearance-applied: ${JSON.stringify(got)}`);
      if (got.accent !== "290" || got.scale !== "1.25" || got.radius !== "11.2px" || !got.dark) throw new Error(`saved appearance not applied: ${JSON.stringify(got)}`);
    },
  },
  {
    // Keyboard on the accent hue slider: the token changes live and appearance_set
    // receives the validated value after the save pause.
    name: "settings-behaviour",
    mock: { settings },
    async run(page, h) {
      const opener = await open(page, h, "appearance");
      const before = await css(page, "--ph-accent-h");
      const thumbs = await page.$$('[role="slider"]');
      let hue = null;
      for (const t of thumbs) {
        const label = await t.evaluate((el) => (el.getAttribute("aria-labelledby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent).join(" "));
        if (label.includes("Custom hue") && label.includes("Accent colour")) hue = t;
      }
      if (!hue) throw new Error("accent hue slider not found");
      await hue.focus();
      for (let i = 0; i < 10; i++) await page.keyboard.press("PageUp");
      const live = await css(page, "--ph-accent-h");
      const text = await hue.evaluate((el) => el.getAttribute("aria-valuetext"));
      await new Promise((r) => setTimeout(r, 900));
      const saves = await page.evaluate(() => window.__calls.filter(([c]) => c === "appearance_set").map(([, a]) => a.appearance));
      const last = saves.at(-1);
      console.log(`     hue before=${before} live=${live} valuetext="${text}" appearance_set calls=${saves.length} last=${JSON.stringify(last)}`);
      if (before !== "" && before === live) throw new Error("hue did not change");
      if (!last || last.tokens["--ph-accent-h"] !== Number(live)) throw new Error("appearance_set not called with the live value");
      if (saves.length !== 1) throw new Error(`expected one debounced save, got ${saves.length}`);
      // Reset puts it back, saves again, and keeps focus in the row. (Obscura does
      // not turn Enter on a button into a click, and a mouse click after the
      // panel scrolls lands at stale coordinates, so this uses element.click().)
      await page.$eval('button[aria-label^="Reset accent colour"]', (el) => { el.focus(); el.click(); });
      await new Promise((r) => setTimeout(r, 900));
      const focusAfterReset = await page.evaluate(() => document.activeElement?.getAttribute("role"));
      console.log(`     focus after reset: ${focusAfterReset}`);
      if (focusAfterReset !== "slider") throw new Error("focus was lost after Reset");
      const after = await css(page, "--ph-accent-h");
      const saves2 = await page.evaluate(() => window.__calls.filter(([c]) => c === "appearance_set").map(([, a]) => a.appearance));
      console.log(`     after reset: --ph-accent-h="${after}" last save=${JSON.stringify(saves2.at(-1))}`);
      if (after !== "168" && after !== "") throw new Error("reset did not restore the default");
      if ("--ph-accent-h" in saves2.at(-1).tokens) throw new Error("reset was not saved");
      // Escape closes and focus returns to the trigger.
      await page.keyboard.press("Escape");
      await h.idle();
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
      console.log(`     after Escape: dialog open=${!!(await page.$('[role="dialog"]'))} focus=${focused}`);
      if (focused !== opener) throw new Error(`focus did not return to the Settings button (${opener}); it is on ${focused}`);
    },
  },
];
