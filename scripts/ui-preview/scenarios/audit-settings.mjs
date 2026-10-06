// Audit: the settings window. Every section top and bottom at three window
// sizes; the API key in each state; the backend switch; theme cards; swatch
// focus; a hue slider mid-drag; a changed control, its Reset and the section's
// Undo reset; every accessibility switch on; Spaces with grants, with
// grants.json problems, with none, and failing; About's copy feedback.
import { CONVERSATION, GRANTS, PANEL, SETTINGS, activeDesc, check, clickText, openSettings, park, scrollPanel } from "../audit-fixtures.mjs";

const SIZES3 = [[1100, 720], [760, 560], [640, 480]];
const WIDE = [[1100, 720]];
const SECTIONS = ["agent", "appearance", "accessibility", "spaces", "about"];

/**
 * Click a button by its visible text with element.click(): after a panel
 * scrolls, Obscura's mouse lands at stale coordinates (and can hit the overlay).
 */
const press = async (page, text) => {
  const ok = await page.evaluate((scope, text) => {
    const b = [...document.querySelectorAll(`${scope} button`)].find((x) => x.textContent.trim() === text);
    b?.focus();
    b?.click();
    return !!b;
  }, PANEL, text);
  if (!ok) throw new Error(`no button "${text}"`);
};

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

  {
    // Measured, not eyeballed: in every section (with the Remove confirm open
    // on Agent), nothing pokes out of the window sideways, no control's text
    // is wider than its box, and nothing focusable sits under the Close button.
    // Run with --scale 2 to check large text.
    name: "audit-settings-fit",
    sizes: SIZES3,
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, grants: { school: GRANTS.two } },
    async run(page, h) {
      await openSettings(page, h);
      for (const tab of SECTIONS) {
        await page.$eval(`[data-testid="settings-tab-${tab}"]`, (el) => el.click());
        await h.idle();
        if (tab === "agent") {
          await press(page, "Remove saved key…");
          await h.idle();
        }
        const bad = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          const d = dialog.getBoundingClientRect();
          const close = dialog.querySelector('button[aria-label="Close settings"]').getBoundingClientRect();
          const out = [];
          const name = (el) => `${el.tagName.toLowerCase()}[${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}]`;
          for (const el of dialog.querySelectorAll("*")) {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            if (r.right > d.right + 1 || r.left < d.left - 1) out.push(`spills sideways: ${name(el)} ${Math.round(r.left)}..${Math.round(r.right)} vs ${Math.round(d.left)}..${Math.round(d.right)}`);
            if (el.matches("button, [role=radio], [role=switch], [role=tab]") && el.scrollWidth > el.clientWidth + 1) out.push(`text wider than its control: ${name(el)} ${el.scrollWidth}>${el.clientWidth}`);
            if (el.matches('button:not([aria-label="Close settings"]), input, [role=slider], [role=radio], [role=switch], [role=tab], a, h3') && !el.closest('[role="tabpanel"][hidden]')) {
              const hit = r.left < close.right && r.right > close.left && r.top < close.bottom && r.bottom > close.top;
              // Only what is scrolled to the top matters; the panel scrolls under the corner.
              if (hit && el.closest('[role="tabpanel"]')?.scrollTop === 0) out.push(`under Close: ${name(el)}`);
            }
          }
          return [...new Set(out)].slice(0, 12);
        });
        check(bad.length === 0, `${tab}: fits, nothing under Close`, bad.join("; "));
      }
    },
  },

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
      await press(page, "Save key");
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
      await press(page, "Save key");
      await h.idle();
      await park(page);
      const got = await page.evaluate(() => {
        const input = document.querySelector('input[type="password"]');
        const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
        return {
          banner: document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? "",
          invalid: input.getAttribute("aria-invalid"),
          described: ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" | "),
          focused: document.activeElement === input,
        };
      });
      console.log(`     key error: ${JSON.stringify(got)}`);
      check(!got.banner, "a rejected key is not shown in the window banner", got.banner);
      check(got.invalid === "true", "the key field is marked invalid");
      check(got.described.includes("look like an Anthropic API key"), "the field is described by the backend's message", got.described);
      check(got.focused, "focus is back in the key field");
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
      await press(page, "Save key");
      await h.idle();
      await park(page);
      const got = await page.evaluate(() => {
        const btn = document.querySelector('[role="dialog"] form button[type="submit"]');
        return { text: btn?.textContent, ariaDisabled: btn?.getAttribute("aria-disabled"), readOnly: document.querySelector('input[type="password"]').hasAttribute("readonly") };
      });
      console.log(`     while saving: ${JSON.stringify(got)}`);
      check(got.text === "Saving…" && got.ariaDisabled === "true", "Save key shows Saving… and is aria-disabled while it runs", JSON.stringify(got));
      check(got.readOnly, "the key field is read-only while saving");
      // A second press (click or Enter) while pending sends nothing more.
      await page.$eval('[role="dialog"] form button[type="submit"]', (b) => b.click());
      await page.$eval('input[type="password"]', (i) => i.form.requestSubmit());
      await h.idle();
      const sets = await page.evaluate(() => window.__calls.filter(([c]) => c === "api_key_set").length);
      check(sets === 1, "only one api_key_set while pending", `${sets}`);
    },
  },
  {
    name: "audit-settings-key-saved",
    sizes: WIDE,
    mock: { settings: { ...SETTINGS, hasAnthropicKey: false }, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.type('input[type="password"]', "sk-ant-api03-xxxxxxxxxxxxxxxx");
      await press(page, "Save key");
      await h.waitText("A key is saved");
      await park(page);
      await h.idle();
      const status = await page.evaluate(() => document.querySelector('[role="dialog"] p[role="status"]')?.textContent);
      console.log(`     after save, status: ${status}; focus: ${await activeDesc(page)}`);
      const line = await page.evaluate(() => document.querySelector('[role="dialog"] form')?.innerText.includes("Saved to this computer’s keychain."));
      check(line, "a visible saved line sits next to the key field");
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
      await openSettings(page, h, "accessibility");
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
      await page.$eval('[role="switch"]', (el) => el.click());
      await scrollPanel(page, 0);
      await h.idle();
      await page.click('button[aria-label="Reset accessibility to defaults"]');
      await h.idle();
      await page.keyboard.press("Shift");
      await h.idle();
      await h.shot("undo-reset");
      await clickText(page, PANEL, "Undo reset");
      await h.idle();
      const back = await page.evaluate(() => ({
        scale: getComputedStyle(document.documentElement).getPropertyValue("--ph-text-scale").trim(),
        focus: document.activeElement?.textContent?.trim(),
      }));
      check(back.scale !== "" && back.scale !== "1", "Undo reset brings the text size back", JSON.stringify(back));
      check(back.focus?.startsWith("Reset accessibility"), "focus stays on the page's Reset button after Undo", back.focus);
      await park(page);
    },
  },
  {
    name: "audit-settings-quickpicks",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "accessibility");
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
    // ARIA radio pattern: an arrow key moves focus AND checks the new radio,
    // in each direction, wrapping; the group is one tab stop.
    name: "audit-settings-radio-keys",
    sizes: WIDE,
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      const state = (sel) =>
        page.evaluate((s) => [...document.querySelectorAll(s)].map((r) => `${r.textContent.trim()}:${r.getAttribute("aria-checked")}${r === document.activeElement ? "(focus)" : ""}`).join(" "), sel);
      for (const group of ["Theme", "Accent colour", "Surface tint"]) {
        const sel = `[role="radiogroup"][aria-label="${group}"] [role="radio"]`;
        if (!(await page.$(sel))) throw new Error(`no radio group "${group}"`);
        // Radix keeps a roving tabindex: at most one radio is tabbable (before
        // the group is first visited, the group element itself is the stop).
        const tabStops = await page.evaluate((s) => [...document.querySelectorAll(s)].filter((r) => r.getAttribute("tabindex") === "0").length, sel);
        check(tabStops <= 1, `${group}: at most one tabbable radio`, `${tabStops}`);
        await page.evaluate((s) => ([...document.querySelectorAll(s)].find((r) => r.getAttribute("aria-checked") === "true") ?? document.querySelector(s)).focus(), sel);
        for (const key of ["ArrowRight", "ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"]) {
          await page.keyboard.press(key);
          await h.idle();
          const s = await state(sel);
          check(/:true\(focus\)/.test(s), `${group}: ${key} moves focus and checks`, s);
        }
        // Wrap: Left from the first radio lands on the last, checked.
        await page.evaluate((s) => document.querySelector(s).focus(), sel);
        await page.keyboard.press("ArrowLeft");
        await h.idle();
        const last = await page.evaluate((s) => {
          const l = [...document.querySelectorAll(s)].at(-1);
          return l === document.activeElement && l.getAttribute("aria-checked") === "true";
        }, sel);
        check(last, `${group}: ArrowLeft on the first wraps to the last and checks it`);
        const after = await page.evaluate((s) => [...document.querySelectorAll(s)].filter((r) => r.getAttribute("tabindex") === "0").length, sel);
        check(after === 1, `${group}: after moving, exactly one radio is tabbable`, `${after}`);
        // One stop: Tab from the chosen radio leaves the group.
        await page.evaluate(() => (window.__beforeTab = document.activeElement));
        await page.keyboard.press("Tab");
        const tab = await page.evaluate((s) => ({ moved: document.activeElement !== window.__beforeTab, inGroup: !!document.activeElement?.matches(s) }), sel);
        if (!tab.moved) console.log(`     note: Tab did not move focus here (an Obscura quirk); "${group}: Tab leaves the group" needs the Chromium run`);
        else check(!tab.inGroup, `${group}: Tab leaves the group in one press`);
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
      const text = await page.evaluate((p) => document.querySelector(p).innerText, PANEL);
      const raw = text.split("expected `,`").length - 1;
      check(text.includes("Fix line 3"), "one file-level message names the line", text.slice(0, 300));
      check(raw <= 1, "the parser text appears at most once (under Details)", `${raw}`);
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
      await new Promise((r) => setTimeout(r, 3000));
      const still = await page.evaluate((p) => document.querySelector(p).innerText.includes("Copied"), PANEL);
      check(!still, "3 s after copying, the button says Copy path again");
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
    // Remove saved key asks first, inline, in plain words; Keep backs out.
    name: "audit-settings-key-remove",
    sizes: [[1100, 720], [640, 480]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await press(page, "Remove saved key…");
      await h.idle();
      const ask = await page.evaluate(() => {
        const g = document.querySelector('[role="dialog"] [role="group"][aria-labelledby]');
        return { label: g && document.getElementById(g.getAttribute("aria-labelledby"))?.textContent, focus: document.activeElement?.textContent };
      });
      check(ask.label?.includes("Remove the saved key") && ask.label?.includes("can’t answer"), "the confirm says what will happen", ask.label);
      check(ask.focus === "Keep key", "focus moves to the safe answer", ask.focus);
      let clears = await page.evaluate(() => window.__calls.filter(([c]) => c === "api_key_clear").length);
      check(clears === 0, "nothing removed before confirming");
      await page.evaluate(() => document.activeElement.scrollIntoView({ block: "center" }));
      await h.shot("confirm");
      await press(page, "Keep key");
      await h.idle();
      const kept = await page.evaluate(() => document.activeElement?.textContent);
      check(kept === "Remove saved key…", "Keep key returns focus to Remove saved key", kept);
      await press(page, "Remove saved key…");
      await h.idle();
      await press(page, "Remove key");
      await h.waitText("No key saved yet");
      await h.idle();
      clears = await page.evaluate(() => window.__calls.filter(([c]) => c === "api_key_clear").length);
      const after = await page.evaluate(() => document.activeElement?.getAttribute("type"));
      check(clears === 1, "Remove key removes it once", `${clears}`);
      check(after === "password", "focus moves to the empty key field", after);
      await park(page);
    },
  },
  {
    // Text size lives on Accessibility only; Appearance links there.
    name: "audit-settings-text-size-link",
    sizes: WIDE,
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      const sliders = await page.evaluate((p) => document.querySelectorAll(`${p} [data-token="--ph-text-scale"] [role="slider"]`).length, PANEL);
      check(sliders === 0, "no text size slider on Appearance");
      await press(page, "Change in Accessibility");
      await h.idle();
      const got = await page.evaluate(() => ({
        tab: document.querySelector('[role="tab"][data-state="active"]')?.textContent,
        row: document.activeElement?.closest("[data-token]")?.getAttribute("data-token"),
        role: document.activeElement?.getAttribute("role"),
      }));
      check(got.tab === "Accessibility" && got.role === "slider" && got.row === "--ph-text-scale", "the link opens Accessibility on the text size slider", JSON.stringify(got));
    },
  },
  {
    // Other parts of the app open Settings on a section with a window event
    // (src/lib/open-settings.ts); closing returns focus to what had it, or to
    // the composer when that is gone.
    name: "audit-settings-open-event",
    sizes: WIDE,
    themes: ["light"],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION } },
    async run(page, h) {
      await page.waitForSelector("[data-composer-input]", { timeout: 5000 });
      const open = (section) => page.evaluate((section) => window.dispatchEvent(new CustomEvent("phaethon:open-settings", { detail: { section } })), section);
      const activeTab = () => page.evaluate(() => document.querySelector('[role="dialog"] [role="tab"][data-state="active"]')?.textContent);
      const close = async () => {
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
        await h.idle();
      };
      // 1. From a button that stays put: focus goes back to it.
      await page.evaluate(() => {
        const own = document.querySelector('[data-testid="open-settings"]');
        window.__from = [...document.querySelectorAll("main button, header button")].find((x) => x !== own && x.getClientRects().length && !x.disabled);
        window.__from.focus();
      });
      const fromName = await page.evaluate(() => window.__from.getAttribute("aria-label") ?? window.__from.textContent);
      await open("spaces");
      await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
      await h.idle();
      check((await activeTab()) === "Spaces", "the event opens Settings on Spaces");
      await h.shot("spaces");
      await close();
      check(await page.evaluate(() => document.activeElement === window.__from), "closing returns focus to the element that had it", fromName);
      // 2. From the composer, on About; a second event while open switches section.
      await page.focus("[data-composer-input]");
      await open("about");
      await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
      await h.idle();
      check((await activeTab()) === "About", "the event opens Settings on About");
      await open("accessibility");
      await h.idle();
      check((await activeTab()) === "Accessibility", "an event while open switches section");
      await close();
      check(await page.evaluate(() => document.activeElement?.hasAttribute("data-composer-input")), "focus is back in the composer");
      // 3. The opener is removed while Settings is open: fall back to the composer.
      await page.evaluate(() => {
        const b = document.createElement("button");
        b.id = "temp-opener";
        b.textContent = "temp";
        document.body.append(b);
        b.focus();
      });
      await open("agent");
      await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
      await h.idle();
      await page.evaluate(() => document.getElementById("temp-opener").remove());
      await close();
      check(await page.evaluate(() => document.activeElement?.hasAttribute("data-composer-input")), "opener gone: focus falls back to the composer");
      // 4. Opened by its own button: focus returns to that button, as before.
      await openSettings(page, h);
      await close();
      const own = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
      check(own === "open-settings", "opened by its button: focus returns to the button", own);
    },
  },
  {
    name: "audit-settings-load-error",
    sizes: WIDE,
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, fail: { settings_get: "settings.json: invalid type: string \"yes\", expected a boolean at line 4" } },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      await h.click('[data-testid="settings-tab-agent"]');
      await h.idle();
      await park(page);
      const text = await page.evaluate((p) => document.querySelector(p).innerText, PANEL);
      check(text.includes("Could not load your settings") && text.includes("Try again"), "after choosing Agent, the load error and Try again are shown", text.slice(0, 200));
      check(!text.includes("Loading your agent settings"), "no endless Loading…");
      await h.shot("error");
      // The file is fixed; Try again loads the page and focus goes to its heading.
      await page.evaluate(() => { delete window.__MOCK__.fail.settings_get; });
      await press(page, "Try again");
      await h.waitText("Which agent answers");
      await h.idle();
      const focus = await page.evaluate(() => document.activeElement?.textContent);
      check(focus === "Agent", "after a good retry, focus moves to the page heading", focus);
    },
  },
];
