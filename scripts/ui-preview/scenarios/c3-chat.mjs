// Chat fix round 3 (persona re-check, round 2 brief "Team C"): one scenario per
// behaviour, each with checks that throw when the behaviour is wrong.
import { EIGHT, SETTINGS, check, park, pick } from "../audit-fixtures.mjs";

const COMPOSER = "[data-composer-input]";
const LOG = '[role="log"]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter((c) => c[0] === cmd).map((c) => c[1]), cmd);
const status = (page) => page.evaluate(() => document.querySelector('[data-testid="reply-status"]').textContent);
const send = async (page, text) => {
  await page.waitForSelector(COMPOSER, { timeout: 5000 });
  await page.focus(COMPOSER);
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
};
const chord = async (page, mod, key) => {
  await page.keyboard.down(mod);
  await page.keyboard.press(key);
  await page.keyboard.up(mod);
};
/** The element's box against the conversation's visible area. */
const inLog = (page, sel) =>
  page.evaluate(
    (sel, LOG) => {
      const el = typeof sel === "string" ? document.querySelector(sel) : null;
      const log = document.querySelector(LOG);
      if (!el || !log) return { found: false };
      const a = el.getBoundingClientRect();
      const l = log.getBoundingClientRect();
      return { found: true, top: Math.round(a.top), bottom: Math.round(a.bottom), logTop: Math.round(l.top), logBottom: Math.round(l.bottom), inside: a.top >= l.top - 1 && a.bottom <= l.bottom + 1 };
    },
    sel,
    LOG,
  );
const mock = (page, patch) => page.evaluate((patch) => Object.assign(window.__MOCK__, patch), patch);

const NO_KEY = { ...SETTINGS, hasAnthropicKey: false };
const scaled = (s, scale, extra = {}) => ({ ...s, appearance: { tokens: { "--ph-text-scale": scale, ...extra } } });
const LARGE = { "--ph-target-size": 44 };
const GOOD_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";

const LOADED = [
  { role: "user", text: "What is due this week?" },
  { role: "assistant", text: "**Problem set 4** is due Wednesday." },
  { role: "user", text: "And next week?" },
  { role: "assistant", text: "Test 1, on Thursday." },
];
const LONG_THREAD = Array.from({ length: 6 }, (_, i) => [
  { role: "user", text: `Question ${i + 1}: what about chapter ${i + 3}?` },
  { role: "assistant", text: `Chapter ${i + 3} covers a lot. ${"It has several sections worth reading slowly. ".repeat(4)}` },
]).flat();

const approval = (extra = {}) => ({
  waitApproval: true,
  id: "toolu_1",
  summary: "Create a new file notes.md (40 lines).",
  detail: Array.from({ length: 40 }, (_, i) => `- line ${i + 1}`).join("\n"),
  path: "notes.md",
  action: "create",
  ...extra,
});
const access = { waitAccess: true, id: "acc_1", space: "work", path: "calendar", reason: "To see which evenings you already have meetings." };

/** First run with no key: the setup card leads and its key field is in view without scrolling. */
const firstRun = (name, scale) => ({
  name,
  sizes: [[760, 560], [1100, 720]],
  mock: { settings: scaled(NO_KEY, scale), threads: {} },
  async run(page, h) {
    await page.waitForSelector("[data-setup-card]", { timeout: 5000 });
    await h.idle();
    const s = await page.evaluate((LOG) => {
      const log = document.querySelector(LOG);
      const firstHeading = log.querySelector("h1, h2, h3");
      const facts = document.querySelector("[data-setup-facts]");
      return {
        empty: !!log.querySelector("[data-empty-state]"),
        generic: log.innerText.includes("Start a conversation"),
        first: firstHeading?.textContent,
        factsFolded: !!facts && !facts.closest("details").open,
        summary: facts?.closest("details").querySelector("summary").textContent.trim(),
        scrollTop: log.scrollTop,
      };
    }, LOG);
    check(!s.empty && !s.generic, "the generic empty-state text is gone while the setup card shows", JSON.stringify(s));
    check(s.first?.startsWith("Set up Phaethon"), "the setup card's heading is the first thing in the conversation", s.first);
    check(s.factsFolded && s.summary === "What is an API key?", "the facts are folded into “What is an API key?”", JSON.stringify(s));
    const field = await inLog(page, "[data-setup-key]");
    const save = await inLog(page, '[data-setup-card] button[type="submit"]');
    // Where the conversation has room for the card down to Check and save, all of it shows at once. In a window
    // too short for that (640x480 at 200% text leaves the conversation about 84 px), it can't: there each one
    // must come whole into view when it is reached by keyboard.
    const room = field.logBottom - field.logTop >= save.bottom - field.logTop;
    if (room) {
      check(field.inside && s.scrollTop === 0, "the key field is in view without scrolling", JSON.stringify(field));
      check(save.inside, "Check and save is in view too", JSON.stringify(save));
    } else {
      for (const [sel, what] of [["[data-setup-key]", "the key field"], ['[data-setup-card] button[type="submit"]', "Check and save"]]) {
        await page.evaluate(() => document.activeElement?.blur());
        await h.focusVia(sel);
        await h.idle();
        const at = await inLog(page, sel);
        check(at.inside, `too short to show the card at once: ${what} scrolls whole into view when Tab reaches it`, JSON.stringify(at));
      }
    }
  },
});

/** Chips in the composer's tray that show only in part (the list is in view and clips them). */
const chipsWhole = (page) =>
  page.evaluate(() => {
    const list = document.querySelector("[data-attachment-list]");
    if (!list || list.hidden) return { folded: true, partial: [] };
    const l = list.getBoundingClientRect();
    const partial = [...list.querySelectorAll("li")]
      .map((li) => li.getBoundingClientRect())
      .filter((r) => r.top < l.top - 0.5 || r.bottom > l.bottom + 0.5)
      .map((r) => [Math.round(r.top), Math.round(r.bottom), Math.round(l.top), Math.round(l.bottom)]);
    return { folded: !!document.querySelector("[data-attachment-fold]"), partial };
  });
/** How many lines of text the message box shows, and whether that is a whole number. */
const textLines = (page) =>
  page.evaluate(() => {
    const input = document.querySelector("[data-composer-input]");
    const cs = getComputedStyle(input);
    const lh = parseFloat(cs.lineHeight);
    const inner = input.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const lines = inner / lh;
    return { lines: Number(lines.toFixed(2)), whole: Math.abs(lines - Math.round(lines)) < 0.08, lh, height: input.clientHeight, scrollHeight: input.scrollHeight, pad: cs.paddingTop, style: input.style.height, max: cs.maxHeight };
  });

/** Eight files and a long message: the composer stays within 40% of the window. */
async function composerCap(page, h) {
  await h.waitText("Test 1, on Thursday.");
  await pick(page, EIGHT);
  await page.waitForFunction(() => document.querySelectorAll("[data-attachment-tray] li, [data-attachment-fold]").length > 0, { timeout: 5000 });
  await page.focus(COMPOSER);
  await page.keyboard.type("Here are my notes for the week. ".repeat(8));
  await sleep(300);
  const m = await page.evaluate(() => {
    const wrap = document.querySelector("[data-composer-wrap]").getBoundingClientRect();
    const fold = document.querySelector("[data-attachment-fold]");
    const tray = document.querySelector("[data-attachment-tray]").getBoundingClientRect();
    const input = document.querySelector("[data-composer-input]").getBoundingClientRect();
    const list = document.querySelector("[data-attachment-list]").getBoundingClientRect();
    return { share: wrap.height / innerHeight, fold: fold?.textContent.trim() ?? null, expanded: fold?.getAttribute("aria-expanded") ?? null, gap: Math.round(input.top - tray.bottom), clear: list.height === 0 || list.bottom <= input.top };
  });
  check(m.share <= 0.401, "the composer takes at most 40% of the window", m.share.toFixed(3));
  check(m.fold !== null || (m.gap >= 8 && m.clear), "the files never sit flush on, or over, the text field", JSON.stringify(m));
  const whole = await chipsWhole(page);
  check(whole.partial.length === 0, "every file shows whole, or they fold away", JSON.stringify(whole));
  const lines = await textLines(page);
  check(lines.lines >= 1.98 && lines.whole, "the text field keeps at least 2 whole lines of the message", JSON.stringify(lines));
  if (m.fold !== null) {
    check(m.fold === "8 files attached" && m.expanded === "false", "where they don't fit, the files fold into one “8 files attached” button", JSON.stringify(m));
    await h.shot("folded");
    await page.click("[data-attachment-fold]");
    await sleep(200);
    const open = await page.evaluate(() => {
      const list = document.querySelector("[data-attachment-list]");
      const r = list.getBoundingClientRect();
      const wrap = document.querySelector("[data-composer-wrap]").getBoundingClientRect();
      return {
        hidden: list.hidden,
        shown: [...list.querySelectorAll("li")].filter((li) => li.getBoundingClientRect().height > 0).length,
        above: r.bottom <= document.querySelector("[data-attachment-tray]").getBoundingClientRect().top + 1,
        share: wrap.height / innerHeight,
      };
    });
    check(!open.hidden && open.shown === 8 && open.above && open.share <= 0.401, "the button shows the files in a panel above the message box, which stays within 40%", JSON.stringify(open));
    await h.shot("opened");
    await page.focus('[data-attachment-list] [data-remove-attachment]');
    await page.keyboard.press("Escape");
    await sleep(150);
    const closed = await page.evaluate(() => ({ hidden: document.querySelector("[data-attachment-list]").hidden, focus: document.activeElement?.hasAttribute("data-attachment-fold") }));
    check(closed.hidden && closed.focus, "Escape folds the files again, back on the button", JSON.stringify(closed));
  }
}

// ---- Round 3 (personas' second re-check, brief "Team C3") ----

const replaceApproval = {
  waitApproval: true,
  id: "toolu_r",
  summary: "Replace the file clients/hartwell.md with new contents (5 lines).",
  detail: "# Hartwell\n\n- Call on Monday\n- Send the draft\n- Invoice in November",
  before: "# Hartwell\n\n- Call on Monday\n- Send the draft\n- Invoice in October",
  path: "clients/hartwell.md",
  action: "replace",
};
/** The visible text of an element that a screen reader reads (not aria-hidden), whitespace collapsed. */
const readText = (page, sel) =>
  page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const out = [];
    const walk = (n) => {
      if (n.nodeType === 3) out.push(n.textContent);
      else if (n.nodeType === 1 && n.getAttribute("aria-hidden") !== "true") n.childNodes.forEach(walk);
    };
    walk(root);
    return out.join(" ").replace(/\s+/g, " ").trim();
  }, sel);
/** The text of the elements an element's aria-describedby names. */
const description = (page, sel) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return (el?.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent.replace(/\s+/g, " ").trim())
      .join(" | ");
  }, sel);

const ROUND3 = [
  // 1. Files attached never squeeze the message below 2 whole lines: the files fold first (Tomás M1).
  {
    name: "c3r-composer-two-lines",
    sizes: [[760, 560]],
    sizesRequired: true,
    mock: { settings: scaled(SETTINGS, 2), threads: { school: LOADED } },
    async run(page, h) {
      await h.waitText("Test 1, on Thursday.");
      await pick(page, EIGHT.slice(0, 3));
      await page.waitForFunction(() => document.querySelectorAll("[data-attachment-list] li").length === 3, { timeout: 5000 });
      await page.focus(COMPOSER);
      await page.keyboard.type("Here are my notes for the week. ".repeat(8));
      await sleep(300);
      const lines = await textLines(page);
      check(lines.lines >= 1.98 && lines.whole, "with files attached the text field still shows 2 or more whole lines", JSON.stringify(lines));
      const clip = await page.evaluate(() => {
        const input = document.querySelector("[data-composer-input]");
        const lh = parseFloat(getComputedStyle(input).lineHeight);
        const off = input.scrollTop % lh;
        return { clip: getComputedStyle(input).clipPath, aligned: off < 1 || off > lh - 1, scrollTop: input.scrollTop, lh };
      });
      check(clip.clip.startsWith("inset") && clip.aligned, "scrolled by whole lines, with no half line showing in the padding", JSON.stringify({ ...clip, ...lines }));
      const whole = await chipsWhole(page);
      check(whole.partial.length === 0, "no file shows in part", JSON.stringify(whole));
      const m = await page.evaluate(() => {
        const wrap = document.querySelector("[data-composer-wrap]").getBoundingClientRect();
        const bar = document.querySelector("[data-composer] .group\\/toolbar").getBoundingClientRect();
        const root = document.querySelector("[data-composer]").getBoundingClientRect();
        return { share: wrap.height / innerHeight, inside: bar.bottom <= root.bottom + 0.5 && root.bottom <= wrap.bottom + 0.5 };
      });
      check(m.share <= 0.401 && m.inside, "and the message box stays within 40% of the window, nothing spilling out", JSON.stringify(m));
      await h.shot("typed");
    },
  },

  // 4. The tray shows whole chips or folds, also with Larger click targets (Jordan N5, Priya N10).
  ...[
    ["large-3", 3, scaled(SETTINGS, 1, LARGE), [[760, 560], [1100, 720]]],
    ["six", 6, SETTINGS, [[760, 560]]],
  ].map(([label, n, settings, sizes]) => ({
    name: `c3r-tray-whole-${label}`,
    sizes,
    sizesRequired: true,
    mock: { settings, threads: { school: LOADED } },
    async run(page, h) {
      await h.waitText("Test 1, on Thursday.");
      await pick(page, EIGHT.slice(0, n));
      await page.waitForFunction((n) => document.querySelectorAll("[data-attachment-list] li").length === n, { timeout: 5000 }, n);
      await sleep(300);
      const whole = await chipsWhole(page);
      check(whole.partial.length === 0, `${n} files: every chip shows whole, or the files fold into one button`, JSON.stringify(whole));
      await h.shot("tray");
    },
  })),
  {
    name: "c3r-fold-closes",
    sizes: [[760, 560]],
    sizesRequired: true,
    mock: { settings: scaled(SETTINGS, 2), threads: { school: LOADED } },
    async run(page, h) {
      await h.waitText("Test 1, on Thursday.");
      await pick(page, EIGHT);
      await page.waitForSelector("[data-attachment-fold]", { timeout: 5000 });
      const inBar = await page.evaluate(() => !!document.querySelector("[data-attachment-fold]").closest(".group\\/toolbar"));
      check(inBar, "folded, the files' button sits in the toolbar (no row of its own above the text)");
      const isOpen = () => page.evaluate(() => !document.querySelector("[data-attachment-list]").hidden);
      await page.click("[data-attachment-fold]");
      await sleep(150);
      check(await isOpen(), "the button opens the list");
      await page.keyboard.press("Escape");
      await sleep(150);
      const esc = await page.evaluate(() => ({ open: !document.querySelector("[data-attachment-list]").hidden, focus: document.activeElement?.hasAttribute("data-attachment-fold") }));
      check(!esc.open && esc.focus, "Escape on the button itself closes the list, focus stays on the button", JSON.stringify(esc));
      await page.click("[data-attachment-fold]");
      await sleep(150);
      await page.click(COMPOSER);
      await page.keyboard.type("Typing now");
      await sleep(150);
      check(!(await isOpen()), "moving into the text field to type closes the list");
      await h.shot("typing");
    },
  },

  // 2. A key saved after the no-key error: Send again takes focus, in view; said once (Linda, Maya M2, Tomás M2).
  {
    name: "c3r-key-saved-send-again",
    sizes: [[1100, 720], [760, 560]],
    mock: { settings: NO_KEY, threads: {}, sendError: { code: "noApiKey", message: "no API key saved" } },
    async run(page, h) {
      await page.waitForSelector("[data-setup-card]", { timeout: 5000 });
      await send(page, "When is Test 1?");
      await page.waitForSelector('[data-error-code="noApiKey"]', { timeout: 5000 });
      await page.click('[data-error-action="setup"]');
      await sleep(150);
      // Count what is spoken from here: alert text that appears, and live-region text.
      await page.evaluate(() => {
        window.__spoken = [];
        new MutationObserver((ms) => {
          for (const m of ms) {
            const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
            const live = el?.closest('[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"]');
            if (live && live.textContent.trim()) window.__spoken.push(live.textContent.trim());
            for (const n of m.addedNodes) if (n.nodeType === 1 && n.matches('[role="alert"]') && n.textContent.trim()) window.__spoken.push(n.textContent.trim());
          }
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      await page.keyboard.type(GOOD_KEY);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.activeElement?.dataset.errorAction === "retry", { timeout: 3000 }).catch(() => {});
      await sleep(300);
      const s = await page.evaluate(() => {
        const b = document.activeElement;
        const desc = (b?.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent).join(" ");
        return { focus: b?.dataset.errorAction ?? b?.tagName, desc, spoken: window.__spoken, done: document.querySelector("[data-setup-done]")?.textContent.replace(/\s+/g, " ") };
      });
      check(s.focus === "retry", "focus goes to the message's Send again, not the empty message box", JSON.stringify(s));
      check(s.desc.includes("Your key is saved"), "Send again is described by “Your key is saved…”, said as it takes focus", s.desc);
      check(s.spoken.length === 0, "nothing else is announced on top (no alert, no second status line)", JSON.stringify(s.spoken));
      check(s.done.includes("Send again") && !s.done.includes("first message"), "the setup card points to Send again, not “type your first message”", s.done);
      const vis = await inLog(page, '[data-error-action="retry"]');
      check(vis.inside, "Send again is in view", JSON.stringify(vis));
      await h.shot("saved");
      await mock(page, { sendError: null });
      await page.keyboard.press("Enter");
      await h.waitText("Done.");
      const after = await page.evaluate(() => document.querySelector("[data-setup-done]")?.textContent);
      check(!after.includes("waiting above"), "once sent, the setup card no longer says the message is waiting", after);
    },
  },
  {
    name: "c3r-key-saved-send-again-200",
    sizes: [[760, 560]],
    sizesRequired: true,
    mock: { settings: scaled(NO_KEY, 2), threads: {}, sendError: { code: "noApiKey", message: "no API key saved" } },
    async run(page, h) {
      await page.waitForSelector("[data-setup-card]", { timeout: 5000 });
      await send(page, "When is Test 1?");
      await page.waitForSelector('[data-error-code="noApiKey"]', { timeout: 5000 });
      await page.click('[data-error-action="setup"]');
      await sleep(150);
      await page.keyboard.type(GOOD_KEY);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.activeElement?.dataset.errorAction === "retry", { timeout: 3000 }).catch(() => {});
      await sleep(300);
      const focus = await page.evaluate(() => document.activeElement?.dataset.errorAction ?? document.activeElement?.tagName);
      check(focus === "retry", "at 200% in a small window focus goes to Send again", focus);
      const vis = await inLog(page, '[data-error-action="retry"]');
      check(vis.inside, "and Send again is scrolled into view, not under the message box", JSON.stringify(vis));
      await h.shot("saved");
    },
  },

  // 3. Claude Code not installed, from the setup card: a warning with the install link (Linda 3).
  {
    name: "c3r-setup-cli-missing",
    sizes: [[1100, 720]],
    mock: { settings: NO_KEY, threads: {}, claudeCli: { installed: false } },
    async run(page, h) {
      await page.waitForSelector("[data-setup-cli]", { timeout: 5000 });
      await page.click("[data-setup-cli]");
      await page.waitForFunction(() => document.querySelector("[data-setup-card]").textContent.includes("isn’t installed"), { timeout: 3000 });
      const s = await page.evaluate(() => {
        const card = document.querySelector("[data-setup-card]");
        const box = card.querySelector("[data-cli-missing]");
        const link = box?.querySelector("a");
        return { box: !!box, href: link?.getAttribute("href"), text: link?.textContent, red: !!card.querySelector(".text-danger-ink") };
      });
      check(s.box && s.href === "https://docs.anthropic.com/en/docs/claude-code/setup" && s.text.startsWith("How to install Claude Code"), "it links to how to install Claude Code, as Settings does", JSON.stringify(s));
      check(!s.red, "shown as a warning, not a red error", JSON.stringify(s));
      check((await calls(page, "settings_set_backend")).length === 0, "and nothing was switched");
      await h.shot("missing");
    },
  },

  // 5. Card verbosity and key hints (Maya N6, N9, M3; Dev nits).
  {
    name: "c3r-approval-verbosity",
    sizes: [[1100, 720]],
    mock: { threads: {}, turn: [{ kind: "text", delta: "Updating it." }, replaceApproval] },
    async run(page, h) {
      await send(page, "Update Hartwell.");
      await page.waitForSelector("[data-approval-card]", { timeout: 5000 });
      await page.waitForFunction(() => document.activeElement?.matches("[data-approval-card]"), { timeout: 3000 });
      const heading = await page.$eval("[data-approval-card] h3", (e) => e.textContent.replace(/\s+/g, " ").trim());
      const desc = await description(page, "[data-approval-card]");
      check(!desc.includes("Replace") && !desc.includes("clients/hartwell.md"), "the description doesn't repeat the heading", `${heading} || ${desc}`);
      const read = await readText(page, "[data-approval-card]");
      const summary = (read.match(/1 line removed, 1 added/g) ?? []).length;
      check(summary === 0, "the change summary isn't read as text before the preview (it is the preview's name)", read);
      const name = await page.$eval("[data-approval-preview]", (e) => document.getElementById(e.getAttribute("aria-labelledby"))?.textContent);
      check(name?.includes("1 line removed, 1 added"), "the preview is named by the summary, read once there", name);
      // Tab stops from the card to Don't allow.
      const stops = [];
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        const t = await page.evaluate(() => document.activeElement?.textContent.replace(/\s+/g, " ").trim().slice(0, 20) || document.activeElement?.getAttribute("role"));
        stops.push(t);
        if (t.startsWith("Don’t allow")) break;
      }
      const viewStops = stops.filter((s) => ["Changes", "Formatted", "Plain text"].includes(s)).length;
      check(viewStops === 1 && stops.length <= 4, "the three views are one Tab stop (views, preview, Show all, then Don't allow)", JSON.stringify(stops));
      const keys = await page.$$eval("[data-approval-card] [data-card-actions] button", (bs) => bs.map((b) => ({ caps: [...b.querySelectorAll("[data-cap]")].map((k) => getComputedStyle(k, "::after").content.replace(/"/g, "")).join(""), hidden: b.querySelector("[data-key-hint]")?.getAttribute("aria-hidden"), shown: getComputedStyle(b.querySelector("[data-key-hint]")).display !== "none", aria: b.getAttribute("aria-keyshortcuts") })));
      check(keys[0].caps === "⌘⌫" && keys[1].caps === "⌘↩" && keys.every((k) => k.hidden === "true" && k.shown), "Don’t allow and Allow show ⌘⌫ and ⌘↩", JSON.stringify(keys));
      check(keys[0].aria === "Meta+Backspace" && keys[1].aria === "Meta+Enter", "and say them as aria-keyshortcuts", JSON.stringify(keys));
      // The views: one group, the arrows choose.
      await page.focus('[data-approval-views] [aria-checked="true"]');
      await page.keyboard.press("ArrowRight");
      await sleep(100);
      const v = await page.evaluate(() => ({ checked: document.querySelector('[data-approval-views] [aria-checked="true"]')?.dataset.view, focus: document.activeElement?.dataset.view }));
      check(v.checked === "formatted" && v.focus === "formatted", "Arrow Right shows the next view", JSON.stringify(v));
      await h.shot("card");
    },
  },
  {
    name: "c3r-access-verbosity",
    sizes: [[1100, 720]],
    mock: { threads: {}, turn: [{ kind: "text", delta: "One moment." }, access] },
    async run(page, h) {
      await send(page, "Plan my week.");
      await page.waitForSelector("[data-access-request]", { timeout: 5000 });
      const read = await readText(page, "[data-access-request]");
      const wrong = (read.match(/may be wrong/g) ?? []).length;
      check(wrong === 1, "“may be wrong” is read once", read);
      const desc = await description(page, "[data-access-request]");
      check(desc.split(" | ").length === 2 && !desc.includes("Read only") && !desc.includes("Always allow"), "the description is the summary and the reason, not the whole card", desc);
      const keys = await page.$$eval("[data-access-request] [data-card-actions] > button", (bs) => bs.map((b) => [...b.querySelectorAll("[data-cap]")].map((k) => getComputedStyle(k, "::after").content.replace(/"/g, "")).join("")));
      check(keys.join() === "⌘⌫,⌘↩", "Deny and Allow show their keys", JSON.stringify(keys));
    },
  },

  // 6. The access card's "Always allow" box is never hidden behind the answer row (Jordan 2).
  {
    name: "c3r-access-keep-visible",
    sizes: [[760, 560]],
    sizesRequired: true,
    mock: { settings: scaled(SETTINGS, 1, LARGE), threads: { school: LOADED }, turn: [{ kind: "text", delta: "One moment." }, access] },
    async run(page, h) {
      await send(page, "Plan my week.");
      await page.waitForSelector("[data-access-request]", { timeout: 5000 });
      await sleep(500);
      const s = await page.evaluate(() => {
        const box = document.querySelector("[data-access-keep]");
        const r = box.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const log = document.querySelector('[role="log"]').getBoundingClientRect();
        return { hits: at === box || box.closest("label").contains(at), inLog: r.top >= log.top && r.bottom <= log.bottom };
      });
      check(s.hits && s.inLog, "the Always allow box is in view and clickable, not under the button row", JSON.stringify(s));
      const row = await page.$$eval("[data-access-request] [data-card-actions] > button", (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().top)));
      check(row.length === 2 && row[0] === row[1], "Deny and Allow stay on one row (key caps give way first)", JSON.stringify(row));
      await page.click("[data-access-keep]");
      const allow = await page.$eval("[data-access-allow]", (b) => b.dataset.accessAllow);
      check(allow === "always", "a click on it ticks it", allow);
      await h.shot("card");
    },
  },

  // 7. Escape from an Arrow Up edit goes back to the message box (Dev).
  {
    name: "c3r-arrow-up-escape",
    sizes: [[1100, 720]],
    mock: { threads: { school: LOADED } },
    async run(page, h) {
      await h.waitText("Test 1, on Thursday.");
      await page.focus(COMPOSER);
      await page.keyboard.press("ArrowUp");
      await page.waitForSelector("[data-editing]", { timeout: 3000 });
      await page.keyboard.press("Escape");
      await sleep(200);
      const a = await page.evaluate(() => ({ editing: !!document.querySelector("[data-editing]"), composer: document.activeElement?.hasAttribute("data-composer-input") }));
      check(!a.editing && a.composer, "Escape from an Arrow Up edit returns to the message box", JSON.stringify(a));
      // Opened with the Edit button, Escape still goes back to that button.
      const edits = await page.$$("[data-edit-message]");
      await edits[edits.length - 1].click();
      await page.waitForSelector("[data-editing]", { timeout: 3000 });
      await page.keyboard.press("Escape");
      await sleep(200);
      const b = await page.evaluate(() => document.activeElement?.hasAttribute("data-edit-message"));
      check(b, "an edit opened with its Edit button returns to that button");
    },
  },

  // 8. Plain words: no "vault", no "revoke", a short composer description (Priya, Maya N8).
  {
    name: "c3r-plain-words-error",
    sizes: [[1100, 720]],
    mock: { threads: {}, sendError: { code: "invalidSpace", message: "space folder missing" } },
    async run(page, h) {
      await send(page, "Hi");
      await page.waitForSelector('[data-error-code="invalidSpace"]', { timeout: 5000 });
      const t = await page.$eval('[data-error-code="invalidSpace"]', (e) => e.textContent);
      check(!/vault/i.test(t) && t.includes("Phaethon folder"), "the missing-folder error says “your Phaethon folder”, not “vault”", t);
      const hint = await description(page, COMPOSER);
      check(hint.length <= 60 && !hint.includes("Option"), "the message box's description is one short hint", hint);
    },
  },
  {
    name: "c3r-plain-words-access",
    sizes: [[1100, 720]],
    mock: { threads: {}, turn: [{ ...access, space: "home", path: "budget.md" }, { kind: "text", delta: "Read it." }] },
    async run(page, h) {
      await send(page, "Budget?");
      await page.waitForSelector("[data-access-request]", { timeout: 5000 });
      const t = await page.$eval("[data-access-request]", (e) => e.textContent);
      check(!/vault|take it back|revoke/i.test(t) && t.includes("Phaethon folder") && t.includes("remove it in"), "the access card says “your Phaethon folder” and “remove”", t);
      await page.click("[data-access-keep]");
      await page.click("[data-access-allow]");
      await h.waitText("Read it.");
      const r = await page.$eval('[data-access-receipt="always"]', (e) => e.textContent);
      check(!/revoke/i.test(r) && r.includes("remove it"), "the receipt says “remove”, not “revoke”", r);
    },
  },

  // 9. With Claude Code answering, the empty state says what it can do, and nothing it can't (Sam 4b, 5).
  {
    name: "c3r-empty-claude-code",
    sizes: [[1100, 720]],
    mock: {
      settings: { ...SETTINGS, backend: "claude-cli" },
      threads: {},
      grants: {
        school: [
          { id: "g1", from: "work", path: "clients/mk/intake.pdf", created: "2026-10-09T10:00:00Z", scope: "always" },
          { id: "g2", from: "work", path: "calendar", created: "2026-10-09T10:00:00Z", scope: "always" },
        ],
      },
    },
    async run(page, h) {
      await page.waitForFunction(() => document.querySelector("[data-empty-reach]")?.textContent.includes("Claude Code"), { timeout: 5000 });
      await h.idle();
      const t = await page.$eval("[data-empty-reach]", (e) => e.textContent.replace(/\s+/g, " ").trim());
      check(!t.includes("asks before"), "it doesn't promise to ask before changing anything", t);
      check(t.includes("can’t change") && t.includes("Work / calendar") && !t.includes("intake.pdf"), "it says it can't change files, and names only the folders Claude Code can read", t);
      await h.shot("empty");
    },
  },
];

export default [
  ...ROUND3,
  firstRun("c3-first-run", 1),
  firstRun("c3-first-run-200", 2),

  {
    name: "c3-first-run-send-before-setup",
    sizes: [[1100, 720], [760, 560]],
    mock: { settings: NO_KEY, threads: {}, sendError: { code: "noApiKey", message: "no API key saved" } },
    async run(page, h) {
      await page.waitForSelector("[data-setup-card]", { timeout: 5000 });
      await send(page, "When is Test 1?");
      await page.waitForSelector('[data-error-code="noApiKey"]', { timeout: 5000 });
      await h.idle();
      const s = await page.evaluate(() => {
        const err = document.querySelector('[data-error-code="noApiKey"]').getBoundingClientRect();
        const card = document.querySelector("[data-setup-card]");
        return { card: !!card, below: card ? card.getBoundingClientRect().top >= err.bottom : false, actions: [...document.querySelectorAll("[data-error-action]")].map((b) => b.dataset.errorAction) };
      });
      check(s.card && s.below, "the setup card stays, under the error", JSON.stringify(s));
      check(s.actions.join() === "setup,settings", "the error's first way out is “Set up now”, Settings second", JSON.stringify(s.actions));
      const title = await inLog(page, "[data-error-title]");
      check(title.inside, "the error's title is in view", JSON.stringify(title));
      await h.shot("error");
      await page.click('[data-error-action="setup"]');
      await sleep(200);
      const f = await page.evaluate(() => document.activeElement?.hasAttribute("data-setup-key"));
      check(f, "Set up now puts focus in the key field");
      check((await inLog(page, "[data-setup-key]")).inside, "and shows it");
      await page.keyboard.type(GOOD_KEY);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector("[data-error-title]")?.textContent === "Your key is saved", { timeout: 5000 });
      const after = await page.evaluate(() => ({
        actions: [...document.querySelectorAll("[data-error-action]")].map((b) => b.dataset.errorAction),
        resolved: document.querySelector("[data-error-code]").hasAttribute("data-error-resolved"),
        title: document.querySelector("[data-error-title]").textContent,
      }));
      check(after.actions.join() === "retry" && after.resolved, "once the key is saved the error says so and offers Send again", JSON.stringify(after));
      await h.shot("saved");
      await mock(page, { sendError: null });
      await page.click('[data-error-action="retry"]');
      await h.waitText("Done.");
      const sent = await calls(page, "agent_send");
      check(sent.length === 2 && sent[1].prompt === "When is Test 1?", "Send again sends the same message", JSON.stringify(sent.map((c) => c.prompt)));
    },
  },

  {
    name: "c3-error-billing-link",
    sizes: [[1100, 720]],
    mock: { threads: {}, sendError: { code: "billing", message: "credit balance is too low" } },
    async run(page, h) {
      await send(page, "Hi");
      await page.waitForSelector('[data-error-code="billing"]', { timeout: 5000 });
      const a = await page.evaluate(() => {
        const el = document.querySelector('[data-error-action="billing"]');
        return el && { tag: el.tagName, href: el.getAttribute("href"), text: el.textContent };
      });
      check(a?.tag === "A" && a.href === "https://console.anthropic.com/settings/billing" && a.text.startsWith("Open Billing"), "the out-of-credit error links to Billing", JSON.stringify(a));
    },
  },

  {
    name: "c3-setup-credit-check-again",
    sizes: [[1100, 720]],
    mock: { settings: NO_KEY, threads: {}, keyCheck: { ok: false, problem: "billing", message: "Your credit balance is too low." } },
    async run(page, h) {
      await page.waitForSelector("[data-setup-key]", { timeout: 5000 });
      await page.focus("[data-setup-key]");
      await page.keyboard.type(GOOD_KEY);
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-setup-credit]", { timeout: 5000 });
      check(!!(await page.$("[data-setup-recheck]")), "the add-credit step has Check again");
      await page.click("[data-setup-recheck]");
      await page.waitForSelector("[data-setup-recheck-result]", { timeout: 5000 });
      const still = await page.$eval("[data-setup-recheck-result]", (e) => e.textContent);
      check(still.includes("still no credit"), "Check again says when there is still no credit", still);
      await mock(page, { keyCheck: { ok: true, message: "This key works." } });
      await page.click("[data-setup-recheck]");
      await page.waitForSelector("[data-setup-done]", { timeout: 5000 });
      const checks = await calls(page, "api_key_check");
      check(checks.length === 3 && checks.every((c) => c.key === GOOD_KEY), "Check again checks the same key with Anthropic", checks.length);
      await h.shot("ready");
    },
  },

  {
    name: "c3-error-title-visible",
    sizes: [[760, 560], [1100, 720]],
    mock: { settings: scaled(SETTINGS, 2), threads: { school: LONG_THREAD }, sendError: { code: "unavailable", message: "overloaded" } },
    async run(page, h) {
      await h.waitText("Question 6");
      await send(page, "Tell me about chapter 9 in detail, with examples.");
      await page.waitForSelector('[data-error-code="unavailable"]', { timeout: 5000 });
      await sleep(400);
      const t = await inLog(page, "[data-error-title]");
      check(t.inside, "the error's title is scrolled into view", JSON.stringify(t));
    },
  },

  ...[
    ["approval", [approval()], "[data-approval-card]"],
    ["access", [access], "[data-access-request]"],
  ].map(([kind, turn, card]) => ({
    name: `c3-card-actions-${kind}`,
    sizes: [[760, 560]],
    sizesRequired: true,
    mock: { settings: scaled(SETTINGS, 1, LARGE), threads: { school: LOADED }, turn: [{ kind: "text", delta: "One moment." }, ...turn] },
    async run(page, h) {
      await send(page, "Do it.");
      await page.waitForSelector(card, { timeout: 5000 });
      await sleep(500);
      const s = await page.evaluate((card) => {
        const c = document.querySelector(card).getBoundingClientRect();
        const l = document.querySelector('[role="log"]').getBoundingClientRect();
        return { taller: c.height > l.height };
      }, card);
      const top = await inLog(page, `${card} h3`);
      check(top.inside, "the card's heading is in view", JSON.stringify(top));
      const row = await inLog(page, `${card} [data-card-actions]`);
      check(row.inside, `the answer buttons are in view, above the composer${s.taller ? " (the card is taller than the conversation)" : ""}`, JSON.stringify(row));
      const hit = await page.evaluate((card) => {
        const b = [...document.querySelectorAll(`${card} [data-card-actions] button`)].pop();
        const r = b.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { height: r.height, hits: b.contains(at) };
      }, card);
      check(hit.hits && hit.height >= 44, "a click on the yes button lands on it (44 px with Larger click targets)", JSON.stringify(hit));
    },
  })),

  {
    name: "c3-task-list",
    sizes: [[1100, 720]],
    mock: { threads: { school: [{ role: "user", text: "Plan?" }, { role: "assistant", text: `## Saturday\n\n- [ ] BIO lab 3 results\n- [x] Break\n- [ ] MATH 6.2 WebAssign ${"and a long note that wraps onto more lines ".repeat(4)}\n` }] } },
    async run(page, h) {
      await h.waitText("BIO lab 3");
      const s = await page.evaluate(() => {
        const log = document.querySelector('[role="log"]');
        const ul = log.querySelector("ul.contains-task-list");
        const boxes = [...log.querySelectorAll("[data-task]")];
        return {
          inputs: log.querySelectorAll('input[type="checkbox"]').length,
          bullets: ul ? getComputedStyle(ul).listStyleType : "no list",
          boxes: boxes.map((b) => b.dataset.task),
          opacity: boxes.map((b) => getComputedStyle(b).opacity),
          spoken: boxes.map((b) => b.querySelector(".sr-only")?.textContent),
        };
      });
      check(s.inputs === 0, "no disabled checkboxes", s.inputs);
      check(s.bullets === "none", "no bullet in front of the boxes", s.bullets);
      check(s.boxes.join() === "todo,done,todo" && s.opacity.every((o) => o === "1"), "one box per item, at full strength, ticked where done", JSON.stringify(s));
      check(s.spoken.join() === "To do: ,Done: ,To do: ", "each box is read as To do or Done", JSON.stringify(s.spoken));
      const hang = await page.evaluate(() => {
        const li = [...document.querySelectorAll('[role="log"] li')].pop();
        const box = li.querySelector("[data-task]").getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(li);
        const rects = [...text.getClientRects()].filter((r) => r.width > 0 && r.left > box.right);
        return { lines: new Set(rects.map((r) => Math.round(r.top))).size, firstTop: Math.round(rects[0].top), boxTop: Math.round(box.top), lineH: parseFloat(getComputedStyle(li).lineHeight), left: Math.min(...rects.map((r) => Math.round(r.left))), boxRight: Math.round(box.right) };
      });
      check(hang.lines > 1 && Math.abs(hang.firstTop - hang.boxTop) < hang.lineH && hang.left > hang.boxRight, "a long item starts beside its box and wraps under its own text", JSON.stringify(hang));
    },
  },

  {
    name: "c3-receipt-gap",
    sizes: [[1100, 720]],
    mock: { threads: {}, turn: [{ kind: "text", delta: "I'll save it." }, approval(), { kind: "text", delta: " OK, here it is in the chat instead." }] },
    async run(page, h) {
      await send(page, "Save the plan.");
      await page.waitForSelector("[data-approval-card]", { timeout: 5000 });
      await page.click("[data-approval-card] [data-card-actions] button");
      await h.waitText("here it is in the chat");
      await sleep(300);
      const gap = await page.evaluate(() => {
        const r = document.querySelector('[data-record="approval"]');
        let next = r.nextElementSibling ?? r.parentElement.nextElementSibling;
        while (next && next.getBoundingClientRect().height === 0) next = next.nextElementSibling;
        return next ? Math.round(next.getBoundingClientRect().top - r.getBoundingClientRect().bottom) : null;
      });
      check(gap !== null && gap >= 16, "the Not allowed receipt has a paragraph's gap before the text after it", gap);
    },
  },

  {
    name: "c3-table-wrap-words",
    sizes: [[760, 560]],
    sizesRequired: true,
    mock: {
      settings: scaled(SETTINGS, 2),
      threads: {
        school: [
          { role: "user", text: "Week?" },
          { role: "assistant", text: "| Day | Standard | Homework | Notes |\n| --- | --- | --- | --- |\n| Monday | Recursion | Problem set four | Bring the formula sheet and a pencil |\n| Tuesday | Induction | Reading | See https://example.edu/c241/notes/week-six/induction-and-recursion-handout.pdf |\n" },
        ],
      },
    },
    async run(page, h) {
      await h.waitText("Recursion");
      await page.waitForSelector("[data-table-wrap]", { timeout: 5000 });
      await page.click("[data-table-wrap]");
      await sleep(200);
      const broken = await page.evaluate(() => {
        const out = [];
        for (const cell of document.querySelectorAll("[data-md-table] th, [data-md-table] td")) {
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (n.parentElement.closest("a, code")) continue;
            for (const m of n.textContent.matchAll(/[A-Za-z]{2,}/g)) {
              const r = document.createRange();
              r.setStart(n, m.index);
              r.setEnd(n, m.index + m[0].length);
              const lines = new Set([...r.getClientRects()].map((x) => Math.round(x.top)));
              if (lines.size > 1) out.push(m[0]);
            }
          }
        }
        return out;
      });
      check(broken.length === 0, "Wrap to fit never breaks a word across lines", broken.join(", "));
    },
  },

  {
    name: "c3-regenerate-confirm",
    sizes: [[1100, 720]],
    mock: { settings: scaled(SETTINGS, 1, LARGE), threads: { school: LOADED } },
    async run(page, h) {
      await h.waitText("Test 1, on Thursday.");
      const gap = await page.evaluate(() => {
        const row = [...document.querySelectorAll("[data-reply-actions]")].pop();
        const copy = row.querySelector("[data-copy-reply]").getBoundingClientRect();
        const regen = row.querySelector('[data-reply-again="regenerate"]').getBoundingClientRect();
        return Math.round(regen.left - copy.right);
      });
      check(gap >= 44, "Copy and Regenerate are at least a target apart (44 px with Larger click targets)", gap);
      const copyText = await page.$$eval("[data-copy-reply]", (bs) => bs.map((b) => b.textContent.trim()));
      check(copyText.every((t) => t === "Copy reply"), "Copy says what it copies", JSON.stringify(copyText));
      await page.click('[data-reply-again="regenerate"]');
      await sleep(200);
      check((await calls(page, "agent_send")).length === 0, "a press on Regenerate alone replaces nothing");
      const c = await page.evaluate(() => ({
        q: document.querySelector("[data-regenerate-confirm]")?.textContent,
        focus: document.activeElement?.hasAttribute("data-regenerate-keep"),
      }));
      check(c.q?.includes("kept in past conversations") && c.focus, "it asks first, with focus on Keep this reply", JSON.stringify(c));
      await h.shot("confirm");
      await page.keyboard.press("Escape");
      await sleep(100);
      const back = await page.evaluate(() => ({ confirm: !!document.querySelector("[data-regenerate-confirm]"), focus: document.activeElement?.dataset.replyAgain }));
      check(!back.confirm && back.focus === "regenerate", "Escape keeps the reply and returns to Regenerate", JSON.stringify(back));
      await page.click('[data-reply-again="regenerate"]');
      await page.waitForSelector("[data-regenerate-replace]");
      await page.click("[data-regenerate-replace]");
      await h.waitText("Done.");
      const sent = await calls(page, "agent_send");
      check(sent.length === 1 && sent[0].replaceFrom === 2 && sent[0].prompt === "And next week?", "Replace it regenerates the last reply", JSON.stringify(sent));
    },
  },

  {
    name: "c3-composer-cap",
    sizes: [[760, 560], [1100, 720]],
    mock: { settings: scaled(SETTINGS, 2), threads: { school: LOADED } },
    async run(page, h) {
      await composerCap(page, h);
    },
  },
  {
    // Not short for its text size (no folding): many files still keep the composer within 40%, nothing overlapping.
    name: "c3-composer-cap-150",
    sizes: [[1100, 720]],
    mock: { settings: scaled(SETTINGS, 1.5), threads: { school: LOADED } },
    async run(page, h) {
      await composerCap(page, h);
    },
  },
  {
    name: "c3-composer-cap-scale1",
    sizes: [[640, 480]],
    sizesRequired: true,
    mock: { threads: { school: LOADED } },
    async run(page, h) {
      await composerCap(page, h);
    },
  },

  {
    name: "c3-live-region-combined",
    sizes: [[1100, 720]],
    mock: { threads: {}, turn: [{ kind: "text", delta: "Saving it." }, approval(), { kind: "text", delta: " Fine, I won't.", delay: 10 }] },
    async run(page, h) {
      await send(page, "Save the plan.");
      await page.waitForSelector("[data-approval-card]", { timeout: 5000 });
      await sleep(300);
      await page.click("[data-approval-card] [data-card-actions] button");
      await page.waitForFunction(() => document.querySelector('[data-testid="reply-status"]').textContent.includes("replied"), { timeout: 5000 });
      const said = await status(page);
      check(said.startsWith("Not allowed: create notes.md.") && said.includes("Phaethon replied:"), "the answer and the reply are said together, neither cut off", said);
    },
  },

  {
    name: "c3-headings",
    sizes: [[1100, 720]],
    mock: { threads: { school: [{ role: "user", text: "Plan?" }, { role: "assistant", text: "## Plan\n\nIntro.\n\n#### Monday\n\nRead.\n\n## Notes\n\nDone." }] } },
    async run(page, h) {
      await h.waitText("Intro.");
      const levels = await page.evaluate(() =>
        [...document.querySelectorAll('[role="log"] [data-role="assistant"] :is(h2,h3,h4,h5,h6)')].map((e) => [Number(e.tagName[1]), e.textContent.trim()]),
      );
      const jumps = levels.filter((l, i) => i > 0 && l[0] > levels[i - 1][0] + 1);
      check(levels[0][0] === 2 && jumps.length === 0, "reply headings follow the message's h2 with no level skipped", JSON.stringify(levels));
      const look = await page.evaluate(() => {
        const [plan, mon] = [...document.querySelectorAll('[role="log"] [data-md-depth]')];
        return { plan: getComputedStyle(plan).fontSize, mon: getComputedStyle(mon).fontSize };
      });
      check(parseFloat(look.plan) > parseFloat(look.mon), "each still looks as written (## larger than ####)", JSON.stringify(look));
    },
  },

  ...[
    ["approval", [approval()], "[data-approval-card]"],
    ["access", [access], "[data-access-request]"],
  ].map(([kind, turn, card]) => ({
    name: `c3-escape-${kind}`,
    sizes: [[1100, 720]],
    mock: { threads: {}, turn: [{ kind: "text", delta: "One moment." }, ...turn] },
    async run(page, h) {
      await send(page, "Do it.");
      await page.waitForSelector(card, { timeout: 5000 });
      await page.waitForFunction((card) => document.activeElement?.matches(card), { timeout: 3000 }, card);
      await h.tab(1);
      await page.keyboard.press("Escape");
      await sleep(200);
      const s = await page.evaluate((card) => ({ composer: document.activeElement?.hasAttribute("data-composer-input"), card: !!document.querySelector(card) }), card);
      check(s.composer && s.card, "Escape on the card goes back to the composer; the card stays", JSON.stringify(s));
      const said = await status(page);
      check(said.includes("still waiting") && said.includes("Option+Return"), "and says the card is still waiting, and how to get back", said);
      check((await calls(page, "agent_approve")).length + (await calls(page, "agent_access_answer")).length === 0, "Escape answers nothing");
    },
  })),

  {
    name: "c3-stale-status",
    sizes: [[1100, 720]],
    mock: { threads: {}, turn: [{ kind: "tool", label: "Reading file notes.md" }, { kind: "error", code: "unavailable", message: "overloaded", delay: 700 }] },
    async run(page, h) {
      await send(page, "Read my notes.");
      await page.waitForFunction(() => document.querySelector('[data-testid="reply-status"]').textContent.includes("Reading"), { timeout: 5000 });
      await page.waitForSelector('[data-error-code="unavailable"]', { timeout: 5000 });
      await sleep(300);
      const said = await status(page);
      check(!said.includes("Reading"), "after an error the status no longer says what the reply was doing", said);
    },
  },

  {
    name: "c3-access-labels",
    sizes: [[1100, 720]],
    mock: { threads: {}, turn: [access, { kind: "text", delta: "Read it." }] },
    async run(page, h) {
      await send(page, "Plan my week.");
      await page.waitForSelector("[data-access-request]", { timeout: 5000 });
      const once = await page.$eval("[data-access-allow]", (b) => b.textContent.trim());
      check(once === "Allow for this reply", "Allow says how long it lasts", once);
      await page.click("[data-access-keep]");
      const always = await page.$eval("[data-access-allow]", (b) => b.textContent.trim());
      check(always === "Allow from now on", "with the box ticked it says from now on", always);
      await h.shot("ticked");
      await page.click("[data-access-allow]");
      await h.waitText("Read it.");
      const a = await calls(page, "agent_access_answer");
      check(a.length === 1 && a[0].answer === "always", "and that is what it answers", JSON.stringify(a));
    },
  },

  {
    name: "c3-empty-grant",
    sizes: [[1100, 720]],
    mock: { threads: {}, grants: { school: [{ id: "g1", from: "work", path: "clients", created: "2026-10-09T10:00:00Z", scope: "always" }] } },
    async run(page, h) {
      await page.waitForFunction(() => document.querySelector("[data-empty-reach]")?.textContent.includes("already read"), { timeout: 5000 });
      const t = await page.$eval("[data-empty-reach]", (e) => e.textContent.replace(/\s+/g, " ").trim());
      check(t.includes("it can already read Work / clients") && t.includes("anything else in another space"), "the empty state is true to a standing grant", t);
    },
  },
  {
    name: "c3-empty-no-grant",
    sizes: [[1100, 720]],
    mock: { threads: {} },
    async run(page, h) {
      await page.waitForSelector("[data-empty-reach]", { timeout: 5000 });
      await h.idle();
      const t = await page.$eval("[data-empty-reach]", (e) => e.textContent.replace(/\s+/g, " ").trim());
      check(!t.includes("already read") && t.includes("before it reads another space"), "without grants it promises to ask", t);
    },
  },

  ...[
    ["approval-allow", [approval()], "[data-approval-card]", "Enter", (c) => c.agent_approve?.[0]?.allow === true],
    ["approval-refuse", [approval()], "[data-approval-card]", "Backspace", (c) => c.agent_approve?.[0]?.allow === false],
    ["access-allow", [access], "[data-access-request]", "Enter", (c) => c.agent_access_answer?.[0]?.answer === "once"],
    ["access-refuse", [access], "[data-access-request]", "Backspace", (c) => c.agent_access_answer?.[0]?.answer === "deny"],
  ].map(([name, turn, card, key, ok]) => ({
    name: `c3-card-keys-${name}`,
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { threads: {}, turn: [{ kind: "text", delta: "One moment." }, ...turn, { kind: "text", delta: " Finished." }] },
    async run(page, h) {
      await send(page, "Do it.");
      await page.waitForSelector(card, { timeout: 5000 });
      await page.waitForFunction((card) => document.activeElement?.matches(card), { timeout: 3000 }, card);
      // In the composer the chord does nothing to the card.
      await page.focus(COMPOSER);
      await chord(page, "Meta", key);
      await sleep(150);
      check((await calls(page, "agent_approve")).length + (await calls(page, "agent_access_answer")).length === 0, "the chord answers only from the card itself");
      await page.focus(card);
      await chord(page, "Meta", key);
      await h.waitText("Finished.");
      const c = { agent_approve: await calls(page, "agent_approve"), agent_access_answer: await calls(page, "agent_access_answer") };
      check(ok(c), `Cmd+${key} on the card answers ${key === "Enter" ? "yes" : "no"}`, JSON.stringify(c));
    },
  })),

  {
    name: "c3-arrow-up-edit",
    sizes: [[1100, 720]],
    mock: { threads: { school: LOADED } },
    async run(page, h) {
      await h.waitText("Test 1, on Thursday.");
      await page.focus(COMPOSER);
      await page.keyboard.type("x");
      await page.keyboard.press("ArrowUp");
      check(!(await page.$("[data-editing]")), "Arrow Up with text in the box does not edit");
      await page.keyboard.press("End");
      await page.keyboard.press("Backspace");
      await page.keyboard.press("ArrowUp");
      await page.waitForSelector("[data-editing]", { timeout: 3000 });
      const s = await page.evaluate(() => ({ focus: document.activeElement?.hasAttribute("data-edit-input"), value: document.activeElement?.value }));
      check(s.focus && s.value === "And next week?", "Arrow Up in an empty box edits your last message", JSON.stringify(s));
    },
  },

  {
    name: "c3-stop-tip",
    sizes: [[1100, 720]],
    mock: { threads: {}, holdOpen: true, turn: [{ kind: "text", delta: "Working on it" }] },
    async run(page, h) {
      await send(page, "Go.");
      await page.waitForSelector("[data-stop]", { timeout: 5000 });
      check(!(await page.$eval("[data-stop]", (b) => b.hasAttribute("title"))), "Stop has no native title (its tooltip names it)");
      await h.hover("[data-stop]");
      await page.waitForSelector('[data-slot="tooltip-content"]', { timeout: 3000 });
      const tip = await page.evaluate(() => ({
        shown: document.querySelector('[data-slot="tooltip-content"]').innerText.trim(),
        spoken: document.querySelector('[role="tooltip"]')?.textContent.trim(),
        described: document.querySelector("[data-stop]").getAttribute("aria-describedby") === document.querySelector('[role="tooltip"]')?.id,
      }));
      check(tip.shown.startsWith("Stop reply") && tip.spoken === "Escape" && tip.described, "Stop shows its name on hover, and says its key (not its name twice)", JSON.stringify(tip));
      await h.shot("tip");
      await park(page);
    },
  },
  // Option+Return reaches the waiting card from anywhere in the window, and never presses the focused button.
  {
    name: "c3-jump-anywhere",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { threads: { school: LOADED }, turn: [{ kind: "text", delta: "I’ll write that." }, approval()] },
    async run(page) {
      await page.waitForSelector(COMPOSER, { timeout: 5000 });
      // Nothing waiting yet: it says so.
      await page.focus(COMPOSER);
      await chord(page, "Alt", "Enter");
      const none = await page.waitForFunction(() => document.querySelector("[data-shell-status]")?.textContent === "Nothing in this space is waiting for your answer.", { timeout: 2000 }).then(() => true, () => false);
      check(none, "with nothing waiting, Option+Return says so");
      await send(page, "Make notes");
      await page.waitForSelector("[data-waiting-card]", { timeout: 5000 });
      for (const [where, sel] of [
        ["Add to message", 'button[aria-label="Add to message"]'],
        ["Conversations", "[data-conversations-trigger]"],
        ["the sidebar", "#spaces-sidebar [data-space-id]"],
      ]) {
        await page.focus(sel);
        await chord(page, "Alt", "Enter");
        await sleep(150);
        const r = await page.evaluate(() => ({
          onCard: !!document.activeElement?.closest("[data-waiting-card]"),
          menu: !!document.querySelector('[role="menu"]'),
        }));
        check(r.onCard && !r.menu, `from ${where}, Option+Return goes to the card and presses nothing`, JSON.stringify(r));
      }
    },
  },
];
