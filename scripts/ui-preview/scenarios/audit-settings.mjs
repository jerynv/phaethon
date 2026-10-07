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

/** Scroll an element to the middle of the page it is in. (Obscura's scrollIntoView does not scroll a nested scroller.) */
const centre = (handle) =>
  handle.evaluate((el) => {
    let p = el.parentElement;
    while (p && !(p.scrollHeight > p.clientHeight && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
    if (!p) return;
    const r = el.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    p.scrollTop += r.top - pr.top - (pr.height - r.height) / 2;
  });

/** The Settings button openSettings() clicks: the sidebar's, or the title bar's when the sidebar is hidden. */
const openerId = (page) =>
  page.evaluate(() => (document.querySelector('#spaces-sidebar:not([hidden]) [data-testid="open-settings"]') ? "open-settings" : "titlebar-settings"));

/**
 * The page's text as shown: what sits inside a closed <details> (other than
 * its summary) is left out. Obscura's innerText includes it, so this is
 * worked out from the DOM.
 */
const shownText = (page) =>
  page.evaluate((p) => {
    const copy = document.querySelector(p).cloneNode(true);
    for (const d of copy.querySelectorAll("details:not([open])")) for (const c of [...d.children]) if (c.tagName !== "SUMMARY") c.remove();
    return copy.textContent;
  }, PANEL);

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
      await press(page, "Check and save");
      await h.waitText("Paste your key first");
      await park(page);
      await h.idle();
    },
  },
  {
    name: "audit-settings-key-invalid",
    sizes: WIDE,
    mock: { settings: { ...SETTINGS, hasAnthropicKey: false }, threads: {}, keyCheck: { ok: false, problem: "format", message: "That isn’t an Anthropic API key." } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.type('input[type="password"]', "not-a-real-key");
      await press(page, "Check and save");
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
      check(got.described.includes("doesn’t look like an Anthropic API key"), "the field is described by the plain format message", got.described);
      const sets = await page.evaluate(() => window.__calls.filter(([c]) => c === "api_key_set").length);
      check(sets === 0, "a key that fails its check is not saved", `${sets}`);
      check(got.focused, "focus is back in the key field");
    },
  },
  {
    name: "audit-settings-key-saving",
    sizes: WIDE,
    themes: ["light"],
    mock: { settings: { ...SETTINGS, hasAnthropicKey: false }, threads: {}, slow: { api_key_check: 60000 } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.type('input[type="password"]', "sk-ant-api03-xxxxxxxxxxxxxxxx");
      await press(page, "Check and save");
      await h.idle();
      await park(page);
      const got = await page.evaluate(() => {
        const btn = document.querySelector('[role="dialog"] form button[type="submit"]');
        return { text: btn?.textContent, ariaDisabled: btn?.getAttribute("aria-disabled"), readOnly: document.querySelector('input[type="password"]').hasAttribute("readonly") };
      });
      console.log(`     while saving: ${JSON.stringify(got)}`);
      check(got.text === "Checking…" && got.ariaDisabled === "true", "Check and save shows Checking… and is aria-disabled while it runs", JSON.stringify(got));
      check(got.readOnly, "the key field is read-only while checking");
      // A second press (click or Enter) while pending sends nothing more.
      await page.$eval('[role="dialog"] form button[type="submit"]', (b) => b.click());
      await page.$eval('input[type="password"]', (i) => i.form.requestSubmit());
      await h.idle();
      const sets = await page.evaluate(() => window.__calls.filter(([c]) => c === "api_key_check").length);
      check(sets === 1, "only one api_key_check while pending", `${sets}`);
    },
  },
  {
    name: "audit-settings-key-saved",
    sizes: WIDE,
    mock: { settings: { ...SETTINGS, hasAnthropicKey: false }, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.type('input[type="password"]', "sk-ant-api03-xxxxxxxxxxxxxxxx");
      await press(page, "Check and save");
      await h.waitText("A key is saved");
      await park(page);
      await h.idle();
      const status = await page.evaluate(() => document.querySelector('[role="dialog"] p[role="status"]')?.textContent);
      console.log(`     after save, status: ${status}; focus: ${await activeDesc(page)}`);
      const line = await page.evaluate(() => document.querySelector('[role="dialog"] form')?.innerText.includes("Your key works. It’s saved in this computer’s password store (Keychain)."));
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
      const swatch = '[role="radiogroup"][aria-label="Accent colour"] [role="radio"]';
      await page.keyboard.press("Tab");
      if (await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "settings-tab-appearance")) {
        // Obscura sometimes does not move focus on Tab; focus the chosen swatch as Tab would.
        console.log("     note: Tab did not move focus here (an Obscura quirk); focusing the chosen swatch directly");
        await page.$eval(`${swatch}[aria-checked="true"]`, (el) => el.focus());
      } else {
        await h.focusVia(swatch);
      }
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await h.idle();
      await page.evaluate(() => document.activeElement.scrollIntoView({ block: "center" }));
      await h.idle();
      await h.shot("swatch-focused");
      // In a short window the swatch can sit outside the scrolled page; bring it into view first.
      await centre(await page.$(`${swatch}:nth-child(5)`));
      await h.idle();
      await h.hover(`${swatch}:nth-child(5)`);
      await h.idle();
      await h.shot("swatch-hover");
      // A hue slider mid-drag: mouse down on the thumb, move, no release.
      const thumb = await sliderIn(page, "Custom hue");
      await centre(thumb);
      await h.idle();
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
      // N-009: the dot sits on the first line of its row, and the space name is
      // never alone on a line: the path starts on the same line as "Work /".
      const rows = await page.evaluate((p) =>
        [...document.querySelectorAll(`${p} [data-grant-row]`)].map((row) => {
          const where = row.querySelector("[data-grant-where]");
          const dot = row.querySelector("[aria-hidden].rounded-full").getBoundingClientRect();
          const parts = [...where.children];
          // The first line box: the line rects of the text that sit at the top.
          const range = document.createRange();
          range.selectNodeContents(where);
          const rects = [...range.getClientRects()];
          const top = Math.min(...rects.map((r) => r.top));
          const first = { top, bottom: Math.max(...rects.filter((r) => r.top < top + 4).map((r) => r.bottom)) };
          const name = parts[0].getBoundingClientRect();
          const path = parts[2] ? parts[2].getClientRects()[0] : name;
          return {
            text: where.textContent,
            dotOnFirstLine: dot.top >= first.top - 1 && dot.bottom <= first.bottom + 1,
            pathWithName: Math.abs(path.top - name.top) < name.height / 2,
            wrapped: where.getBoundingClientRect().height > name.height * 1.5,
          };
        }),
      PANEL);
      check(rows.length > 0, "grant rows are shown", `${rows.length}`);
      for (const r of rows) {
        check(r.dotOnFirstLine, `dot sits on the first line: ${r.text.slice(0, 40)}`, JSON.stringify(r));
        check(r.pathWithName, `the path starts beside the space name: ${r.text.slice(0, 40)}`, JSON.stringify(r));
      }
      console.log(`     wrapped grant rows: ${rows.filter((r) => r.wrapped).length} of ${rows.length}`);
      // N-011: the warning is ours in plain words (what, which file, what to do); the core's lines are listed as they arrive.
      const warn = await page.evaluate((p) => document.querySelector(`${p} [data-grant-problems]`)?.closest(".bg-warning-soft")?.innerText ?? "", PANEL);
      check(warn.includes("Some saved access between spaces can’t be used, so it gives no access."), "a plain headline for grants.json problems", warn.slice(0, 120));
      check(warn.includes("/Users/you/Phaethon/default/.phaethon/grants.json") && warn.includes("correct or delete those entries"), "it names the file and says what to do", warn);
      check(warn.includes("garden") && warn.includes("../../etc"), "each problem the core reports is listed");
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
      check(text.includes("mistake in it, on line 3") && text.includes("grants.json"), "one file-level message names the file and the line", text.slice(0, 300));
      check(!(await shownText(page)).includes("expected `,`"), "the parser text is folded under Details");
      const folded = await page.evaluate((p) => [...document.querySelectorAll(`${p} details`)].filter((d) => d.textContent.includes("expected `,`")).length, PANEL);
      check(folded === 1, "the parser text sits under one shared Details", `${folded}`);
      const summary = await page.evaluate((p) => {
        const s = document.querySelector(`${p} details > summary`);
        const r = s.getBoundingClientRect();
        return { h: r.height, chevron: !!s.querySelector("svg"), underline: getComputedStyle(s).textDecorationLine };
      }, PANEL);
      check(summary.h >= 24 && summary.chevron && (summary.underline === "none" || summary.underline === ""), "Details is the shared one: a chevron, no underline, at least 24 px tall", JSON.stringify(summary));
    },
  },

  // ---- About ----
  {
    name: "audit-settings-about-copy",
    sizes: WIDE,
    mock: { settings: { ...SETTINGS, vaultPath: "/Users/someone-with-a-long-name/Library/Mobile Documents/com~apple~CloudDocs/Phaethon/default" }, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "about");
      await press(page, "Copy path");
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
      await h.waitText("The key comes from Anthropic");
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
      // 4. Opened by a Settings button: focus returns to that button, as before.
      // (The sidebar's; in a narrow window, where the sidebar starts hidden, the title bar's.)
      const opener = await openerId(page);
      await openSettings(page, h);
      await close();
      const own = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
      check(own === opener, "opened by its button: focus returns to the button", `${own} (opened with ${opener})`);
    },
  },
  {
    name: "audit-settings-load-error",
    sizes: [[1100, 720], [640, 480]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, fail: { settings_get: "settings.json: invalid type: string \"yes\", expected a boolean at line 4" } },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      await h.click('[data-testid="settings-tab-agent"]');
      await h.idle();
      await park(page);
      const text = await page.evaluate((p) => document.querySelector(p).innerText, PANEL);
      check(text.includes("Phaethon can’t read your settings, so it is using the defaults") && text.includes("Try again"), "after choosing Assistant, a plain load error and Try again are shown", text.slice(0, 300));
      check(text.includes(".phaethon/settings.json") && text.includes("on line 4") && text.includes("Fix or delete it"), "it names the file, the line and what to do", text.slice(0, 400));
      check(!text.includes("Loading your assistant settings"), "no endless Loading…");
      // The parser's own text is folded under the shared Details, not in the headline.
      const raw = await page.evaluate((p) => {
        const panel = document.querySelector(p);
        const d = panel.querySelector("details");
        return { folded: !!d && !d.open && d.textContent.includes("invalid type"), alert: panel.querySelector('[role="alert"]')?.textContent };
      }, PANEL);
      check(!(await shownText(page)).includes("invalid type") && raw.folded,"the raw parser text is only under a closed Details", JSON.stringify(raw));
      check(!raw.alert?.includes("invalid type"), "the alert is the plain sentence", raw.alert);
      await h.shot("error");
      await page.$eval(`${PANEL} details summary`, (s) => {
        s.click();
        // Obscura does not toggle <details> on a summary click; a browser does.
        if (!s.parentElement.open) s.parentElement.open = true;
      });
      await h.idle();
      check((await shownText(page)).includes("invalid type"), "opening Details shows the parser text");
      await h.shot("details-open");
      // The file is fixed; Try again loads the page and focus goes to its heading.
      await page.evaluate(() => { delete window.__MOCK__.fail.settings_get; });
      await press(page, "Try again");
      await h.waitText("Which assistant answers");
      await h.idle();
      const focus = await page.evaluate(() => document.activeElement?.textContent);
      check(focus === "Assistant", "after a good retry, focus moves to the page heading", focus);
    },
  },
  {
    // A keychain failure gets its own plain sentence, not the settings-file one.
    name: "audit-settings-load-error-keychain",
    sizes: WIDE,
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, fail: { settings_get: "could not read the keychain: User interaction is not allowed." } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await park(page);
      const text = await page.evaluate((p) => document.querySelector(p).innerText, PANEL);
      check(text.includes("couldn’t open this computer’s password store (Keychain)") && !text.includes("settings.json"), "a keychain failure is named as one", text.slice(0, 300));
      check(!(await shownText(page)).includes("User interaction is not allowed"), "its raw text is folded under Details");
    },
  },
  {
    // N-004: the settings page itself is a tab stop (Radix Tabs, so it scrolls
    // by keyboard); its focus ring is drawn inside it, clear of the section
    // list's border and the window's rounded corners.
    name: "audit-settings-panel-focus",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      await page.focus('[data-testid="settings-tab-appearance"]');
      await page.keyboard.press("Tab");
      await h.idle();
      // Obscura may not move focus on Tab; focusing from script after a key press still counts as keyboard focus.
      if (!(await page.evaluate((p) => document.activeElement === document.querySelector(p), PANEL))) await page.$eval(PANEL, (el) => el.focus());
      await h.idle();
      const got = await page.evaluate((p) => {
        const panel = document.querySelector(p);
        let cs = getComputedStyle(panel);
        if (!panel.matches(":focus-visible")) {
          // Obscura never matches :focus-visible and does not expand rules inside
          // @layer, so read the stylesheet text: the global ring's width, and the
          // last !important outline-offset in a :focus-visible rule that matches
          // the panel (a layered !important beats the unlayered global one).
          // Resolve both on a probe inside the panel, so var()s resolve.
          const css = [...document.styleSheets].flatMap((s) => [...s.cssRules].map((r) => r.cssText)).join("\n");
          const ring = /(?:^|[\s}]):focus-visible\s*\{\s*outline:\s*(\S+)\s+solid/.exec(css)?.[1];
          let offset = null;
          for (const m of css.matchAll(/([^{}]+):focus-visible\s*\{([^}]*?)outline-offset:\s*([^;}]+?)\s*!\s*important/g)) {
            const sel = m[1].trim();
            try {
              if (sel && panel.matches(sel)) offset = m[3];
            } catch {}
          }
          const probe = document.createElement("div");
          panel.append(probe);
          probe.style.outlineStyle = "solid";
          if (ring) probe.style.outlineWidth = ring;
          if (offset) probe.style.outlineOffset = offset;
          const pc = getComputedStyle(probe);
          cs = { outlineStyle: ring ? "solid" : "none", outlineWidth: pc.outlineWidth, outlineOffset: offset ? pc.outlineOffset : "2px" };
          probe.remove();
        }
        const width = parseFloat(cs.outlineWidth);
        const offset = parseFloat(cs.outlineOffset);
        const r = panel.getBoundingClientRect();
        const d = document.querySelector('[role="dialog"]').getBoundingClientRect();
        const nav = document.querySelector('[role="tablist"]').parentElement.getBoundingClientRect();
        return {
          focused: document.activeElement === panel,
          visible: panel.matches(":focus-visible"),
          tabindex: panel.getAttribute("tabindex"),
          style: cs.outlineStyle,
          width,
          offset,
          // The ring's outer edge, which must stay inside the panel (and so inside the window).
          inside: offset + width <= 0 && r.left >= d.left && r.right <= d.right && r.bottom <= d.bottom,
          clearOfNav: r.left >= nav.right - 1 || r.top >= nav.bottom - 1,
        };
      }, PANEL);
      console.log(`     panel focus: ${JSON.stringify(got)}`);
      check(got.focused && got.tabindex === "0", "the page is one tab stop after the section list", JSON.stringify(got));
      check(got.style === "solid" && got.width >= 3, "it shows the full-width ring", JSON.stringify(got));
      check(got.inside && got.clearOfNav, "the ring is drawn inside the page, not across the seam", JSON.stringify(got));
    },
  },
  {
    // N-007: at the largest text size the page description keeps its width:
    // "Everything here is at its default." wraps below the header instead.
    name: "audit-settings-header-wrap",
    sizes: SIZES3,
    themes: ["light"],
    mock: { settings: { ...SETTINGS, appearance: { tokens: { "--ph-text-scale": 2 } } }, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      await park(page);
      for (const tab of ["appearance", "accessibility"]) {
        await page.$eval(`[data-testid="settings-tab-${tab}"]`, (el) => el.click());
        await h.idle();
        const got = await page.evaluate((p) => {
          const header = document.querySelector(`${p} [data-section-header]`);
          const desc = header.querySelector("p");
          const action = header.lastElementChild;
          const em = parseFloat(getComputedStyle(desc).fontSize);
          const hw = header.getBoundingClientRect().width;
          return {
            header: Math.round(hw),
            desc: Math.round(desc.getBoundingClientRect().width),
            want: Math.round(Math.min(24 * em, hw)),
            actionBelow: action.getBoundingClientRect().top >= desc.getBoundingClientRect().bottom - 1,
            lines: Math.round(desc.getBoundingClientRect().height / parseFloat(getComputedStyle(desc).lineHeight)),
          };
        }, PANEL);
        console.log(`     ${tab} header at 2x: ${JSON.stringify(got)}`);
        check(got.desc >= got.want - 1, `${tab}: the description keeps at least 24 em (or the full width)`, JSON.stringify(got));
      }
      await page.$eval('[data-testid="settings-tab-appearance"]', (el) => el.click());
      await h.idle();
    },
  },
];
