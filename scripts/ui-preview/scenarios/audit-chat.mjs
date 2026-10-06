// Audit: the conversation. Empty, loading and load-error states; a long thread
// mid-scroll; streaming (tool line, cross-space line, thinking); a stopped
// reply; every backend error code; approval and access cards (long, narrow,
// failed answer, receipts); the composer (focus, multi-line, + menu by
// keyboard, attachments, refusals, drag-over, Stop); copy feedback; markdown.
import {
  CONVERSATION,
  EIGHT,
  ELEVEN,
  FILES,
  LONG,
  MARKDOWN_STRESS,
  SETTINGS,
  WORK_THREAD,
  check,
  clickText,
  dragFileOver,
  park,
  pick,
} from "../audit-fixtures.mjs";

const WIDE = [[1100, 720]];
const BOTH = [[1100, 720], [640, 480]];
const LOG = '[role="log"]';
const COMPOSER = "[data-composer-input]";

const attach = async (page, paths) => {
  await pick(page, paths);
  await page.waitForFunction((n) => document.querySelectorAll('[aria-label="Attached files"] li').length >= n, { timeout: 5000 }, Math.min(paths.length, 10));
};

// ---- Backend errors, with the messages the Rust side really sends ----
const ERRORS = {
  noApiKey: "Add your Anthropic API key in Settings to start.",
  apiKey: "invalid x-api-key",
  provider: "The reply reached its length limit and was cut off.",
  network: "error sending request for url (https://api.anthropic.com/v1/messages): connection timed out",
  declined: "Claude declined to answer this. Try rephrasing your message.",
  storage: "The conversation could not be saved, so nothing was sent: Permission denied (os error 13)",
  attachment: "These files are too large together (the limit is 30 MB per message).",
  busy: "This space is still answering the previous message. Stop it or wait for it to finish.",
  invalidSpace: 'There is no space called "school" in this vault.',
  missingCli: "Claude Code was not found. Install Claude Code, then run `claude` once in a terminal to log in.",
  notLoggedIn: "Claude Code is not logged in. Run `claude` once in a terminal to log in, then try again.",
  cli: "The previous conversation for this space could not be found. Send your message again to start a new one.",
  ipc: "Phaethon could not reach its backend: command agent_send not allowed",
  somethingNew: "An error code this UI does not know yet.",
};
// The way out each code offers (message-error.tsx RECOVERY).
const ACTIONS = {
  noApiKey: ["settings", "retry"],
  apiKey: ["settings", "retry"],
  missingCli: ["settings", "retry"],
  notLoggedIn: ["retry", "settings"],
  busy: ["retry"],
  cli: ["retry"],
  provider: ["retry"],
  network: ["retry"],
  storage: ["retry"],
  somethingNew: ["retry"],
};
const errorScenarios = Object.entries(ERRORS).map(([code, message]) => ({
  name: `audit-chat-error-${code}`,
  sizes: code === "noApiKey" ? BOTH : WIDE,
  themes: code === "noApiKey" || code === "network" ? ["light", "dark"] : ["light"],
  mock: { settings: { ...SETTINGS, backend: code.includes("Cli") || code === "cli" || code === "notLoggedIn" ? "claude-cli" : "phaethon" }, threads: {}, sendError: { code, message } },
  async run(page, h) {
    await h.send("What is due this week?");
    await page.waitForSelector('[data-role="assistant"] [role="alert"]', { timeout: 5000 });
    const banner = await page.evaluate(() => {
      const box = document.querySelector('[data-role="assistant"] [data-error-code]');
      return {
        alert: box.querySelector('[role="alert"]').innerText,
        actions: [...box.querySelectorAll("[data-error-action]")].map((b) => b.dataset.errorAction),
        detail: box.querySelector("[data-error-detail]")?.textContent ?? null,
        detailOpen: box.querySelector("details")?.open ?? null,
      };
    });
    check(!banner.alert.includes(message), "the raw backend text is not the headline", banner.alert);
    check(!banner.alert.includes("`"), "no literal backticks in the banner", banner.alert);
    check(banner.detail === message.replace(/`/g, "") && banner.detailOpen === false, "the raw text is kept under a closed Details", banner.detail);
    const want = ACTIONS[code] ?? [];
    check(banner.actions.join() === want.join(), `actions are [${want.join(", ")}]`, banner.actions.join());
    if (want.includes("settings")) {
      await page.evaluate(() => {
        window.__opened = [];
        window.addEventListener("phaethon:open-settings", (e) => window.__opened.push(e.detail));
      });
      await page.click('[data-error-action="settings"]');
      const opened = await page.evaluate(() => window.__opened);
      check(opened.length === 1 && opened[0].section === "agent", 'Open Settings asks for the "agent" section', JSON.stringify(opened));
    }
    await park(page);
    await h.idle();
  },
}));

const approvalTurn = (detail, summary = "Create a new file plans/week6.md (7 lines).") => [
  { kind: "text", delta: "I'll put the plan in a file so you can tick things off." },
  { kind: "tool", label: "Waiting for you to allow: Writing file plans/week6.md" },
  { waitApproval: true, id: "toolu_1", summary, detail },
];
const SHORT_DETAIL = "# Week 6\n\n- [ ] Mon: recursion 3.1 to 3.6 (90 min)\n- [ ] Tue: problem set 4 (2 h)\n- [ ] Wed: review ch. 1 to 4 (60 min)\n";
const LONG_DETAIL = Array.from({ length: 60 }, (_, i) => `- [ ] Line ${i + 1}: ${"a very long line of plan text that keeps going ".repeat(i % 7 === 0 ? 4 : 1)}`).join("\n");

const accessTurn = (path = "calendar", space = "work", reason = "To plan study evenings, I need to see which evenings you already have work meetings.") => [
  { kind: "text", delta: "I'll check your work calendar so the plan doesn't clash with your shifts." },
  { kind: "tool", label: `Waiting for you to answer: Asking for read access to ${space}/${path}` },
  { waitAccess: true, id: "acc_1", space, path, reason },
  { kind: "tool", label: `Reading ${space}/${path}/oct.md`, delay: 120 },
  { kind: "text", delta: "\n\nYou have work on Tuesday evening, so I moved problem set 4 to Monday.", delay: 300 },
];

export default [
  // ---- Empty, loading, load error ----
  {
    name: "audit-chat-empty",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await h.idle();
      await park(page);
      await h.shot("school");
      await h.click("#spaces-sidebar li:nth-child(2) button");
      await h.idle();
      await park(page);
    },
  },
  {
    name: "audit-chat-loading",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: {}, slow: { thread_load: 60000 } },
    async run(page, h) {
      await h.waitText("Loading the conversation");
      await park(page);
    },
  },
  {
    name: "audit-chat-load-error",
    sizes: BOTH,
    mock: { settings: SETTINGS, threads: {}, fail: { thread_load: "conversation.jsonl line 14: expected value at line 1 column 1" } },
    async run(page, h) {
      await h.waitText("couldn’t be loaded");
      const before = await page.evaluate(() => window.__calls.filter((c) => c[0] === "thread_load").length);
      await page.click("[data-load-retry]");
      await page.waitForFunction((n) => window.__calls.filter((c) => c[0] === "thread_load").length > n, { timeout: 5000 }, before);
      await h.waitText("couldn’t be loaded");
      check(true, "Try again loads the conversation again (thread_load called again)");
      await park(page);
    },
  },

  // ---- Long thread ----
  {
    name: "audit-chat-long",
    sizes: [[1100, 720], [760, 560]],
    mock: { settings: SETTINGS, threads: { school: LONG } },
    async run(page, h) {
      await h.waitText("Question 16");
      await page.evaluate((sel) => {
        const log = document.querySelector(sel);
        log.scrollTop = log.scrollHeight / 2;
        log.dispatchEvent(new Event("scroll"));
      }, LOG);
      await h.idle();
      await park(page);
      await h.shot("middle");
      // An older reply's Copy only shows on hover.
      const msgs = await page.$$('[data-role="assistant"]');
      const mid = msgs[Math.floor(msgs.length / 2)];
      await mid.hover();
      await h.idle();
      await h.shot("older-reply-hover");
      // Jump to latest: its own row between the conversation and the composer, never over a message.
      const jump = await page.evaluate((sel) => {
        const b = document.querySelector("[data-jump-row] button")?.getBoundingClientRect();
        const log = document.querySelector(sel).getBoundingClientRect();
        return b && { top: b.top, bottom: b.bottom, height: b.height, logBottom: log.bottom };
      }, LOG);
      check(!!jump, "Jump to latest shows while scrolled up");
      check(jump.top >= jump.logBottom - 0.5, "it sits below the conversation, covering none of it", JSON.stringify(jump));
      const lg = await page.evaluate(() => {
        const probe = document.body.appendChild(document.createElement("div"));
        probe.style.height = "var(--ph-control-height-lg)";
        const px = probe.getBoundingClientRect().height;
        probe.remove();
        return px;
      });
      check(jump.height >= lg - 0.5, "it is at least the large control height", `${jump.height} vs ${lg}`);
      await page.hover("[data-jump-row] button");
      await h.idle();
      await h.shot("jump-hover");
      await page.click("[data-jump-row] button");
      await page.waitForFunction(() => !document.querySelector("[data-jump-row]"), { timeout: 5000 });
      const atEnd = await page.evaluate((sel) => {
        const log = document.querySelector(sel);
        return log.scrollHeight - log.scrollTop - log.clientHeight < 2 && document.activeElement === log;
      }, LOG);
      check(atEnd, "clicking it scrolls to the end, hides it, and leaves focus on the conversation");
      // An older reply's hidden Copy button reserves no space: the gap after a reply equals the gap after a question.
      const gaps = await page.evaluate(() => {
        const msgs = [...document.querySelectorAll("[data-role]")].slice(0, 4).map((m) => m.getBoundingClientRect());
        return [msgs[1].top - msgs[0].bottom, msgs[2].top - msgs[1].bottom];
      });
      check(Math.abs(gaps[0] - gaps[1]) < 1.5, "message gaps are even (question→reply equals reply→question)", gaps.join(" / "));
      await park(page);
      await h.idle();
    },
  },

  // ---- Streaming ----
  {
    name: "audit-chat-thinking",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: { school: CONVERSATION.slice(0, 2) }, holdOpen: true, turn: [] },
    async run(page, h) {
      await h.send("What did I say about recursion?");
      await h.waitText("Thinking");
      const md = await page.evaluate(() => [...document.querySelectorAll('[data-role="assistant"]')].pop().querySelectorAll(".aui-md").length);
      check(md === 0, "no empty reply (and so no stray cursor) above Thinking…", String(md));
      await park(page);
      await h.idle();
    },
  },
  {
    name: "audit-chat-streaming",
    sizes: BOTH,
    mock: {
      settings: SETTINGS,
      threads: { school: CONVERSATION.slice(0, 2) },
      holdOpen: true,
      turn: [
        { kind: "tool", label: "Reading file notes/week6.md" },
        { kind: "text", delta: "Looking at your notes, the recursion exercises you flagged are 3.1 to 3.6. You wrote that the base case" },
      ],
    },
    async run(page, h) {
      await h.send("What did I say about recursion?");
      await h.waitText("base case");
      await h.idle();
      const activity = await page.evaluate(() => document.querySelector("[data-activity]")?.textContent ?? null);
      check(activity === null, "the tool line goes once the reply's words arrive", activity);
      await park(page);
      await h.idle();
      await h.shot("stop-visible");
      await h.hover('button[aria-label="Stop reply"]');
      await h.idle();
      await h.shot("stop-hover");
      await page.focus(COMPOSER);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await h.idle();
    },
  },
  {
    name: "audit-chat-streaming-cross-space",
    sizes: WIDE,
    mock: {
      settings: SETTINGS,
      threads: { school: CONVERSATION.slice(0, 2) },
      grants: { school: [{ id: "g-cal", from: "work", path: "calendar", created: "2026-10-09T15:20:00Z", scope: "always" }] },
      holdOpen: true,
      turn: [
        { kind: "text", delta: "Checking your shifts first." },
        { kind: "tool", label: "Reading work/calendar/october-2026-shifts-and-meetings-with-the-whole-team.md" },
      ],
    },
    async run(page, h) {
      await h.send("Plan around my shifts.");
      await page.waitForSelector("[data-activity-space]", { timeout: 5000 });
      const line = await page.evaluate(() => {
        const p = document.querySelector("[data-activity]");
        const copy = p.cloneNode(true);
        copy.querySelectorAll(".sr-only").forEach((n) => n.remove());
        return { text: copy.textContent, dots: p.querySelectorAll(':scope > span[aria-hidden="true"], [data-activity-space] > span').length };
      });
      check(line.text.startsWith("Reading Work / calendar/"), "the line names the space by its display name", line.text);
      check(line.dots === 1, "one mark only: the space's own dot", String(line.dots));
      const cursor = await page.evaluate(() => {
        const last = [...document.querySelectorAll('[data-role="assistant"] .aui-md > *')].pop();
        return last ? getComputedStyle(last, "::after").content : "none";
      });
      check(["none", "normal", ""].includes(cursor), "no streaming cursor while the activity line shows", cursor);
      await park(page);
      await h.idle();
    },
  },
  {
    name: "audit-chat-stopped",
    sizes: WIDE,
    mock: {
      settings: SETTINGS,
      threads: { school: CONVERSATION.slice(0, 2) },
      holdOpen: true,
      turn: [{ kind: "text", delta: "Here is the start of a long answer about recursion, which" }],
    },
    async run(page, h) {
      await h.send("Explain recursion at length.");
      await h.waitText("long answer");
      await h.click('button[aria-label="Stop reply"]');
      await h.waitText("Reply stopped.");
      await park(page);
      await h.idle();
      const focused = await page.evaluate(() => document.activeElement?.hasAttribute("data-composer-input"));
      check(focused, "after Stop, focus is back in the composer");
      const said = await page.evaluate(() => document.querySelector('[data-testid="reply-status"]').textContent);
      check(said === "Reply stopped.", "the status region says Reply stopped.", said);
    },
  },

  ...errorScenarios,
  {
    name: "audit-chat-error-retry",
    sizes: WIDE,
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, sendError: { code: "network", message: ERRORS.network }, turn: [{ kind: "text", delta: "Problem set 4 is due Wednesday." }] },
    async run(page, h) {
      await h.send("What is due this week?");
      await page.waitForSelector('[data-error-action="retry"]', { timeout: 5000 });
      // The connection comes back; Send again re-sends the same message.
      await page.evaluate(() => (window.__MOCK__.sendError = null));
      await page.click('[data-error-action="retry"]');
      await h.waitText("Problem set 4 is due Wednesday.");
      const sends = await page.evaluate(() => window.__calls.filter((c) => c[0] === "agent_send").map((c) => c[1].prompt));
      check(sends.length === 2 && sends[1] === "What is due this week?", "Send again calls agent_send again with the same prompt", JSON.stringify(sends));
      const left = await page.evaluate(() => ({
        errors: document.querySelectorAll("[data-error-code]").length,
        users: document.querySelectorAll('[data-role="user"]').length,
      }));
      check(left.errors === 0 && left.users === 1, "the failed reply is replaced, and the question is not duplicated", JSON.stringify(left));
      const focused = await page.evaluate(() => document.activeElement?.hasAttribute("data-composer-input"));
      check(focused, "focus is in the composer after Send again");
      await park(page);
      await h.idle();
    },
  },

  // ---- Approval card ----
  {
    name: "audit-chat-approval",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION.slice(0, 2) }, holdOpen: true, turn: approvalTurn(SHORT_DETAIL) },
    async run(page, h) {
      await h.send("Yes, make the plan.");
      await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 });
      await park(page);
      await h.idle();
      await h.shot("card-focused");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await h.idle();
      await h.shot("dont-allow-focused");
      await h.hover('[role="alertdialog"] button:last-child');
      await h.idle();
    },
  },
  {
    name: "audit-chat-approval-long",
    sizes: [[1100, 720], [640, 480]],
    mock: {
      settings: SETTINGS,
      threads: { school: CONVERSATION.slice(0, 2) },
      holdOpen: true,
      turn: approvalTurn(LONG_DETAIL, "Replace plans/archive/2026/fall/c241-study-plan-for-the-whole-semester-final.md (60 lines, was 12)."),
    },
    async run(page, h) {
      await h.send("Rewrite the semester plan.");
      await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 });
      await park(page);
      await h.idle();
      await h.shot("top");
      await page.evaluate(() => document.querySelector('[role="alertdialog"]').scrollIntoView({ block: "end" }));
      await h.idle();
    },
  },
  {
    name: "audit-chat-approval-stale",
    sizes: WIDE,
    themes: ["light"],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION.slice(0, 2) }, holdOpen: true, turn: approvalTurn(SHORT_DETAIL), fail: { agent_approve: "the reply was cancelled" } },
    async run(page, h) {
      await h.send("Yes, make the plan.");
      await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 });
      await clickText(page, '[role="alertdialog"]', "Allow");
      await h.idle();
      const card = await page.evaluate(() => {
        const c = document.querySelector('[role="alertdialog"]');
        return {
          alert: c.querySelector('[role="alert"]')?.textContent ?? "",
          enabled: [...c.querySelectorAll(":scope > div:last-child > button")].filter((b) => !b.disabled).length,
          focused: document.activeElement === c,
        };
      });
      check(card.alert.startsWith("Your answer couldn’t be sent") && !card.alert.includes("the reply was cancelled"), "a failed answer is explained in plain words", card.alert);
      check(card.enabled === 0, "both answers are disabled once the answer can’t be given", String(card.enabled));
      check(card.focused, "focus moves to the card, not lost with the disabled button");
      await park(page);
    },
  },

  // ---- Access request card ----
  {
    name: "audit-chat-access",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION.slice(0, 2) }, holdOpen: true, turn: accessTurn() },
    async run(page, h) {
      await h.send("Plan my study evenings around work.");
      await page.waitForSelector("[data-access-request]", { timeout: 5000 });
      await park(page);
      await h.idle();
      await h.shot("card");
      await page.keyboard.press("Escape");
      await h.idle();
      await h.shot("escape-note");
      await page.keyboard.press("Tab");
      await h.idle();
    },
  },
  {
    name: "audit-chat-access-long",
    sizes: [[1100, 720], [640, 480]],
    themes: ["light"],
    mock: {
      settings: SETTINGS,
      threads: { school: CONVERSATION.slice(0, 2) },
      holdOpen: true,
      turn: accessTurn(
        "archive/2025/clients/northwind-traders/contracts/master-services-agreement-amendment-3-final-final.pdf",
        "work",
        "You asked me to compare the deadlines in your school plan with the contract milestones, and the milestones are only written down in this amendment, which lives in your Work space rather than here.",
      ),
    },
    async run(page, h) {
      await h.send("Compare with the contract.");
      await page.waitForSelector("[data-access-request]", { timeout: 5000 });
      await park(page);
      await h.idle();
    },
  },
  {
    name: "audit-chat-access-whole-space",
    sizes: WIDE,
    themes: ["light", "dark"],
    mock: { settings: SETTINGS, threads: {}, holdOpen: true, turn: accessTurn("", "home", "") },
    async run(page, h) {
      await h.send("Look at everything.");
      await page.waitForSelector("[data-access-request]", { timeout: 5000 });
      const card = await page.evaluate(() => {
        const c = document.querySelector("[data-access-request]");
        const copy = (el) => {
          const x = el.cloneNode(true);
          x.querySelectorAll(".sr-only").forEach((n) => n.remove());
          return x.textContent.replace(/\s+/g, " ").trim();
        };
        return { title: c.querySelector("h3").textContent, desc: c.querySelector("h3 + p").textContent, where: copy(c.querySelectorAll("p")[1]) };
      });
      check(card.title === "Phaethon wants to read from Home", "an unknown space id is title-cased", card.title);
      check(card.desc.includes("a space that isn’t in this vault"), "and said to be outside this vault", card.desc);
      check(card.where === "Everything in Home", "the whole space reads as Everything in Home", card.where);
      await park(page);
      await h.idle();
    },
  },
  ...["once", "always", "deny"].map((answer) => ({
    name: `audit-chat-access-receipt-${answer}`,
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: { school: CONVERSATION.slice(0, 2) }, turn: accessTurn() },
    async run(page, h) {
      await h.send("Plan my study evenings around work.");
      await page.waitForSelector("[data-access-request]", { timeout: 5000 });
      await clickText(page, "[data-access-request]", { once: "Allow once", always: "Always allow", deny: "Deny" }[answer]);
      await page.waitForSelector(`[data-access-receipt="${answer}"]`, { timeout: 5000 });
      await h.waitText("moved problem set 4");
      await park(page);
      await h.idle();
    },
  })),

  // ---- Composer ----
  {
    name: "audit-chat-composer",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION } },
    async run(page, h) {
      await h.idle();
      await park(page);
      await page.focus(COMPOSER);
      await page.keyboard.press("Shift"); // keyboard modality
      await h.idle();
      await h.shot("focused");
      for (let i = 1; i <= 7; i++) {
        await page.keyboard.type(`Line ${i} of a message that is long enough to show how the composer grows as it fills up.`);
        if (i < 7) {
          await page.keyboard.down("Shift");
          await page.keyboard.press("Enter");
          await page.keyboard.up("Shift");
        }
      }
      await h.idle();
      await h.shot("multiline");
      await h.hover('button[aria-label="Send message"]');
      await h.idle();
      await h.shot("send-hover");
      // The + menu, opened from the keyboard: focus lands on the item.
      await page.focus('button[aria-label="Add to message"]');
      await page.keyboard.press("Enter");
      await page.waitForSelector('[role="menu"]', { timeout: 5000 });
      await h.idle();
      const item = await page.evaluate(() => document.activeElement?.getAttribute("role"));
      check(item === "menuitem", "opening + from the keyboard focuses its item", item);
      const hidden = await page.evaluate(() =>
        [...document.querySelectorAll('[aria-hidden="true"]')].filter((el) =>
          el.matches(":is(button, textarea, input, [tabindex]):not([tabindex='-1'])") ||
          el.querySelector(":is(button, textarea, input, [tabindex]):not([tabindex='-1'])"),
        ).map((el) => el.outerHTML.slice(0, 160)),
      );
      check(hidden.length === 0, "with the menu open, nothing focusable is aria-hidden (non-modal menu)", hidden.join(" | "));
    },
  },
  {
    name: "audit-chat-attachments",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await attach(page, [FILES.image, FILES.pdf, FILES.notes]);
      await park(page);
      await h.idle();
      await h.shot("three");
      await h.hover('button[aria-label^="Remove"]');
      await h.idle();
      await h.shot("remove-hover");
      await attach(page, [FILES.longName]);
      await park(page);
      await h.idle();
      await h.shot("long-name");
      await page.evaluate(() => document.querySelectorAll('button[aria-label^="Remove"]').forEach((b) => b.click()));
      await h.idle();
      await attach(page, EIGHT);
      await park(page);
      await page.focus(COMPOSER);
      await page.keyboard.type("Sort these into folders.");
      await h.idle();
    },
  },
  {
    name: "audit-chat-attach-refused",
    sizes: BOTH,
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await pick(page, [FILES.docx]);
      await h.waitText("can’t be attached");
      await park(page);
      await h.idle();
      await h.shot("docx");
      await pick(page, ELEVEN);
      await h.waitText("up to 10 files");
      const said = await page.evaluate(() => document.querySelector('[role="alert"]')?.textContent ?? "");
      check(/x\d\.txt (wasn’t|weren’t) attached/.test(said), "the limit names the file(s) left out", said);
      await park(page);
      await h.idle();
    },
  },
  {
    name: "audit-chat-drag-over",
    sizes: BOTH,
    mock: { settings: SETTINGS, threads: { school: CONVERSATION } },
    async run(page, h) {
      await h.idle();
      await dragFileOver(page);
      await page.waitForFunction(() => document.body.innerText.includes("Drop files to attach them"), { timeout: 5000 });
      await park(page);
      await h.idle();
    },
  },

  // ---- Copy feedback ----
  {
    name: "audit-chat-copy",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: { school: CONVERSATION } },
    async run(page, h) {
      await h.waitText("Here is a plan");
      // The latest reply's Copy (always shown); older replies' only appear on hover.
      const COPY = '[data-role="assistant"]:last-child [data-copy-reply]';
      await page.waitForSelector(COPY, { timeout: 5000 });
      const name = () => page.evaluate((sel) => document.querySelector(sel).textContent, COPY);
      const status = () => page.evaluate(() => document.querySelector('[data-testid="reply-status"]').textContent);
      check((await name()) === "Copy reply" && !(await page.$eval(COPY, (b) => b.hasAttribute("aria-label"))), "the Copy button's name is its visible label plus context");
      await h.hover(COPY);
      await h.idle();
      await h.shot("reply-hover");
      await page.click(COPY);
      await page.waitForFunction(() => document.querySelector('[data-testid="reply-status"]').textContent === "Reply copied.", { timeout: 3000 });
      check((await name()) === "Copied reply", "after copying, the name still starts with the visible Copied", await name());
      check((await status()) === "Reply copied.", "Reply copied. is announced once, politely");
      await h.shot("reply-copied");
      const codeCopy = await page.evaluateHandle(() => [...document.querySelectorAll(".aui-md button")].find((b) => b.textContent.includes("Copy")));
      await codeCopy.hover();
      await h.idle();
      await h.shot("code-hover");
      await codeCopy.click();
      await page.waitForFunction(() => document.querySelector('[data-testid="reply-status"]').textContent === "Code copied.", { timeout: 3000 });
      check(true, "Code copied. is announced");
      await park(page);
    },
  },

  // ---- Markdown ----
  {
    name: "audit-chat-markdown",
    sizes: [[1100, 720], [760, 560], [640, 480]],
    mock: { settings: SETTINGS, threads: { school: [{ role: "user", text: "Show me everything you can format.", attachments: [] }, { role: "assistant", text: MARKDOWN_STRESS, attachments: [] }] } },
    async run(page, h) {
      await h.waitText("Last line after a rule");
      await page.evaluate((sel) => (document.querySelector(sel).scrollTop = 0), LOG);
      await park(page);
      await h.idle();
      await h.shot("top");
      await page.evaluate(() => document.querySelector('[role="group"][aria-label="Table"]')?.scrollIntoView({ block: "start" }));
      await h.idle();
      await h.shot("table");
      const wide = await page.evaluate(() => {
        const log = document.querySelector('[role="log"]');
        return log.scrollWidth > log.clientWidth;
      });
      console.log(`     conversation scrolls sideways: ${wide}`);
      await page.evaluate(() => document.querySelector(".aui-md pre")?.scrollIntoView({ block: "center" }));
      await h.idle();
    },
  },
  {
    name: "audit-chat-reloaded",
    sizes: WIDE,
    mock: {
      settings: SETTINGS,
      threads: {
        school: [
          {
            role: "user",
            text: "Can you turn these into a study plan?",
            attachments: [
              { name: "whiteboard.png", path: "attachments/2026-10-09/whiteboard.png", mediaType: "image/png" },
              { name: "syllabus-c241-fall-2026.pdf", path: "attachments/2026-10-09/syllabus-c241-fall-2026.pdf", mediaType: "application/pdf" },
              { name: "week6-notes.md", path: "attachments/2026-10-09/week6-notes.md", mediaType: "text/plain" },
              { name: "an-extremely-long-file-name-for-the-final-project-report-draft.md", path: "attachments/x.md", mediaType: "text/plain" },
            ],
          },
          { role: "assistant", text: "Start with recursion on Monday.", attachments: [] },
        ],
      },
    },
    async run(page, h) {
      await h.waitText("Start with recursion");
      await park(page);
      await h.idle();
    },
  },
  {
    name: "audit-chat-work-empty-hue",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: { work: WORK_THREAD } },
    async run(page, h) {
      await h.click("#spaces-sidebar li:nth-child(2) button");
      await h.idle();
      await page.focus(COMPOSER);
      await page.keyboard.press("Shift");
      await park(page);
      await h.idle();
    },
  },
];
