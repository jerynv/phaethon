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
    check(field.inside && s.scrollTop === 0, "the key field is in view without scrolling", JSON.stringify(field));
    const save = await inLog(page, '[data-setup-card] button[type="submit"]');
    check(save.inside, "Check and save is in view too", JSON.stringify(save));
  },
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
    const short = innerHeight / parseFloat(getComputedStyle(document.documentElement).fontSize) < 28;
    return { share: wrap.height / innerHeight, fold: fold?.textContent.trim() ?? null, expanded: fold?.getAttribute("aria-expanded") ?? null, gap: Math.round(input.top - tray.bottom), clear: list.height === 0 || list.bottom <= input.top, short };
  });
  check(m.share <= 0.401, "the composer takes at most 40% of the window", m.share.toFixed(3));
  check(m.gap >= 8 && m.clear, "the files never sit flush on, or over, the text field", JSON.stringify(m));
  if (!m.short) check(m.fold === null, "a window tall enough for its text keeps the files in view", JSON.stringify(m));
  else {
    check(m.fold === "8 files attached" && m.expanded === "false", "in a short window the files fold into one “8 files attached” button", JSON.stringify(m));
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

export default [
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
        body: document.querySelector('[data-error-code] [role="alert"]').textContent,
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
];
