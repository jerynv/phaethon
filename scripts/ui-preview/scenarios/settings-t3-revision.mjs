import { PANEL, SETTINGS, check, openSettings } from "../audit-fixtures.mjs";

export default [
  {
    name: "settings-vic-flat-switches",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "accessibility");
      const tracks = await page.$$eval(`${PANEL} [data-switch]`, items => items.map(el => ({ shadow: getComputedStyle(el).boxShadow, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
      check(tracks.length > 1 && tracks.every(t => t.shadow === "none" && t.width > t.height), "flat switches remove track rims and retain pill geometry", JSON.stringify(tracks));
      const contrast = await page.$$eval(`${PANEL} .ui-switch-flat[aria-checked="false"]`, items => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        const luminance = color => {
          context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
          const channels = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
          return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
        };
        return items.map(track => {
          const knob = luminance(getComputedStyle(track.querySelector(".ui-switch-knob")).backgroundColor);
          const fill = luminance(getComputedStyle(track).backgroundColor);
          let parent = track.parentElement;
          while (parent && getComputedStyle(parent).backgroundColor === "rgba(0, 0, 0, 0)") parent = parent.parentElement;
          const surface = luminance(getComputedStyle(parent ?? document.body).backgroundColor);
          const ratio = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
          return { knob: ratio(knob, fill), track: ratio(fill, surface) };
        });
      });
      check(contrast.length > 0 && contrast.every(value => value.knob >= 3 && value.track >= 3), "off-state knob and rimless track remain identifiable", JSON.stringify(contrast));
      await h.shot("flat-off");
      const selector = `${PANEL} [data-switch]`;
      const before = await page.$eval(selector, el => el.getAttribute("aria-checked"));
      await page.focus(selector);
      await page.keyboard.press("Space");
      check(await page.$eval(selector, el => el.getAttribute("aria-checked")) !== before, "flat variant retains keyboard toggling");
    },
  },
  {
    name: "settings-t3-appearance-hierarchy",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      const hierarchy = await page.$eval(PANEL, (panel) => ({
        page: parseFloat(getComputedStyle(panel.querySelector('[data-section-header] h3')).fontSize),
        section: parseFloat(getComputedStyle(panel.querySelector('[data-settings-group] h4')).fontSize),
        sectionWeight: parseFloat(getComputedStyle(panel.querySelector('[data-settings-group] h4')).fontWeight),
        labelWeight: parseFloat(getComputedStyle(panel.querySelector('[data-setting-row] > div:first-child > :is(label, span)')).fontWeight),
        label: parseFloat(getComputedStyle(panel.querySelector('[data-setting-row] > div:first-child > :is(label, span)')).fontSize),
        themes: [...panel.querySelectorAll('[data-theme-preview]')].map((preview) => { const box = preview.getBoundingClientRect(); return box.width / box.height; }),
        nativeFont: !!panel.querySelector('[data-reading-font] select'),
      }));
      check(hierarchy.page > hierarchy.section && hierarchy.section >= hierarchy.label && hierarchy.sectionWeight > hierarchy.labelWeight, "page, group and control labels form a clear type hierarchy", JSON.stringify(hierarchy));
      check(hierarchy.themes.every((ratio) => ratio > 2.4 && ratio < 2.6), "theme previews share a deliberate wide ratio", JSON.stringify(hierarchy.themes));
      check(!hierarchy.nativeFont, "the reading font uses Vic's drawn select");
      await h.shot("appearance");
      await page.$$eval(`${PANEL} summary`, (items) => { const advanced = items.find((item) => item.textContent.includes("Advanced appearance")); advanced.click(); advanced.scrollIntoView({ block: "start" }); });
      const disclosureGap = await page.$eval(`${PANEL} details[open]`, (details) => details.querySelector("h4").getBoundingClientRect().top - details.querySelector("summary").getBoundingClientRect().bottom);
      check(disclosureGap >= 0 && disclosureGap <= 24, "advanced controls start directly below their disclosure", String(disclosureGap));
      const sliders = await page.$$eval(`${PANEL} [data-slider-track]`, (items) => items.map((item) => item.getBoundingClientRect().height));
      check(sliders.every((height) => height <= 5), "appearance tracks stay visually thin", JSON.stringify(sliders));
      await h.shot("advanced");
    },
  },
  {
    name: "settings-t3-usage-destination",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: { ...SETTINGS, backend: "codex-cli" }, threads: {}, instanceUsage: { codex: { available: true, windows: [{ label: "Session", usedPercent: 23, resetsAt: 1793836800 }], reason: null } } },
    async run(page, h) {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("phaethon:open-usage")));
      await page.waitForSelector('[data-usage-dialog]');
      await page.waitForFunction(() => document.querySelector('[data-instance-usage]')?.textContent.includes("23% used"));
      const data = await page.$eval('[data-usage-dialog]', (dialog) => ({
        usage: dialog.querySelector('[data-instance-usage]').textContent,
        settings: !!document.querySelector('[data-settings-header]'),
        own: dialog.getBoundingClientRect().toJSON(),
        width: innerWidth,
      }));
      check(!data.settings && data.usage.includes("Session") && data.usage.includes("Resets"), "usage opens independently and displays actual limits", JSON.stringify(data));
      check(data.own.width < data.width && data.own.x >= 0, "usage remains a compact contained dialog", JSON.stringify(data.own));
      await h.shot("usage");
    },
  },
  {
    name: "settings-t3-add-row",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      const row = await page.waitForSelector('[data-provider-add]', { visible: true });
      await row.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const box = await row.boundingBox();
      await page.mouse.click(box.x + box.width - 14, box.y + box.height / 2);
      await page.waitForSelector('[data-provider-catalog]');
      await page.click('[data-provider-catalog-select="claude-cli"]');
      await page.waitForSelector('[role="dialog"] [data-instance-name]');
      check(await page.$eval('[data-instance-name]', (input) => input.value === ""), "the compact Add connection action opens a fresh configuration");
      check(!(await page.$('[data-instance-usage]')), "new connection setup does not include usage");
      check(!(await page.$('[data-agent-instance-popup] details[open]')), "optional launch settings do not overwhelm connection creation");
      await h.shot("add-connection");
    },
  },
];
