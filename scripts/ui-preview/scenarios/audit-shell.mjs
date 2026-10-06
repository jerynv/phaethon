// Audit: the window shell. Title bars per platform, inactive window, sidebar
// states (hover, focus, pressed, active per space hue, collapsed), the sidebar
// toggle tooltip, the skip link, window controls (hover, pressed), and the
// grants chip with its popover (hover, focus, open, revoke, many, long paths),
// and Settings with the sidebar hidden (title bar button, Cmd+,). Behaviour
// checks (check(...)) fail the run.
import { CONVERSATION, GRANTS, SETTINGS, WORK_THREAD, activeDesc, blurWindow, check, park } from "../audit-fixtures.mjs";

const CHIP = "[data-grants-chip]";
const POPOVER = '[data-radix-popper-content-wrapper] [role="dialog"]';
const WIDE = [[1100, 720]];
const ctrl = (label) => `[data-window-control][aria-label="${label}"]`;

/**
 * The chip's accessible name and description as the DOM gives them: the name
 * is its text content minus display:none parts, aria-hidden parts and the
 * description element; the description is the aria-describedby text.
 */
export const chipA11y = (page) =>
  page.evaluate((sel) => {
    const chip = document.querySelector(sel);
    if (!chip) return null;
    const descId = chip.getAttribute("aria-describedby");
    const text = (n) => {
      if (n.nodeType === 3) return n.textContent;
      if (n.nodeType !== 1) return "";
      if ((descId && n.id === descId) || n.getAttribute("aria-hidden") === "true" || getComputedStyle(n).display === "none") return "";
      return [...n.childNodes].map(text).join("");
    };
    return {
      label: chip.getAttribute("aria-label"),
      name: text(chip).replace(/\s+/g, " ").trim(),
      desc: (descId && document.getElementById(descId)?.textContent) || "",
    };
  }, CHIP);

/** Whether the space title shows whole (not cut off with an ellipsis). */
const titleWhole = (page) =>
  page.evaluate(() => {
    const h1 = document.getElementById("space-title");
    return { whole: h1.scrollWidth <= h1.clientWidth, text: h1.textContent, w: h1.clientWidth };
  });

const platform = (p) => ({
  name: `audit-shell-${p}`,
  sizes: [[1100, 720], [640, 480]],
  mock: { platform: p, settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.two } },
  async run(page, h) {
    await h.idle();
    await park(page);
    // A-010: a small window starts with the sidebar hidden; a wide one shows it. The line
    // (720px at the default text size) moves with the text size, as the sidebar's width does.
    const { width } = page.viewport();
    const { hidden, scale } = await page.evaluate(() => ({
      hidden: document.getElementById("spaces-sidebar")?.hidden,
      scale: Math.max(1, parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ph-text-scale")) || 1),
    }));
    const narrow = width <= 720 * scale;
    check(hidden === narrow, `sidebar ${narrow ? "hidden" : "shown"} by default at ${width}px, text scale ${scale}`, `hidden=${hidden}`);
    // A-009: the title never truncates before the chip; a narrow window collapses the chip to a count.
    const t = await titleWhole(page);
    check(t.whole, `the space title "${t.text}" shows whole`, `width ${t.w}`);
    const a = await chipA11y(page);
    const want = width < 768 ? "Also reads 2" : "Also reads Work / calendar +1 more";
    // A-014: the name is the visible text (no aria-label that could drift from it).
    check(a && !a.label && a.name === want, `chip name is its visible text "${want}"`, JSON.stringify(a));
    check(a.desc === "School can also read 2 places in another space.", "chip description says the whole thing", a.desc);
    if (p === "mac") return;
    await page.waitForSelector("[data-window-control]", { timeout: 5000 });
    await h.hover(ctrl("Minimize"));
    await h.idle();
    await h.shot("minimize-hover");
    await h.press(ctrl("Maximize"));
    await h.shot("maximize-pressed");
    await page.mouse.up();
    await h.hover(ctrl("Close"));
    await h.idle();
    await h.shot("close-hover");
    await h.press(ctrl("Close"));
    await h.shot("close-pressed");
    await page.mouse.up();
    await park(page);
    // Keyboard focus on Close (the ring is drawn inside the button).
    await page.focus(ctrl("Close"));
    await page.keyboard.press("Shift"); // marks keyboard modality for :focus-visible
    await h.idle();
  },
});

export default [
  platform("mac"),
  platform("windows"),
  platform("linux"),
  {
    name: "audit-shell-inactive",
    sizes: WIDE,
    mock: { platform: "windows", settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.two } },
    async run(page, h) {
      await h.idle();
      await park(page);
      const activeBg = () => page.evaluate(() => getComputedStyle(document.querySelector('#spaces-sidebar [aria-current="page"]')).backgroundColor);
      const before = await activeBg();
      await blurWindow(page);
      await h.idle();
      const dim = await page.evaluate(() => document.querySelector("header")?.hasAttribute("data-inactive"));
      check(dim, "the title bar is marked inactive after the window blurs");
      // A-017: the whole app is marked, so the sidebar selection greys too.
      const root = await page.evaluate(() => !!document.querySelector('#root > [data-inactive] #spaces-sidebar [aria-current="page"]'));
      check(root, "the app root is marked inactive, around the sidebar's current space");
      console.log(`     active space background: ${before} -> ${await activeBg()}`);
    },
  },
  {
    // A-007: with the sidebar hidden, Settings is still one click (title bar) or Cmd+, away.
    name: "audit-shell-settings-sidebar-hidden",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: { school: CONVERSATION } },
    async run(page, h) {
      await h.idle();
      const before = await page.evaluate(() => !!document.querySelector('header [data-testid="titlebar-settings"]'));
      check(!before, "no title bar Settings button while the sidebar (with its own) shows");
      await page.click('button[aria-controls="spaces-sidebar"]');
      await page.waitForSelector("#spaces-sidebar[hidden]", { timeout: 5000 });
      await page.waitForSelector('header [data-testid="titlebar-settings"]', { timeout: 5000 });
      const name = await page.evaluate(() => {
        const b = document.querySelector('header [data-testid="titlebar-settings"]');
        return `${b.getAttribute("aria-label")} ${b.getAttribute("aria-keyshortcuts")}`;
      });
      check(name === "Settings Meta+Comma", "title bar Settings button is named and lists its shortcut", name);
      await page.click('header [data-testid="titlebar-settings"]');
      await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
      check(true, "the title bar button opens Settings");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
      await park(page);
      await page.keyboard.down("Meta");
      await page.keyboard.press(",");
      await page.keyboard.up("Meta");
      let how = "real key press";
      if (!(await page.waitForSelector('[role="dialog"]', { timeout: 1500 }).catch(() => null))) {
        // Obscura delivers the keys but never sets metaKey; send the event a real webview sends.
        how = "synthetic keydown: this engine drops modifier flags";
        await page.evaluate(() =>
          (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: ",", code: "Comma", metaKey: true, bubbles: true, cancelable: true })),
        );
        await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
      }
      check(true, `Cmd+, opens Settings with the sidebar hidden (${how})`);
      await h.idle();
    },
  },
  {
    name: "audit-shell-sidebar",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: { school: CONVERSATION, work: WORK_THREAD } },
    async run(page, h) {
      await h.idle();
      await h.hover("#spaces-sidebar li:nth-child(2) button");
      await h.idle();
      await h.shot("work-hovered");
      await h.press("#spaces-sidebar li:nth-child(2) button");
      await h.shot("work-pressed");
      await page.mouse.up();
      await h.idle();
      await park(page);
      await h.shot("work-active");
      // Keyboard: from the top of the page, Tab to the first space.
      await page.evaluate(() => document.activeElement?.blur());
      // A-008: the scroll viewport clips, so the ring (width + offset) must fit inside it on every side.
      const room = await page.evaluate(() => {
        const b = document.querySelector("#spaces-sidebar li:nth-child(1) button").getBoundingClientRect();
        const v = document.querySelector('#spaces-sidebar [data-slot="scroll-area-viewport"]').getBoundingClientRect();
        const cs = getComputedStyle(document.documentElement);
        const ring = parseFloat(cs.getPropertyValue("--ph-focus-width")) + parseFloat(cs.getPropertyValue("--ph-focus-offset"));
        return { ring, top: b.top - v.top, left: b.left - v.left, right: v.right - b.right };
      });
      check(room.top >= room.ring && room.left >= room.ring && room.right >= room.ring, "a focused space's ring fits inside the sidebar's scroll area", JSON.stringify(room));
      await h.focusVia("#spaces-sidebar li:nth-child(1) button");
      await h.idle();
      await h.shot("school-focused-keyboard");
      await h.focusVia('[data-testid="open-settings"]');
      await h.idle();
      await h.shot("settings-focused");
      await h.hover('[data-testid="open-settings"]');
      await h.idle();
    },
  },
  {
    name: "audit-shell-toggle-tooltip",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: { school: CONVERSATION } },
    async run(page, h) {
      await h.hover('button[aria-controls="spaces-sidebar"]');
      await new Promise((r) => setTimeout(r, 900));
      await page.waitForSelector('[data-slot="tooltip-content"]', { timeout: 3000 });
      await h.shot("open-sidebar-tooltip");
      await page.click('button[aria-controls="spaces-sidebar"]');
      await page.waitForSelector("#spaces-sidebar[hidden]", { timeout: 5000 });
      await park(page);
      await h.idle();
      await h.shot("collapsed");
      await h.hover('button[aria-controls="spaces-sidebar"]');
      await new Promise((r) => setTimeout(r, 900));
      // Collapsed, keyboard focus on the toggle also shows the tooltip.
    },
  },
  {
    name: "audit-shell-skip-link",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION } },
    async run(page, h) {
      await h.idle();
      await page.keyboard.press("Tab");
      await h.idle();
      const a = await activeDesc(page);
      check(a.includes("Skip to conversation"), "the first Tab lands on the skip link", a);
    },
  },
  {
    name: "audit-shell-chip-hover",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.two } },
    async run(page, h) {
      await h.hover(CHIP);
      await h.idle();
      await h.shot("hover");
      await h.press(CHIP);
      await h.shot("pressed");
      await page.mouse.up();
      await page.keyboard.press("Escape");
      await park(page);
      await h.idle();
      await page.evaluate(() => document.activeElement?.blur());
      await h.focusVia(CHIP);
      await h.idle();
    },
  },
  {
    name: "audit-shell-popover",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.two } },
    async run(page, h) {
      await h.click(CHIP);
      await page.waitForSelector(POPOVER, { timeout: 5000 });
      await park(page);
      await h.idle();
      await h.shot("open");
      await page.keyboard.press("Tab");
      await h.idle();
      await h.shot("first-revoke-focused");
      await h.hover(`${POPOVER} [data-revoke]`);
      await h.idle();
      await h.shot("revoke-hover");
      await page.click(`${POPOVER} [data-revoke]`);
      await h.idle();
      await park(page);
      await h.idle();
      // After a revoke: one grant left, focus on its Revoke.
    },
  },
  {
    name: "audit-shell-popover-many",
    sizes: [[1100, 720], [760, 560]],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.many }, grantProblems: ['Grant 7 was ignored: "from" names a space that does not exist ("garden").'] },
    async run(page, h) {
      await h.idle();
      await park(page);
      await h.shot("chip");
      await h.click(CHIP);
      await page.waitForSelector(POPOVER, { timeout: 5000 });
      await park(page);
      await h.idle();
      // A-011: the popover stays inside the window; only its list scrolls, "Manage in Settings" stays in view.
      const m = await page.evaluate((sel) => {
        const pop = document.querySelector(sel);
        const ul = pop.querySelector("ul");
        const manage = [...pop.querySelectorAll("button")].find((b) => b.textContent.includes("Manage in Settings"));
        const r = pop.getBoundingClientRect();
        const mr = manage.getBoundingClientRect();
        return {
          top: r.top,
          bottom: r.bottom,
          vh: innerHeight,
          manageBottom: mr.bottom,
          scrolls: ul.scrollHeight > ul.clientHeight + 1,
          panelScrolls: pop.scrollHeight > pop.clientHeight + 1,
          overflowY: getComputedStyle(ul).overflowY,
          text: pop.textContent,
        };
      }, POPOVER);
      check(m.top >= 0 && m.bottom <= m.vh, "the popover fits in the window", JSON.stringify({ ...m, text: undefined }));
      // At very large text even the heading and footer can outgrow the window; then the panel scrolls to it.
      check(m.manageBottom <= m.vh || m.panelScrolls, "Manage in Settings is in view, or the panel scrolls to it", JSON.stringify({ ...m, text: undefined }));
      check(m.overflowY === "auto", "the grants list scrolls when it is taller than the room", `${m.overflowY}, overflowing now: ${m.scrolls}`);
      if (page.viewport().height <= 560) check(m.scrolls, "at 560px tall the six grants overflow and the list scrolls");
      // A-012: a whole-space grant and a grant from a space outside this vault read plainly.
      check(m.text.includes("All of Work") && !m.text.includes("Work / ·"), "a whole-space grant reads \"All of Work\"");
      check(m.text.includes("Home (not in this vault)"), "an unknown space reads \"Home (not in this vault)\"");
    },
  },
  {
    name: "audit-shell-popover-long",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.long } },
    async run(page, h) {
      await h.idle();
      await park(page);
      // A-013: the chip shortens the path in the middle, keeping the file name.
      const a = await chipA11y(page);
      if (page.viewport().width >= 768)
        check(a.name === "Also reads Work / archive/…/master-services-agreement-amendment-3-final-final.pdf", "chip shortens a long path in the middle", a.name);
      await h.shot("chip");
      await h.click(CHIP);
      await page.waitForSelector(POPOVER, { timeout: 5000 });
      await park(page);
      await h.idle();
      // ...and the popover shows the whole path, wrapped, never cut.
      const p = await page.evaluate((sel) => {
        const s = document.querySelector(`${sel} li .font-mono`);
        const pop = document.querySelector(sel).getBoundingClientRect();
        return { text: s.textContent, ellipsis: getComputedStyle(s).textOverflow, right: s.getBoundingClientRect().right, popRight: pop.right };
      }, POPOVER);
      check(p.text.endsWith("amendment-3-final-final.pdf") && p.ellipsis !== "ellipsis" && p.right <= p.popRight, "the popover wraps the whole path inside itself", JSON.stringify(p));
    },
  },
  {
    name: "audit-shell-popover-revoke-error",
    sizes: WIDE,
    themes: ["light"],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.two }, fail: { grant_revoke: "grants.json is read-only (permission denied)" } },
    async run(page, h) {
      await h.click(CHIP);
      await page.waitForSelector(POPOVER, { timeout: 5000 });
      await h.idle();
      await page.click(`${POPOVER} [data-revoke]`);
      await h.waitText("Couldn’t revoke");
      await park(page);
      await h.idle();
      // A-015: plain words with a way out, and the box lines up with the rows' text.
      const e = await page.evaluate((sel) => {
        const alert = document.querySelector(`${sel} [role="alert"]`);
        const li = document.querySelector(`${sel} li`);
        return { text: alert.textContent, left: alert.getBoundingClientRect().left, rowText: li.getBoundingClientRect().left + parseFloat(getComputedStyle(li).paddingLeft) };
      }, POPOVER);
      check(e.text === "Couldn’t revoke Work / calendar. grants.json can’t be written: check the vault folder’s permissions, then try again.", "revoke failure says what to do", e.text);
      check(Math.abs(e.left - e.rowText) < 1, "the error box lines up with the rows", JSON.stringify(e));
    },
  },
];
