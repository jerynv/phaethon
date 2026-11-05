// Settings and words, persona round (T1–T7). Behaviour checks: each scenario
// fails unless the thing it names actually happens in the page.
//   t2-key-*       the key: Open Settings from a key error lands in the field;
//                  Check and save checks first and says each outcome plainly
//   t2-model       the model picker: readable names, Default, saves the id
//   t2-provider-summary  concise provider actions and useful file locations
//   t2-modal       aria-modal, inert background, no outside-click close, fixed size
//   t2-landmarks   no landmark clutter inside the window
//   t2-font        reading font reachable from Appearance; the stale promise is gone
//   t2-targets     slider thumbs, preset gaps, key buttons, Larger click targets,
//                  letter spacing below zero
//   t2-words       no jargon on any page
import { CONVERSATION, PANEL, SETTINGS, check, openSettings, park } from "../audit-fixtures.mjs";
import { openProviderConfiguration, closeProviderPopup, providerPopup } from "../provider-flow.mjs";

const NO_KEY = { ...SETTINGS, hasAnthropicKey: false };
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const rect = (page, sel) => page.$eval(sel, (el) => el.getBoundingClientRect().toJSON());
const css = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const panelText = (page) => page.evaluate((p) => document.querySelector(p)?.innerText ?? "", PANEL);

/** Type a key and submit with Enter, as a keyboard user does. */
async function submitKey(page, key) {
  await page.focus("[data-key-input]");
  await page.$eval("[data-key-input]", (i) => {
    i.select();
  });
  await page.keyboard.type(key);
  await page.keyboard.press("Enter");
}

const OUTCOMES = [
  { name: "format", keyCheck: null, key: "Linda1959!", says: "Use an Anthropic key starting with sk-ant-.", saved: false },
  { name: "rejected", keyCheck: { ok: false, problem: "rejected", message: "invalid x-api-key" }, key: "sk-ant-api03-deleted-key-xxxxxxxx", says: "Anthropic rejected this key.", saved: false },
  { name: "billing", keyCheck: { ok: false, problem: "billing", message: "credit balance too low" }, key: "sk-ant-api03-no-credit-xxxxxxxxxx", says: "Add Anthropic API credit", saved: true },
  { name: "network", keyCheck: { ok: false, problem: "network", message: "offline" }, key: "sk-ant-api03-offline-xxxxxxxxxxxx", says: "Couldn’t reach Anthropic.", saved: false },
  { name: "ok", keyCheck: null, key: "sk-ant-api03-works-xxxxxxxxxxxxxx", says: "API key saved.", saved: true },
];

export default [
  {
    // T4 / tomas6: from the chat's no-key error, Open Settings lands in the key field itself, in view.
    name: "t2-key-error-focus",
    mock: { settings: NO_KEY, threads: {}, sendError: { code: "noApiKey", message: "Add your Anthropic API key in Settings to start." } },
    async run(page, h) {
      await h.send("Can you help me keep a list of my pills?");
      await page.waitForSelector('[data-error-action="settings"]', { timeout: 5000 });
      await page.click('[data-error-action="settings"]');
      await page.waitForSelector("[data-key-input]", { timeout: 5000 });
      await page.waitForFunction(() => document.activeElement?.hasAttribute("data-key-input"), { timeout: 3000 }).catch(() => {});
      const got = await page.evaluate((p) => {
        const input = document.querySelector("[data-key-input]");
        const r = input.getBoundingClientRect();
        const pr = input.closest('[role="dialog"]').getBoundingClientRect();
        return { focused: document.activeElement === input, inView: r.top >= pr.top && r.bottom <= pr.bottom };
      }, PANEL);
      check(got.focused, "Open Settings from the key error focuses the key field", JSON.stringify(got));
      check(got.inView, "the key field is scrolled into view", JSON.stringify(got));
      // Only the page scrolls to it: the window itself (title, section list) never shifts.
      const shifted = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return [d.scrollTop, ...[...d.querySelectorAll("*")].filter((e) => e.scrollTop > 0 && !e.matches('[role="tabpanel"]')).map((e) => e.className.slice(0, 40))];
      });
      check(shifted.length === 1 && shifted[0] === 0, "the window's frame is not scrolled", JSON.stringify(shifted));
      await h.idle();
    },
  },
  ...OUTCOMES.map((o) => ({
    // T4 / linda3: the key is checked before it is saved, and each result is said in plain words at the field.
    name: `t2-key-${o.name}`,
    sizes: [[1100, 720]],
    mock: { settings: NO_KEY, threads: {}, keyCheck: o.keyCheck },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "anthropic");
      await submitKey(page, o.key);
      await page.waitForSelector("[data-key-outcome]", { timeout: 5000 });
      await h.idle();
      const got = await page.evaluate(() => {
        const line = document.querySelector("[data-key-outcome]");
        const input = document.querySelector("[data-key-input]");
        return {
          outcome: line.getAttribute("data-key-outcome"),
          text: line.textContent,
          invalid: input.getAttribute("aria-invalid"),
          describedByOutcome: (input.getAttribute("aria-describedby") ?? "").split(" ").includes(line.id),
          status: document.querySelector('[role="dialog"] p[role="status"]')?.textContent ?? "",
          focusInField: document.activeElement === input,
        };
      });
      const checks = await calls(page, "api_key_check");
      const sets = await calls(page, "api_key_set");
      console.log(`     ${o.name}: ${JSON.stringify({ ...got, checks: checks.length, sets: sets.length })}`);
      check(checks.length === 1 && checks[0].key === o.key, "the key is checked first (api_key_check, once)", JSON.stringify(checks));
      check(got.text.includes(o.says), `the result says "${o.says}"`, got.text);
      check(got.status.includes(o.says), "and the window's status line says it too", got.status);
      check(sets.length === (o.saved ? 1 : 0), o.saved ? "the key is saved" : "the key is NOT saved", `${sets.length}`);
      if (!o.saved) {
        check(got.invalid === "true" && got.describedByOutcome && got.focusInField, "the field is marked invalid, described by the result, and keeps focus", JSON.stringify(got));
      }
      if (o.name === "network") {
        await h.shot("result");
        await page.$$eval('[role="dialog"] button', (bs) => bs.find((b) => b.textContent.trim() === "Save without checking")?.click());
        await page.waitForSelector('[data-key-outcome="saved"]', { timeout: 5000 });
        const after = await calls(page, "api_key_set");
        check(after.length === 1, "Save without checking saves it", `${after.length}`);
      }
      await park(page);
    },
  })),
  {
    // T4 / dev9: a model picker with readable names; Default (recommended) is null.
    name: "t2-model",
    sizes: [[1100, 720], [760, 560]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "anthropic");
      await page.waitForSelector("[data-model-select] option:nth-child(3)", { timeout: 5000 });
      const opts = await page.$$eval("[data-model-select] option", (os) => os.map((o) => [o.value, o.textContent]));
      console.log(`     options: ${JSON.stringify(opts)}`);
      check(opts[0][1] === "Default (recommended): Claude Opus 5.5", "Default comes first, with the model's readable name", opts[0][1]);
      check(opts.every(([, t]) => !/claude-/.test(t)), "no option shows a raw model id");
      const label = await page.$eval("[data-model-select]", (s) => s.labels?.[0]?.textContent);
      check(label === "Default model", "the select is labelled Default model", label);
      await page.focus("[data-model-select]");
      await page.select("[data-model-select]", "claude-sonnet-5-5");
      await page.waitForFunction(() => window.__calls.some(([c]) => c === "settings_set_model"), { timeout: 3000 });
      await h.idle();
      let sets = await calls(page, "settings_set_model");
      check(sets.at(-1).model === "claude-sonnet-5-5", "choosing Sonnet saves its id", JSON.stringify(sets));
      const status = await page.evaluate(() => document.querySelector('[role="dialog"] p[role="status"]')?.textContent);
      check(status?.includes("Claude Sonnet 5.5"), "the change is announced by name", status);
      const shown = await page.$eval("[data-model-select]", (s) => s.value);
      check(shown === "claude-sonnet-5-5", "after the reload it still shows Sonnet", shown);
      await h.shot("sonnet");
      await page.select("[data-model-select]", "__default__");
      await h.idle();
      sets = await calls(page, "settings_set_model");
      check(sets.at(-1).model === null, "Default saves null (the core's default)", JSON.stringify(sets.at(-1)));
      await page.$eval("[data-model-select]", (s) => s.closest("[data-setting-row]")?.scrollIntoView({ block: "center" }));
      await park(page);
    },
  },
  {
    name: "t2-provider-summary",
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      const summary = await page.evaluate((panel) => {
        const el = document.querySelector(panel);
        const rows = [...el.querySelectorAll("[data-provider-row]")];
        return { rows: rows.length, add: !!el.querySelector("[data-provider-add]"), manage: !!el.querySelector('[data-provider-configure="anthropic"]'), fields: el.querySelectorAll("input, select").length, inlineDetail: !!el.querySelector("[data-provider-detail] [data-instance-name]"), keyFields: el.querySelectorAll("[data-key-input]").length, text: el.innerText,
          defaultFirst: rows[0]?.hasAttribute("data-provider-default-row"), defaults: el.querySelectorAll("[data-provider-default-row]").length,
          branded: rows.every((row) => row.querySelector("[data-provider-logo]") && (row.matches("button") ? 1 : row.querySelectorAll("button").length) === 1),
          masks: [...el.querySelectorAll("[data-provider-monochrome]")].map((mark) => getComputedStyle(mark).maskImage),
          inlineSwitch: !!el.querySelector("[data-provider-default], [data-backend], [data-assistant-default-manage]"),
        };
      }, PANEL);
      check(summary.rows > 0 && summary.add && summary.manage && summary.inlineDetail && summary.keyFields === 0, "Providers lists services beside inline CLI connection management", JSON.stringify(summary));
      check(summary.defaultFirst && summary.defaults === 1 && summary.branded && summary.inlineSwitch, "one branded row per provider, default first, with explicit separate configuration and default actions", JSON.stringify(summary));
      check(summary.masks.length > 0 && summary.masks.every((mask) => mask !== "none"), "monochrome brand artwork has a valid mask instead of a solid square", JSON.stringify(summary.masks.map((mask) => mask.slice(0, 50))));
      check(!/privacy policy|subscription|Nothing is sent|What is sent/.test(summary.text), "the provider list omits policy tutorials", summary.text);
      await park(page);
      await h.shot("agent");
      await h.click('[data-testid="settings-tab-about"]');
      await h.idle();
      const tab = await page.evaluate(() => document.querySelector('[role="dialog"] [role="tab"][data-state="active"]')?.textContent);
      check(tab === "About", "the About tab opens file locations", tab);
      const about = await panelText(page);
      for (const want of [SETTINGS.vaultPath, `${SETTINGS.vaultPath}/MANUAL.md`, "spaces/<space>/.phaethon/", "spaces/<space>/attachments/"]) {
        check(about.includes(want), `About lists: ${want}`);
      }
      check(!/privacy policy|Deleting a conversation|keeps its own copy/.test(about), "About keeps file locations concise", about);
      await park(page);
    },
  },
  {
    name: "t2-cli-summary",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: { ...SETTINGS, backend: "claude-cli" }, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      const text = await page.$eval('[data-provider-row="claude-cli"]', (el) => el.innerText);
      check(text.includes("Claude Code") && text.includes("Default"), "the Claude Code row identifies the current default", text);
      await openProviderConfiguration(page, "claude-cli");
      const setup = await page.$eval(providerPopup, (el) => el.innerText);
      check(setup.includes("Sign in to Claude Code") && !!await page.$('[data-cli-sign-in="claude"] [data-cli-sign-in-start]') && !setup.includes("terminal"), "Claude setup gives its official browser sign-in action", setup);
      check(!/privacy policy|keeps its own copy|subscription/.test(setup) && !(await page.$(`${providerPopup} [data-key-input]`)), "Claude setup omits policy tutorials and API-key fields", setup);
      check((await calls(page, "settings_set_backend")).length === 0, "managing Claude Code does not switch assistants");
      await park(page);
      await h.shot("agent");
      await closeProviderPopup(page, { keyboard: true });
      await h.click('[data-testid="settings-tab-about"]');
      await h.idle();
      const about = await panelText(page);
      check(about.includes("MANUAL.md") && !/keeps its own copy|privacy policy/.test(about), "About shows files without a CLI-history tutorial", about);
    },
  },
  {
    // T3 / maya5 jordan6 priya9: modal for real, only Escape/Close close it, and the window never changes size.
    name: "t2-modal",
    sizes: [[1100, 720], [760, 560]],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION } },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      const m = await page.evaluate(() => ({
        modal: document.querySelector('[role="dialog"]').getAttribute("aria-modal"),
        rootInert: document.getElementById("root").inert,
      }));
      check(m.modal === "true", "the dialog has aria-modal=true", JSON.stringify(m));
      check(m.rootInert, "the app behind it is inert", JSON.stringify(m));
      const before = await rect(page, '[role="dialog"]');
      const viewport = page.viewport();
      check(before.left >= 16 && before.top >= 16 && before.right <= viewport.width - 16 && before.bottom <= viewport.height - 16, "Settings keeps a visible margin around every side", JSON.stringify(before));
      // A click just outside the window (6 px off its left edge) does nothing.
      await page.mouse.click(before.left - 6, before.top + 40);
      await h.idle();
      check(!!(await page.$('[role="dialog"]')), "a click outside does not close Settings");
      // Text size to Largest, then every page: the window keeps its size.
      await page.$eval('[data-testid="settings-tab-accessibility"]', (el) => el.click());
      await h.idle();
      await page.$$eval("[data-preset]", (bs) => bs.find((b) => b.getAttribute("aria-label")?.startsWith("Largest"))?.click());
      await h.idle();
      const scale = await css(page, "--ph-text-scale");
      check(scale === "2", "the Largest preset applied", scale);
      for (const tab of ["agent", "appearance", "spaces", "about", "accessibility"]) {
        await page.$eval(`[data-testid="settings-tab-${tab}"]`, (el) => el.click());
        await h.idle();
        const r = await rect(page, '[role="dialog"]');
        check(Math.abs(r.width - before.width) < 1 && Math.abs(r.height - before.height) < 1, `on ${tab} the window is still ${Math.round(before.width)}x${Math.round(before.height)}`, `${r.width}x${r.height}`);
        check(Math.abs(r.left - before.left) < 1 && Math.abs(r.top - before.top) < 1, `on ${tab} the window keeps its position`, JSON.stringify(r));
      }
      await h.shot("largest-text");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
      await h.idle();
      const after = await page.evaluate(() => ({ rootInert: document.getElementById("root").inert, focus: document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName, sidebarShown: !!document.querySelector('#spaces-sidebar:not([hidden]) [data-testid="open-settings"]') }));
      check(!after.rootInert, "closing makes the app usable again", JSON.stringify(after));
      check(!!after.focus, "and focus is back on the Settings button", JSON.stringify(after));
    },
  },
  {
    // T3 / maya15: no unnamed banner per page, no region per group, no named form.
    name: "t2-landmarks",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: NO_KEY, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      for (const tab of ["agent", "appearance", "accessibility", "spaces", "about"]) {
        await page.$eval(`[data-testid="settings-tab-${tab}"]`, (el) => el.click());
        await h.idle();
        const found = await page.evaluate(() =>
          [...document.querySelectorAll('[role="dialog"] :is(header, footer, section[aria-labelledby], section[aria-label], aside, form[aria-label], form[aria-labelledby], [role="region"], [role="banner"], [role="complementary"])')].map((e) => e.outerHTML.slice(0, 80)),
        );
        check(found.length === 1 && found[0].startsWith('<header data-settings-header='), `${tab}: one dedicated header, no page-level landmarks inside the settings panel`, found.join(" | "));
      }
    },
  },
  {
    // T5 / priya4 linda13 priya10: the reading font is on Appearance too; the stale "More is coming" is gone.
    name: "t2-font",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      await h.click(`${PANEL} [data-reading-font] [role="combobox"]`);
      const choices = await page.$$eval('[role="option"] [data-font-preview]', (options) => options.map((option) => option.dataset.fontPreview));
      check(choices.length === 4, "Appearance offers four reading fonts in one Vic menu", choices.join());
      await h.click('[role="option"] [data-font-preview="lexend"]');
      await h.idle();
      check(await page.evaluate(() => document.documentElement.dataset.font === "lexend"), "choosing Lexend updates the whole app");
      await h.click('[data-testid="settings-tab-accessibility"]');
      check(await page.$eval(`${PANEL} [data-reading-font] [role="combobox"]`, (select) => select.textContent.includes("Lexend")), "Accessibility keeps the same saved font choice");
    },
  },
  {
    // T6 / jordan5 jordan10, T7 / jordan7 priya15.
    name: "t2-targets",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "accessibility");
      const thumbs = await page.$$eval('[role="slider"]', (ts) => ts.map((t) => {
        const target = t.getBoundingClientRect();
        const visible = t.querySelector('[data-slider-thumb-visual]').getBoundingClientRect();
        return { target: [target.width, target.height], visible: [visible.width, visible.height] };
      }));
      check(thumbs.length > 0 && thumbs.every(({ target: [w, hh] }) => w >= 24 && hh >= 24), "every slider has a transparent target of at least 24x24", JSON.stringify(thumbs));
      check(thumbs.every(({ visible: [w, hh] }) => w <= 16 && hh <= 16), "the visible slider thumbs stay thin", JSON.stringify(thumbs));
      const labelAlignment = await page.$eval('[data-token="--ph-text-scale"]', (row) => {
        const label = row.firstElementChild.firstElementChild.getBoundingClientRect();
        const value = row.querySelector('output').getBoundingClientRect();
        return Math.abs((label.top + label.height / 2) - (value.top + value.height / 2));
      });
      check(labelAlignment <= 6, "Text size aligns with its slider and value rather than the preset block", String(labelAlignment));
      await h.shot("default-targets");
      const slider = await page.waitForSelector('[role="slider"]');
      await slider.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const hit = await slider.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const x = box.left + 2;
        const y = box.top + box.height / 2;
        return { x, y, own: document.elementFromPoint(x, y)?.closest('[role="slider"]') === element, value: element.getAttribute('aria-valuenow') };
      });
      check(hit.own, "the transparent area outside the small visible circle receives pointer input", JSON.stringify(hit));
      await page.mouse.click(hit.x, hit.y);
      check(await slider.evaluate((element, value) => document.activeElement === element && element.getAttribute('aria-valuenow') === value, hit.value), "clicking the transparent thumb area focuses without stepping the value");
      await page.keyboard.press("ArrowRight");
      check(await slider.evaluate((element, value) => element.getAttribute('aria-valuenow') !== value, hit.value), "the same thumb remains operable with arrow keys");
      await page.keyboard.press("ArrowLeft");
      const presets = await page.$$eval("[data-preset]", (bs) => bs.map((b) => b.getBoundingClientRect().toJSON()));
      const gaps = presets.slice(1).map((r, i) => (Math.abs(r.top - presets[i].top) < 2 ? r.left - presets[i].right : 99));
      check(gaps.every((g) => g >= 4), "text-size presets are at least 4px apart", JSON.stringify(gaps));
      check(presets.every((r) => r.height >= 28), "and at least 28px tall", JSON.stringify(presets.map((r) => r.height)));
      // Letter spacing goes slightly below zero.
      const spacing = await page.evaluateHandle(() => [...document.querySelectorAll('[role="slider"]')].find((t) => (t.getAttribute("aria-labelledby") ?? "").split(" ").some((id) => document.getElementById(id)?.textContent === "Letter spacing")));
      await spacing.focus();
      await page.keyboard.press("Home");
      await h.idle();
      const vt = await spacing.evaluate((t) => t.getAttribute("aria-valuetext"));
      check(vt === "Tighter (−2%)" && (await css(page, "--ph-tracking-normal")) === "-0.02em", "letter spacing reaches −2%", `${vt} ${await css(page, "--ph-tracking-normal")}`);
      await page.keyboard.press("End");
      // Larger click targets.
      const sw = await page.evaluateHandle(() => [...document.querySelectorAll('[role="switch"]')].find((s) => s.labels?.[0]?.textContent === "Larger click targets"));
      check(!!(await sw.evaluate((s) => !!s)), "Accessibility has a Larger click targets switch");
      await sw.evaluate((s) => s.scrollIntoView({ block: "center" }));
      await sw.focus();
      await page.keyboard.press("Space");
      await h.idle();
      const big = await page.evaluate(() => ({
        target: getComputedStyle(document.documentElement).getPropertyValue("--ph-target-min").trim(),
        close: document.querySelector('[aria-label="Close settings"]').getBoundingClientRect().toJSON(),
        tab: document.querySelector('[data-testid="settings-tab-agent"]').getBoundingClientRect().height,
        thumb: document.querySelector('[role="slider"]').getBoundingClientRect().width,
        visibleThumb: document.querySelector('[data-slider-thumb-visual]').getBoundingClientRect().width,
      }));
      console.log(`     larger targets: ${JSON.stringify(big)}`);
      check(big.target === "44px", "Larger click targets sets --ph-target-min to 44px", big.target);
      check(big.close.width >= 44 && big.close.height >= 44 && big.tab >= 44, "the Close button and tabs grow to 44px", JSON.stringify(big));
      check(big.thumb >= 44 && big.visibleThumb <= 16, "larger targets expand the transparent slider hitbox while retaining the small visible thumb", JSON.stringify(big));
      await new Promise((r) => setTimeout(r, 900));
      const saved = (await calls(page, "appearance_set")).at(-1)?.appearance?.tokens ?? {};
      check(saved["--ph-target-size"] === 44, "the choice is saved with the appearance", JSON.stringify(saved));
      await park(page);
      await h.shot("large-targets");
      // Remove / Keep key: default size and well apart.
      await page.$eval('[data-testid="settings-tab-agent"]', (el) => el.click());
      await h.idle();
      await openProviderConfiguration(page, "anthropic");
      await page.$$eval('[role="dialog"] button', (bs) => bs.find((b) => b.textContent.trim() === "Remove saved key…")?.click());
      await h.idle();
      const pair = await page.$$eval('[role="dialog"] [role="group"] button', (bs) => bs.map((b) => b.getBoundingClientRect().toJSON()));
      const apart = pair.length === 2 ? Math.max(pair[1].left - pair[0].right, pair[1].top - pair[0].bottom) : -1;
      check(apart >= 8 && pair.every((r) => r.height >= 28), "Keep key and Remove key are at least 8px apart and full size", JSON.stringify({ apart, h: pair.map((r) => r.height) }));
      await page.evaluate(() => document.activeElement.scrollIntoView({ block: "center" }));
      await park(page);
    },
  },
  {
    // T1 / linda9 priya7: no jargon on any page.
    name: "t2-words",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: NO_KEY, threads: {}, grants: { school: [{ id: "g1", from: "work", path: "calendar", created: "2026-10-08T10:00:00Z", scope: "always" }] } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      const JARGON = /\bvaults?\b|\bgrants?\b|\brevok|\bbackend\b|(?<!\()\bkeychain\b|claude-[a-z]+-\d|\.phaethon\/settings\.json(?! inside it)/i;
      for (const tab of ["agent", "appearance", "accessibility", "spaces", "about"]) {
        await page.$eval(`[data-testid="settings-tab-${tab}"]`, (el) => el.click());
        await h.idle();
        const text = await page.evaluate(() => {
          const d = document.querySelector('[role="dialog"]');
          const labels = [...d.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label"));
          return `${d.innerText}\n${labels.join("\n")}`;
        });
        const hits = text.split("\n").filter((l) => JARGON.test(l));
        check(hits.length === 0, `${tab}: no jargon (vault, grant, revoke, backend, keychain, model ids)`, hits.join(" | "));
      }
      const tabs = await page.$$eval('[role="dialog"] [role="tab"]', (ts) => ts.map((t) => t.textContent));
      check(tabs[0] === "Providers", "the first section is called Providers", tabs.join());
    },
  },
];
