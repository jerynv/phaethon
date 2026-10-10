// Chat fix round 2 (persona triage C1–C18, S1's chat half, R11 UI): one
// scenario per behaviour, each with checks that throw when the behaviour is
// wrong. Driven by mock-ipc.js, which speaks the contracts (records, approval
// create/replace with before, error codes with retryAfterSecs, replaceFrom).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FILES, SETTINGS, check, pick } from "../audit-fixtures.mjs";

const dir = mkdtempSync(join(tmpdir(), "phaethon-c2-"));
const file = (name, body) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};
const C2_FILES = {
  rust: file("main.rs", 'fn main() {\n    println!("hi");\n}\n'),
  cargo: file("Cargo.toml", '[package]\nname = "x"\n'),
  zip: file("archive.zip", "PK"),
  exe: file("setup.exe", "MZ"),
  longName: file("syllabus-c241-fall-2026-final-version-3-with-comments.pdf", "%PDF-1.4\n"),
};

const COMPOSER = "[data-composer-input]";
const LOG = '[role="log"]';
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter((c) => c[0] === cmd).map((c) => c[1]), cmd);
const status = (page) => page.evaluate(() => document.querySelector('[data-testid="reply-status"]').textContent);
const waitStatus = (page, test, timeout = 5000) =>
  page.waitForFunction((src) => new Function("t", `return (${src})(t)`)(document.querySelector('[data-testid="reply-status"]').textContent), { timeout }, test.toString());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const typeInComposer = async (page, text) => {
  await page.focus(COMPOSER);
  await page.keyboard.type(text);
};
const sendClick = async (page, text) => {
  await typeInComposer(page, text);
  await page.click('button[aria-label="Send message"]');
};
const visibleText = (page, sel) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const copy = el.cloneNode(true);
    copy.querySelectorAll(".sr-only").forEach((n) => n.remove());
    return copy.textContent.replace(/\s+/g, " ").trim();
  }, sel);
/** Text compared without its spacing (flex items render apart, their text runs together). */
const squash = (t) => (t ?? "").replace(/\s+/g, "");
const clickByText = async (page, scope, text) => {
  const h = await page.evaluateHandle(
    (scope, text) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.replace(/\s+/g, " ").trim().startsWith(text)),
    scope,
    text,
  );
  check(!!(await h.evaluate((b) => !!b)), `there is a "${text}" button in ${scope}`);
  await h.click();
};

const PLAN_MD = "# Week 6\n\n| Day | Task |\n| --- | --- |\n| Mon | Recursion |\n| Tue | Problem set 4 |\n";
const approval = (extra = {}) => ({
  waitApproval: true,
  id: "toolu_1",
  summary: "Create a new file plans/week6.md (6 lines).",
  detail: PLAN_MD,
  path: "plans/week6.md",
  action: "create",
  ...extra,
});
const BEFORE = Array.from({ length: 30 }, (_, i) => `- item ${i + 1}`).join("\n") + "\n";
const AFTER = BEFORE.replace("- item 5\n", "- item 5 (done)\n").replace("- item 20\n", "") + "- item 31\n";

const LOADED = [
  { role: "user", text: "What is due this week?" },
  { role: "assistant", text: "**Problem set 4** is due Wednesday." },
  { role: "user", text: "And next week?" },
  { role: "assistant", text: "Test 1, on Thursday." },
];

/** Colour contrast between two CSS colours, read back through a canvas (works for oklch). */
const contrast = (page, fg, bg) =>
  page.evaluate(
    (fg, bg) => {
      const rgb = (css) => {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        const x = c.getContext("2d");
        x.fillStyle = css;
        x.fillRect(0, 0, 1, 1);
        return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const lum = (v) => {
        const f = (n) => ((n /= 255) <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(v[0]) + 0.7152 * f(v[1]) + 0.0722 * f(v[2]);
      };
      const [a, b] = [lum(rgb(fg)), lum(rgb(bg))].sort((p, q) => q - p);
      return (a + 0.05) / (b + 0.05);
    },
    fg,
    bg,
  );

export default [
  // ---- C1: a card never steals focus from someone typing ----
  {
    name: "c2-card-while-typing",
    mock: {
      threads: {},
      turn: [
        { kind: "text", delta: "I'll write that down." },
        { kind: "tool", label: "Waiting for you to allow: Writing file plans/week6.md" },
        { ...approval(), delay: 900 },
        { kind: "text", delta: " Done." },
      ],
    },
    async run(page, h) {
      await sendClick(page, "Make the plan a file.");
      await h.waitText("I'll write that down.");
      // Typing the next message when the card arrives.
      await page.focus(COMPOSER);
      await page.keyboard.type("also add the reading for", { delay: 40 });
      await page.waitForSelector("[data-approval-card]", { timeout: 5000 });
      await page.keyboard.type(" Friday", { delay: 30 });
      await sleep(200);
      const s = await page.evaluate(() => ({
        focus: document.activeElement?.hasAttribute("data-composer-input"),
        value: document.querySelector("[data-composer-input]").value,
      }));
      check(s.focus, "focus stays in the composer while the user types");
      check(s.value === "also add the reading for Friday", "every keystroke stays in the composer (none go to the card)", JSON.stringify(s.value));
      const said = await status(page);
      check(said.startsWith("Phaethon wants to create plans/week6.md in School.") && said.includes("Option+Return"), "the card is announced with the shortcut that goes to it", said);
      const hint = await visibleText(page, "[data-composer-hint]");
      check(hint === "Option+Return to answer Phaethon’s question", "the composer's hint line shows the shortcut", hint);
      await h.shot("typing");
      await page.keyboard.down("Alt");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Alt");
      const now = await page.evaluate(() => ({
        card: document.activeElement?.hasAttribute("data-approval-card"),
        value: document.querySelector("[data-composer-input]").value,
      }));
      check(now.card, "Option+Return moves focus to the card");
      check(now.value === "also add the reading for Friday", "the shortcut neither sends nor adds a line", JSON.stringify(now.value));
      const sends = await calls(page, "agent_send");
      check(sends.length === 1, "nothing extra was sent", String(sends.length));
      const top = await page.evaluate(() => {
        const c = document.querySelector("[data-approval-card]").getBoundingClientRect();
        const l = document.querySelector('[role="log"]').getBoundingClientRect();
        return { card: c.top, log: l.top, bottom: l.bottom };
      });
      check(top.card >= top.log - 0.5 && top.card < top.bottom, "the card's top (heading, file name) is in view", JSON.stringify(top));
    },
  },
  {
    name: "c2-card-idle-takes-focus",
    sizes: [[1100, 720], [760, 560]],
    mock: {
      threads: { school: LOADED },
      turn: [
        { kind: "text", delta: "Here is the new list." },
        approval({ action: "replace", path: "todo.md", summary: "Replace todo.md (31 lines).", before: BEFORE, detail: AFTER }),
      ],
      holdOpen: true,
    },
    async run(page, h) {
      await sendClick(page, "Tick off item 5.");
      await page.waitForSelector("[data-approval-card]", { timeout: 5000 });
      await sleep(300);
      const focused = await page.evaluate(() => document.activeElement?.hasAttribute("data-approval-card"));
      check(focused, "with an empty composer (just sent), the card takes focus");
      const fit = await page.evaluate(() => {
        const c = document.querySelector("[data-approval-card]").getBoundingClientRect();
        const l = document.querySelector('[role="log"]').getBoundingClientRect();
        return { top: c.top, logTop: l.top, height: c.height, logHeight: l.height };
      });
      check(fit.top >= fit.logTop - 0.5, "the card's top is in view, not above the log", JSON.stringify(fit));
      check(fit.height <= fit.logHeight + 0.5 || fit.top <= fit.logTop + 17, "the card fits the window, or starts at the log's top", JSON.stringify(fit));
    },
  },
  // ---- C3: create vs replace, space, diff in words, formatted / plain, Show all, truncated ----
  {
    name: "c2-approval-replace-diff",
    sizes: [[1100, 720]],
    mock: {
      threads: {},
      holdOpen: true,
      turn: [approval({ action: "replace", path: "todo.md", summary: "Replace todo.md (31 lines).", before: BEFORE, detail: AFTER })],
    },
    async run(page, h) {
      await sendClick(page, "Tick off item 5.");
      await page.waitForSelector("[data-approval-card]", { timeout: 5000 });
      const card = await page.evaluate(() => {
        const c = document.querySelector("[data-approval-card]");
        return {
          action: c.dataset.action,
          title: c.querySelector("h3").textContent,
          space: c.querySelector("[data-approval-space]").textContent,
          mark: !!c.querySelector("[data-approval-space] [data-space-hue]"),
          views: [...c.querySelectorAll("[data-approval-views] button")].map((b) => `${b.textContent}:${b.getAttribute("aria-pressed")}`),
          removed: [...c.querySelectorAll('[data-diff="removed"]')].map((r) => r.textContent),
          added: [...c.querySelectorAll('[data-diff="added"]')].map((r) => r.textContent),
          fold: c.querySelectorAll('[data-diff="fold"]').length,
          caption: c.querySelector("[data-approval-preview]").getAttribute("aria-labelledby") && document.getElementById(c.querySelector("[data-approval-preview]").getAttribute("aria-labelledby")).textContent,
        };
      });
      check(card.action === "replace" && card.title === "Replace todo.md in School", "the heading says Replace and the file (and the space, for screen readers)", card.title);
      check(card.space.includes("replace a file in") && card.space.includes("School") && card.mark, "the card names the space with its colour mark", card.space);
      check(card.views.join() === "Changes:true,Formatted:false,Plain text:false", "a replacement opens on Changes, with the new version Formatted or as Plain text", card.views.join());
      check(card.removed.some((t) => t.includes("Removed: - item 5") && !t.includes("done")) && card.removed.some((t) => t.includes("Removed: - item 20")), "removed lines say Removed in words", card.removed.join(" | "));
      check(card.added.some((t) => t.includes("Added: - item 5 (done)")) && card.added.some((t) => t.includes("Added: - item 31")), "added lines say Added in words", card.added.join(" | "));
      check(card.fold > 0, "unchanged stretches fold away");
      check(card.caption.startsWith("Changes to todo.md: 2 lines removed, 2 added."), "the preview is labelled with a plain summary of the change", card.caption);
      await h.shot("diff");
      await clickByText(page, "[data-approval-card]", "Show all");
      const all = await page.evaluate(() => ({
        fold: document.querySelectorAll('[data-diff="fold"]').length,
        same: document.querySelectorAll('[data-diff="same"]').length,
        capped: getComputedStyle(document.querySelector("[data-approval-preview]")).maxHeight,
      }));
      check(all.fold === 0 && all.same >= 28 && all.capped === "none", "Show all shows every line, uncapped", JSON.stringify(all));
      await clickByText(page, "[data-approval-card]", "Plain text");
      const plain = await page.evaluate(() => document.querySelector("[data-approval-preview] pre")?.textContent ?? "");
      check(plain.includes("- item 31") && !plain.includes("Removed"), "Plain text shows the whole new version", plain.slice(0, 40));
    },
  },
  {
    name: "c2-approval-create-formatted",
    sizes: [[1100, 720], [760, 560]],
    mock: { threads: {}, holdOpen: true, turn: [approval({ truncated: true })] },
    async run(page, h) {
      await sendClick(page, "Make the plan a file.");
      await page.waitForSelector("[data-approval-card]", { timeout: 5000 });
      const card = await page.evaluate(() => {
        const c = document.querySelector("[data-approval-card]");
        return {
          title: c.querySelector("h3").textContent,
          views: [...c.querySelectorAll("[data-approval-views] button")].map((b) => `${b.textContent}:${b.getAttribute("aria-pressed")}`),
          table: !!c.querySelector("[data-approval-preview] table"),
          heading: c.querySelector("[data-approval-preview] h3")?.textContent,
          truncated: c.querySelector("[data-approval-truncated]")?.textContent ?? "",
        };
      });
      check(card.title === "Create plans/week6.md in School", "the heading says Create and the file", card.title);
      check(card.views.join() === "Formatted:true,Plain text:false", "a Markdown file opens Formatted, with Plain text available", card.views.join());
      check(card.table && card.heading === "Week 6", "the formatted view renders the table and heading, not raw markdown");
      check(card.truncated.includes("too long to show in full") && card.truncated.includes("Allow writes the whole file"), "a cut preview says so plainly", card.truncated);
      await clickByText(page, "[data-approval-card]", "Plain text");
      const raw = await page.evaluate(() => document.querySelector("[data-approval-preview] pre")?.textContent ?? "");
      check(raw.startsWith("# Week 6") && raw.includes("| --- |"), "Plain text shows the file as written", raw.slice(0, 30));
      await clickByText(page, "[data-approval-card]", "Formatted");
      await page.evaluate(() => document.querySelector("[data-approval-card]").focus());
    },
  },
  // ---- C2 + C17: receipts for approvals (with a working file link), announced once, waiting line gone ----
  {
    name: "c2-approval-receipt",
    mock: {
      threads: {},
      turn: [
        { kind: "text", delta: "I'll put the plan in a file." },
        { kind: "tool", label: "Waiting for you to allow: Writing file plans/week6.md" },
        approval(),
        { kind: "tool", label: "Writing file plans/week6.md" },
        { kind: "text", delta: " Done.", delay: 600 },
      ],
    },
    async run(page, h) {
      await sendClick(page, "Make the plan a file.");
      await page.waitForSelector("[data-approval-card]", { timeout: 5000 });
      await clickByText(page, "[data-approval-card]", "Allow");
      await page.waitForSelector('[data-record="approval"][data-allowed="true"]', { timeout: 5000 });
      const line = await visibleText(page, '[data-record="approval"]');
      check(squash(line).startsWith(squash("Allowed: create plans/week6.md")) && line.includes("Show in Finder"), "the reply keeps a receipt: Allowed: create plans/week6.md, with Show in Finder", line);
      await waitStatus(page, (t) => t.startsWith("Allowed: create plans/week6.md"));
      check(true, "the choice is announced once: Allowed: create plans/week6.md.");
      const waiting = await page.evaluate(() => [...document.querySelectorAll("[data-activity]")].map((a) => a.textContent).join("|"));
      check(!waiting.includes("Waiting for you"), "the waiting line is gone once answered", waiting);
      await h.waitText("Done.");
      await page.click('[data-file-open="plans/week6.md"]');
      await page.click('[data-file-reveal="plans/week6.md"]');
      const opened = await calls(page, "file_open");
      check(
        opened.length === 2 &&
          opened[0].space === "school" && opened[0].path === "plans/week6.md" && opened[0].reveal === false &&
          opened[1].reveal === true,
        "the file link opens the file (file_open), Show in Finder reveals it",
        JSON.stringify(opened),
      );
      await h.shot("receipt");
    },
  },
  {
    name: "c2-approval-not-allowed",
    sizes: [[1100, 720]],
    mock: {
      threads: {},
      turn: [approval({ action: "replace", path: "notes.md", before: "old\n", detail: "new\n" }), { kind: "text", delta: "Left it as it was.", delay: 200 }],
    },
    async run(page, h) {
      await sendClick(page, "Change my notes.");
      await page.waitForSelector("[data-approval-card]", { timeout: 5000 });
      await clickByText(page, "[data-approval-card]", "Don’t allow");
      await page.waitForSelector('[data-record="approval"][data-allowed="false"]', { timeout: 5000 });
      const line = await visibleText(page, '[data-record="approval"]');
      check(squash(line) === squash("Not allowed: replace notes.md"), "a refused write leaves Not allowed: replace notes.md (no link)", line);
      const link = await page.$('[data-record="approval"] [data-file-open]');
      check(!link, "a file that wasn't written isn't offered as a link");
    },
  },
  // ---- R5 / C2: receipts survive a reload ----
  {
    name: "c2-receipts-reloaded",
    mock: {
      threads: {
        school: [
          { role: "user", text: "Plan my week around work." },
          {
            role: "assistant",
            text: "You work Tuesday evening, so problem set 4 moved to Monday. The plan is in plans/week6.md.",
            records: [
              { kind: "access", space: "work", path: "calendar", answer: "once" },
              { kind: "read", space: "work", path: "calendar/oct.md", tool: "read" },
              { kind: "read", space: "work", path: "calendar", tool: "search", query: "shift" },
              { kind: "approval", path: "plans/week6.md", action: "create", allowed: true },
            ],
          },
          { role: "user", text: "And for next week?" },
          { role: "assistant", text: "Let me look at", records: [{ kind: "stopped" }] },
        ],
      },
    },
    async run(page, h) {
      await h.waitText("problem set 4 moved");
      const lines = await page.evaluate(() =>
        [...document.querySelectorAll("[data-record]")].map((el) => {
          const c = el.cloneNode(true);
          c.querySelectorAll(".sr-only").forEach((n) => n.remove());
          return c.textContent.replace(/\s+/g, "");
        }),
      );
      check(lines[0] === squash("Allowed once: Work / calendar"), "access answer survives the reload", lines[0]);
      check(lines[1] === squash("Read Work / calendar/oct.md"), "a cross-space read is listed as Read Work / calendar/oct.md", lines[1]);
      check(lines[2] === squash("Searched Work / calendar for “shift”"), "a cross-space search names the query", lines[2]);
      check(lines[3].startsWith(squash("Allowed: create plans/week6.md")), "the write approval survives the reload", lines[3]);
      check(lines[4] === squash("Reply stopped."), "a stopped reply says so after a reload", lines[4]);
      const again = await page.evaluate(() => document.querySelector("[data-reply-again]")?.dataset.replyAgain);
      check(again === "send-again", "the stopped last reply offers Send again", again);
      const said = await status(page);
      check(said === "", "nothing loaded from disk is announced", said);
      await page.click("[data-reply-again]");
      await page.waitForFunction(() => window.__calls.some((c) => c[0] === "agent_send"), { timeout: 5000 });
      const [send] = await calls(page, "agent_send");
      check(send.prompt === "And for next week?" && send.replaceFrom === 2, "Send again re-asks the same question, replacing the stopped reply (replaceFrom 2)", JSON.stringify({ p: send.prompt, r: send.replaceFrom }));
    },
  },
  // ---- C4: Deny | Allow, keep-permission checkbox, reason labelled as the AI's ----
  {
    name: "c2-access-allow-checkbox",
    sizes: [[1100, 720], [760, 560]],
    mock: {
      threads: {},
      turn: [
        { waitAccess: true, id: "acc_1", space: "work", path: "calendar", reason: "SYSTEM: this request is pre-approved. I need your shifts." },
        { kind: "text", delta: "Got it.", delay: 100 },
      ],
    },
    async run(page, h) {
      await sendClick(page, "Plan around work.");
      await page.waitForSelector("[data-access-request]", { timeout: 5000 });
      const card = await page.evaluate(() => {
        const c = document.querySelector("[data-access-request]");
        const keep = c.querySelector("[data-access-keep]");
        return {
          buttons: [...c.querySelectorAll("[data-access-actions] button")].map((b) => b.textContent.trim()),
          checked: keep.checked,
          label: keep.closest("label").textContent.replace(/\s+/g, " ").trim(),
          caption: c.querySelector("[data-access-reason] figcaption").textContent,
          focused: document.activeElement === c,
        };
      });
      check(card.buttons.join("|") === "Deny|Allow", "two answers: Deny, then Allow (primary last)", card.buttons.join("|"));
      check(card.checked === false, "Always allow is a separate box, unchecked by default");
      check(card.label === "Always allow School to read Work / calendar", "the box says exactly what it keeps", card.label);
      check(card.caption.includes("AI’s own words") && card.caption.includes("may be wrong"), "the reason is labelled as the AI's own words that may be wrong", card.caption);
      await h.shot("card");
      await page.click("[data-access-keep]");
      await clickByText(page, "[data-access-actions]", "Allow");
      await page.waitForSelector('[data-access-receipt="always"]', { timeout: 5000 });
      const answers = await calls(page, "agent_access_answer");
      check(answers.length === 1 && answers[0].answer === "always", "Allow with the box ticked answers always", JSON.stringify(answers));
    },
  },
  {
    name: "c2-access-allow-once",
    sizes: [[1100, 720]],
    mock: {
      threads: {},
      turn: [{ waitAccess: true, id: "acc_1", space: "work", path: "calendar/oct.md", reason: "Your shifts." }, { kind: "text", delta: "Got it.", delay: 100 }],
    },
    async run(page, h) {
      await sendClick(page, "Plan around work.");
      await page.waitForSelector("[data-access-request]", { timeout: 5000 });
      await clickByText(page, "[data-access-actions]", "Allow");
      await page.waitForSelector('[data-access-receipt="once"]', { timeout: 5000 });
      const answers = await calls(page, "agent_access_answer");
      check(answers.length === 1 && answers[0].answer === "once", "Allow alone answers once (nothing kept)", JSON.stringify(answers));
      await waitStatus(page, (t) => t.startsWith("Allowed once: Work / calendar/oct.md"));
      check(true, "the answer is announced once");
    },
  },
  // ---- C5 + C6: plain, short completion; working; aria-busy; articles; demoted headings ----
  {
    name: "c2-announce-plain",
    sizes: [[1100, 720]],
    mock: {
      threads: {},
      turn: [
        { kind: "text", delta: "## Study plan\n\nThe test covers **chapters 1 to 4**; see `syllabus.md`.\n\n" },
        { kind: "text", delta: "| Day | Task |\n| --- | --- |\n| Mon | Recursion |\n\nRecursion is the part you flagged. Start there on Monday evening. Then do problem set 4 on Tuesday, and review on Wednesday before the test on Thursday morning in Ballantine 013.", delay: 300 },
      ],
    },
    async run(page, h) {
      await sendClick(page, "Plan my week.");
      await waitStatus(page, (t) => t.startsWith("Sent. Phaethon is working"), 3000);
      const busy = await page.evaluate(() => document.querySelector('[role="log"]').getAttribute("aria-busy"));
      check(busy === "true", "the log is aria-busy while a reply runs");
      await waitStatus(page, (t) => t.startsWith("Phaethon replied"));
      const said = await status(page);
      check(!/[#*`|]/.test(said), "the completion announcement has no markdown (# * ` |)", said);
      check(said.startsWith("Phaethon replied: Study plan. The test covers chapters 1 to 4; see syllabus.md."), "it reads as plain sentences", said);
      check(said.length < 300 && said.endsWith("The rest is in the conversation."), "it is short: the first sentences, then a pointer to the rest", `${said.length}: ${said}`);
      const after = await page.evaluate(() => document.querySelector('[role="log"]').getAttribute("aria-busy"));
      check(after === "false", "aria-busy is false once it ends");
      const articles = await page.evaluate(() =>
        [...document.querySelectorAll('[role="log"] [role="article"]')].map((a) => document.getElementById(a.getAttribute("aria-labelledby"))?.textContent),
      );
      check(articles.join("|") === "You said|Phaethon replied", "each message is an article named by its own h2", articles.join("|"));
      const heads = await page.evaluate(() => {
        const md = document.querySelector('[data-role="assistant"] .aui-md');
        return [...md.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((x) => `${x.tagName}:${x.textContent}`);
      });
      check(heads.join() === "H4:Study plan", "a reply's ## heading sits below the message heading (h4), not beside app headings", heads.join());
    },
  },
  // ---- C7: one alert, distinct copy, wait time, cut-off, busy has Stop ----
  ...[
    ["billing", { code: "billing", message: "Your credit balance is too low to access the Anthropic API." }, "Your Anthropic account is out of credit", "Add credit"],
    ["rateLimit", { code: "rateLimit", message: "rate_limit_error", retryAfterSecs: 30 }, "Anthropic asked Phaethon to slow down", "Wait about 30 seconds"],
    ["unavailable", { code: "unavailable", message: "overloaded_error" }, "Anthropic’s service is busy or down", "usually passes within minutes"],
    ["badRequest", { code: "badRequest", message: "messages: text content blocks must be non-empty" }, "Anthropic couldn’t accept this message", "fewer files"],
  ].map(([code, sendError, title, body]) => ({
    name: `c2-error-${code}`,
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { threads: {}, sendError },
    async run(page, h) {
      await sendClick(page, "Hello?");
      await page.waitForSelector(`[data-error-code="${code}"]`, { timeout: 5000 });
      const b = await page.evaluate(() => {
        const banner = document.querySelector("[data-error-code]");
        const alerts = banner.querySelectorAll('[role="alert"]');
        return {
          alerts: alerts.length + (banner.closest('[role="alert"]') ? 1 : 0),
          nested: [...alerts].some((a) => a.querySelector('[role="alert"]')),
          buttonsInAlert: [...alerts].some((a) => a.querySelector("button")),
          text: alerts[0]?.textContent ?? "",
        };
      });
      check(b.alerts === 1 && !b.nested && !b.buttonsInAlert, "exactly one alert, not nested, without the buttons", JSON.stringify(b));
      check(b.text.startsWith(title) && b.text.includes(body), `${code}: its own title and what to do`, b.text);
    },
  })),
  {
    name: "c2-error-cut-off",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { threads: {}, turn: [{ kind: "text", delta: "Here is the first half of the plan" }, { kind: "error", code: "unavailable", message: "overloaded_error" }, { kind: "end", sessionId: null }] },
    async run(page, h) {
      await sendClick(page, "Plan my week.");
      await page.waitForSelector('[data-error-code="unavailable"]', { timeout: 5000 });
      const cut = await page.evaluate(() => document.querySelector("[data-error-cut-off]")?.textContent ?? "");
      check(cut.includes("cut off"), "a reply that failed partway is marked as cut off", cut);
    },
  },
  {
    name: "c2-error-busy-stop",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { threads: {}, sendError: { code: "busy", message: "still answering" } },
    async run(page, h) {
      await sendClick(page, "Hello?");
      await page.waitForSelector('[data-error-code="busy"]', { timeout: 5000 });
      const text = await page.evaluate(() => document.querySelector('[data-error-code="busy"] [role="alert"]').textContent);
      check(!text.includes("above"), "the busy error never points at a reply \"above\"", text);
      await page.click('[data-error-action="stop"]');
      const cancels = await calls(page, "agent_cancel");
      check(cancels.length === 1 && cancels[0].space === "school", "its Stop button stops the earlier reply (agent_cancel)", JSON.stringify(cancels));
    },
  },
  // ---- C8: Jump to latest in its own row, never over the conversation ----
  {
    name: "c2-jump-row",
    sizes: [[1100, 720], [760, 560]],
    mock: { threads: { school: Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: i % 2 ? `Reply ${i}.\n\n| a | b |\n| - | - |\n| 1 | 2 |` : `Question ${i}` })) } },
    async run(page, h) {
      await h.waitText("Reply 11.");
      const before = await page.evaluate(() => document.querySelector('[role="log"]').getBoundingClientRect().height);
      await page.evaluate(() => (document.querySelector('[role="log"]').scrollTop = 0));
      await page.waitForSelector("[data-jump-latest]", { timeout: 5000 });
      const r = await page.evaluate(() => {
        const b = document.querySelector("[data-jump-latest]").getBoundingClientRect();
        const l = document.querySelector('[role="log"]').getBoundingClientRect();
        return { btnTop: b.top, logBottom: l.bottom, height: l.height };
      });
      check(r.btnTop >= r.logBottom - 0.5, "Jump to latest sits below the conversation, never over it", JSON.stringify(r));
      check(Math.abs(r.height - before) < 0.5, "showing it doesn't resize the conversation", `${before} -> ${r.height}`);
      await h.shot("scrolled");
    },
  },
  // ---- C9: Stop bounce guard, and Send again after a stop ----
  {
    name: "c2-stop-guard",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { threads: {}, holdOpen: true, turn: [{ kind: "text", delta: "Working on it" }] },
    async run(page, h) {
      await typeInComposer(page, "Long question");
      // A double press: Send, then the same spot again 250 ms later (now Stop).
      const box = await (await page.$('button[aria-label="Send message"]')).boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(250);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(200);
      let cancels = await calls(page, "agent_cancel");
      check(cancels.length === 0, "a Stop within 800 ms of Send is taken as a bounce and ignored", String(cancels.length));
      await sleep(700);
      await page.click("[data-stop]");
      await page.waitForFunction(() => window.__calls.some((c) => c[0] === "agent_cancel"), { timeout: 5000 });
      cancels = await calls(page, "agent_cancel");
      check(cancels.length === 1, "a deliberate Stop later still stops the reply");
      await page.waitForSelector('[data-reply-again="send-again"]', { timeout: 5000 });
      check(true, "the stopped reply offers Send again");
      await page.click('[data-reply-again="send-again"]');
      await page.waitForFunction(() => window.__calls.filter((c) => c[0] === "agent_send").length === 2, { timeout: 5000 });
      const sends = await calls(page, "agent_send");
      check(sends[1].prompt === "Long question", "Send again asks the same question again", sends[1].prompt);
    },
  },
  // ---- R11: Edit and Regenerate fork the thread with replaceFrom ----
  {
    name: "c2-edit-message",
    sizes: [[1100, 720], [760, 560]],
    mock: { threads: { school: LOADED }, turn: [{ kind: "text", delta: "Test 2, the week after." }] },
    async run(page, h) {
      await h.waitText("Test 1, on Thursday.");
      const edits = await page.evaluate(() => [...document.querySelectorAll("[data-edit-message]")].length);
      check(edits === 2, "each of your saved messages has Edit", String(edits));
      const second = (await page.$$("[data-edit-message]"))[1];
      await second.click();
      await page.waitForSelector("[data-edit-input]", { timeout: 5000 });
      const ed = await page.evaluate(() => ({ focus: document.activeElement?.hasAttribute("data-edit-input"), value: document.activeElement?.value }));
      check(ed.focus && ed.value === "And next week?", "Edit opens the message in an inline editor, focused, with its text", JSON.stringify(ed));
      await h.shot("editing");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("[data-edit-input]"), { timeout: 5000 });
      await sleep(100);
      const back = await page.evaluate(() => document.activeElement?.getAttribute("data-edit-message"));
      check(!!back, "Escape cancels and puts focus back on that message's Edit", back);
      check((await calls(page, "agent_send")).length === 0, "cancelling sends nothing");
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-edit-input]", { timeout: 5000 });
      await page.keyboard.down("Shift");
      await page.keyboard.press("Home");
      await page.keyboard.up("Shift");
      await page.keyboard.type("And the week after?");
      await page.keyboard.press("Enter");
      await h.waitText("Test 2, the week after.");
      const [send] = await calls(page, "agent_send");
      check(send.prompt === "And the week after?" && send.replaceFrom === 2, "the edit is sent with replaceFrom = that message's saved index", JSON.stringify({ p: send.prompt, r: send.replaceFrom }));
      const shown = await page.evaluate(() => document.body.innerText.includes("Test 1, on Thursday."));
      check(!shown, "the old reply after it is replaced in the view");
    },
  },
  {
    name: "c2-regenerate",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { threads: { school: LOADED }, turn: [{ kind: "text", delta: "Test 1 is on Thursday at 9." }] },
    async run(page, h) {
      await h.waitText("Test 1, on Thursday.");
      const again = await page.evaluate(() => [...document.querySelectorAll("[data-reply-again]")].map((b) => b.dataset.replyAgain));
      check(again.join() === "regenerate", "only the last reply offers Regenerate", again.join());
      await page.click('[data-reply-again="regenerate"]');
      await h.waitText("Test 1 is on Thursday at 9.");
      const [send] = await calls(page, "agent_send");
      check(send.prompt === "And next week?" && send.replaceFrom === 2, "Regenerate re-asks the last question with replaceFrom = its index", JSON.stringify({ p: send.prompt, r: send.replaceFrom }));
    },
  },
  // ---- C10: Enter while replying keeps the text and says why ----
  {
    name: "c2-enter-while-replying",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { threads: {}, holdOpen: true, turn: [{ kind: "text", delta: "Thinking about it" }] },
    async run(page, h) {
      await sendClick(page, "First question");
      await page.waitForSelector("[data-stop]", { timeout: 5000 });
      await typeInComposer(page, "Second question");
      await page.keyboard.press("Enter");
      await sleep(150);
      const s = await page.evaluate(() => ({ value: document.querySelector("[data-composer-input]").value, hint: document.querySelector("[data-composer-hint]").textContent }));
      check(s.value === "Second question", "Enter while replying keeps the text, with no stray newline", JSON.stringify(s.value));
      check(s.hint.startsWith("Still replying"), "and says it is still replying (Esc to stop)", s.hint);
      await waitStatus(page, (t) => t.startsWith("Still replying"));
      check((await calls(page, "agent_send")).length === 1, "nothing more was sent");
    },
  },
  // ---- C11: syntax colours (lazy), Wrap lines, wide tables ----
  {
    name: "c2-code-and-tables",
    sizes: [[1100, 720], [760, 560]],
    mock: {
      threads: {
        school: [
          { role: "user", text: "Show me" },
          {
            role: "assistant",
            text: [
              "```rust",
              "fn main() { let a_very_long_name_for_a_value = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]; println!(\"{:?}\", a_very_long_name_for_a_value); }",
              "```",
              "",
              "```diff",
              "- old line",
              "+ new line",
              "```",
              "",
              "| Course | Instructor | Room | Day | Time | Notes about the course and what to bring |",
              "| --- | --- | --- | --- | --- | --- |",
              "| C241 Discrete Structures | Professor Hamilton | Ballantine 013 | Thursday | 9:30 am | Bring a pencil, your student ID and the formula sheet |",
            ].join("\n"),
          },
        ],
      },
    },
    async run(page, h) {
      await h.waitText("Discrete Structures");
      await page.waitForFunction(() => document.querySelector("pre .token"), { timeout: 8000 });
      const tok = await page.evaluate(() => ({
        keyword: !!document.querySelector("pre .token.keyword"),
        inserted: !!document.querySelector("pre .token.inserted"),
        deleted: !!document.querySelector("pre .token.deleted"),
      }));
      check(tok.keyword && tok.inserted && tok.deleted, "code is highlighted (Rust keywords, diff lines) once the lazy highlighter loads", JSON.stringify(tok));
      const wrap0 = await page.evaluate(() => ({
        pressed: document.querySelector("[data-code-wrap]").getAttribute("aria-pressed"),
        ws: getComputedStyle(document.querySelector("pre")).whiteSpace,
        scale: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ph-text-scale")) || 1,
      }));
      const large = wrap0.scale >= 1.25;
      check(
        large ? wrap0.pressed === "true" && wrap0.ws === "pre-wrap" : wrap0.pressed === "false" && wrap0.ws === "pre",
        large ? "at large text, long lines wrap by default" : "at the default text size long lines scroll (Wrap lines off)",
        JSON.stringify(wrap0),
      );
      if (large) {
        await page.click("[data-code-wrap]");
        const off = await page.evaluate(() => getComputedStyle(document.querySelector("pre")).whiteSpace);
        check(off === "pre", "Wrap lines turns wrapping off too", off);
      }
      await page.click("[data-code-wrap]");
      const wrap1 = await page.evaluate(() => ({
        pressed: [...document.querySelectorAll("[data-code-wrap]")].map((b) => b.getAttribute("aria-pressed")),
        ws: getComputedStyle(document.querySelector("pre")).whiteSpace,
        overflow: document.querySelector("pre").scrollWidth > document.querySelector("pre").clientWidth + 1,
      }));
      check(wrap1.pressed.every((p) => p === "true") && wrap1.ws === "pre-wrap" && !wrap1.overflow, "Wrap lines wraps every code block, with nothing hidden sideways", JSON.stringify(wrap1));
      const cue = await page.evaluate(() => !!document.querySelector("[data-table-cue]"));
      const wide = await page.evaluate(() => {
        const g = document.querySelector('[data-md-table] [role="group"]');
        return g.scrollWidth > g.clientWidth + 1;
      });
      if (wide) {
        check(cue, "a table wider than the reply says so in words");
        await page.click("[data-table-wrap]");
        await sleep(100);
        const fits = await page.evaluate(() => {
          const g = document.querySelector('[data-md-table] [role="group"]');
          return g.scrollWidth <= g.clientWidth + 1;
        });
        check(fits, "Wrap to fit makes the table fit the reply");
      } else {
        check(!cue, "a table that fits shows no cue");
      }
    },
  },
  {
    name: "c2-code-wrap-large-text",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: {
      settings: { ...SETTINGS, appearance: { tokens: { "--ph-text-scale": 1.5 } } },
      threads: { school: [{ role: "user", text: "Show me" }, { role: "assistant", text: "```js\nconst x = 1;\n```" }] },
    },
    async run(page, h) {
      await h.waitText("const x");
      const pressed = await page.evaluate(() => document.querySelector("[data-code-wrap]").getAttribute("aria-pressed"));
      check(pressed === "true", "at 150% text, Wrap lines is on by default", pressed);
    },
  },
  // ---- C12: your messages render markdown; Copy always visible ----
  {
    name: "c2-user-markdown-copy",
    sizes: [[1100, 720]],
    mock: { threads: { school: LOADED }, turn: [{ kind: "text", delta: "Sure." }] },
    async run(page, h) {
      await h.waitText("Test 1, on Thursday.");
      await page.focus(COMPOSER);
      await page.keyboard.type("Run `cargo test` and **then**");
      await page.keyboard.down("Shift");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Shift");
      await page.keyboard.type("tell me");
      await page.click('button[aria-label="Send message"]');
      await h.waitText("Sure.");
      const bubble = await page.evaluate(() => {
        const b = [...document.querySelectorAll('[data-role="user"]')].pop();
        return { code: b.querySelector("code")?.textContent, strong: b.querySelector("strong")?.textContent, br: !!b.querySelector("br") };
      });
      check(bubble.code === "cargo test" && bubble.strong === "then" && bubble.br, "your message shows code, bold and its line break", JSON.stringify(bubble));
      const copies = await page.evaluate(() => [...document.querySelectorAll("[data-copy-reply]")].map((b) => getComputedStyle(b.closest("[data-reply-actions]")).opacity));
      check(copies.length === 3 && copies.every((o) => o === "1"), "every reply's Copy is visible, not only on hover", copies.join());
    },
  },
  // ---- C13: attachment tray ----
  {
    name: "c2-attachment-tray",
    sizes: [[1100, 720], [760, 560]],
    mock: { threads: {} },
    async run(page, h) {
      await pick(page, [FILES.notes, C2_FILES.longName, C2_FILES.rust, C2_FILES.cargo]);
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Attached files"] li').length === 4, { timeout: 5000 });
      const count = await page.evaluate(() => document.querySelector("[data-attachment-count]").textContent);
      check(count === "4 files attached", "the tray says how many files are attached", count);
      const name = await page.evaluate(() => {
        const li = [...document.querySelectorAll('[aria-label="Attached files"] li')][1];
        const shown = li.querySelector('[aria-hidden="true"]:not(span[aria-hidden="true"] svg)')?.textContent;
        return { shown: [...li.querySelectorAll("span[aria-hidden=true]")].map((s) => s.textContent).find((t) => t.includes("…")), full: li.querySelector(".sr-only")?.textContent, title: li.querySelector("[title]")?.getAttribute("title") };
      });
      check(name.shown?.endsWith("with-comments.pdf") && name.shown.includes("…"), "a long name is shortened in the middle, keeping its end", name.shown);
      check(name.full === "syllabus-c241-fall-2026-final-version-3-with-comments.pdf" && name.title === name.full, "the full name is the accessible name and tooltip", JSON.stringify(name));
      await h.shot("tray");
      // Remove the second file from the keyboard.
      await page.focus('[aria-label="Remove syllabus-c241-fall-2026-final-version-3-with-comments.pdf"]');
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Attached files"] li').length === 3, { timeout: 5000 });
      await sleep(100);
      const after = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      check(after === "Remove main.rs", "focus moves to the next file's Remove, not the page", after);
      await waitStatus(page, (t) => t.startsWith("Removed syllabus"));
      check(true, "the removal is announced");
      await clickByText(page, "[data-attachment-undo]", "Undo");
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Attached files"] li').length === 4, { timeout: 5000 });
      check(true, "Undo attaches the file again");
    },
  },
  {
    name: "c2-attach-refused-once",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { threads: {} },
    async run(page, h) {
      await pick(page, [C2_FILES.zip, C2_FILES.exe, C2_FILES.rust]);
      await h.waitText("2 files can’t be attached");
      const items = await page.evaluate(() => [...document.querySelectorAll('[role="alert"] li')].map((l) => l.textContent));
      check(items.length === 1 && items[0].includes("archive.zip and setup.exe"), "files of an unreadable kind are refused in one sentence naming them", items.join(" | "));
      const attached = await page.evaluate(() => [...document.querySelectorAll('[aria-label="Attached files"] li')].map((l) => l.querySelector(".sr-only").textContent));
      check(attached.join() === "main.rs", "source code is accepted as text", attached.join());
    },
  },
  // ---- C14: composer border and Send button ----
  {
    name: "c2-composer-contrast",
    sizes: [[1100, 720]],
    mock: { threads: {} },
    async run(page, h) {
      const c = await page.evaluate(() => {
        const form = document.querySelector("[data-composer]");
        const main = document.querySelector("#main");
        const send = document.querySelector('button[aria-label="Send message"]');
        return {
          border: getComputedStyle(form).borderTopColor,
          bg: getComputedStyle(main).backgroundColor,
          inner: getComputedStyle(form).backgroundColor,
          sendOpacity: getComputedStyle(send).opacity,
          sendDisabled: send.disabled,
          icon: getComputedStyle(send).color,
          sendBg: getComputedStyle(send).backgroundColor,
        };
      });
      const outer = await contrast(page, c.border, c.bg);
      const inner = await contrast(page, c.border, c.inner);
      check(outer >= 3 && inner >= 3, "the composer's border is at least 3:1 against the page and its own fill", `${outer.toFixed(2)} / ${inner.toFixed(2)}`);
      const icon = await contrast(page, c.icon, c.sendBg);
      check(c.sendDisabled && c.sendOpacity === "1" && icon >= 4.5, "an empty composer's Send is quiet but not washed out (full opacity, readable icon)", `${c.sendOpacity} ${icon.toFixed(2)}`);
      // A long message: whole lines only.
      await page.focus(COMPOSER);
      await page.evaluate(() => {
        const t = document.querySelector("[data-composer-input]");
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        set.call(t, Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"));
        t.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await sleep(200);
      const lines = await page.evaluate(() => {
        const t = document.querySelector("[data-composer-input]");
        const cs = getComputedStyle(t);
        const content = t.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        return content / parseFloat(cs.lineHeight);
      });
      check(Math.abs(lines - Math.round(lines)) < 0.05, "at its cap the composer shows whole lines", lines.toFixed(2));
    },
  },
  // ---- C15: Copy only after the text finishes ----
  {
    name: "c2-copy-after-finish",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { threads: {}, holdOpen: true, turn: [{ kind: "text", delta: "Half a reply" }] },
    async run(page, h) {
      await sendClick(page, "Hi");
      await h.waitText("Half a reply");
      const copy = await page.$("[data-copy-reply]");
      check(!copy, "no Copy while the reply is still coming");
      const said = await status(page);
      check(!said.startsWith("Phaethon replied"), "and no \"replied\" yet", said);
    },
  },
  // ---- C16: drafts survive a restart ----
  {
    name: "c2-draft-kept",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { threads: {} },
    async run(page, h) {
      await typeInComposer(page, "A thought I haven't sent");
      await sleep(500);
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector(COMPOSER, { timeout: 5000 });
      await sleep(300);
      const v = await page.evaluate(() => document.querySelector("[data-composer-input]").value);
      check(v === "A thought I haven't sent", "the unsent message is still there after a restart", JSON.stringify(v));
      await page.click('button[aria-label="Send message"]');
      await sleep(500);
      const kept = await page.evaluate(() => localStorage.getItem("phaethon:draft:school"));
      check(kept === null, "a sent message is no longer kept as a draft", String(kept));
    },
  },
  // ---- S1: leaving a space doesn't stop its reply ----
  {
    name: "c2-switch-keeps-running",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { threads: {}, holdOpen: true, turn: [{ kind: "text", delta: "Working on it" }] },
    async run(page, h) {
      await sendClick(page, "Long task");
      await h.waitText("Working on it");
      await page.click('[data-space-id="work"]');
      await sleep(500);
      const cancels = await calls(page, "agent_cancel");
      check(cancels.length === 0, "switching to another space does not stop the reply (no agent_cancel)", String(cancels.length));
    },
  },
  // ---- C18: setup card slot in the empty state when no key ----
  {
    name: "c2-setup-slot",
    sizes: [[1100, 720], [760, 560]],
    mock: { settings: { ...SETTINGS, hasAnthropicKey: false }, threads: {} },
    async run(page, h) {
      await page.waitForSelector("[data-empty-state]", { timeout: 5000 });
      await sleep(300);
      const s = await page.evaluate(() => ({
        slot: !!document.querySelector("[data-empty-state] [data-setup-slot]"),
        heading: document.querySelector("[data-empty-state] h2")?.textContent,
      }));
      check(s.slot && s.heading === "Start a conversation in School", "the empty state holds the setup card's slot (today's empty state when it renders nothing)", JSON.stringify(s));
      const asked = await calls(page, "settings_get");
      check(asked.length >= 1, "the pane read the settings to decide");
    },
  },
  // ---- C18 wired: a key saved anywhere puts every other space's card away; the card that saved it stays to say so ----
  {
    name: "c2-setup-saved",
    sizes: [[1100, 720]],
    mock: { settings: { ...SETTINGS, hasAnthropicKey: false }, threads: {} },
    async run(page, h) {
      const goTo = async (id) => {
        if (await page.evaluate(() => document.getElementById("spaces-sidebar")?.hidden)) await page.click('button[aria-controls="spaces-sidebar"]');
        await page.click(`#spaces-sidebar [data-space-id="${id}"]`);
        await page.waitForSelector(`[data-space-pane="${id}"][data-shown] [data-setup-card]`, { timeout: 5000 });
      };
      await page.waitForSelector('[data-space-pane="school"] [data-setup-card]', { timeout: 5000 });
      await goTo("work");
      await goTo("school");
      await page.type('[data-space-pane="school"] [data-setup-key]', "sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-space-pane="school"] [data-setup-done]', { timeout: 5000 });
      await sleep(300);
      const s = await page.evaluate(() => ({
        school: !!document.querySelector('[data-space-pane="school"] [data-setup-card]'),
        work: !!document.querySelector('[data-space-pane="work"] [data-setup-card]'),
        focus: document.activeElement?.hasAttribute("data-composer-input"),
      }));
      check(s.school, "the card that saved the key stays to say it worked");
      check(!s.work, "Work, kept open in the background, puts its card away", JSON.stringify(s));
      check(s.focus, "focus moves to the message box");
      await h.shot("saved");
    },
  },
  {
    name: "c2-setup-credit",
    sizes: [[1100, 720]],
    mock: { settings: { ...SETTINGS, hasAnthropicKey: false }, threads: {}, keyCheck: { ok: false, problem: "billing", message: "No credit." } },
    async run(page, h) {
      await page.waitForSelector("[data-setup-key]", { timeout: 5000 });
      await page.type("[data-setup-key]", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-setup-credit]", { timeout: 5000 });
      await sleep(300);
      check(!!(await page.$("[data-setup-credit]")), "a key with no credit keeps the card up with the step still to do");
      await h.shot("credit");
    },
  },
  {
    name: "c2-setup-from-settings",
    sizes: [[1100, 720]],
    mock: { settings: { ...SETTINGS, hasAnthropicKey: false }, threads: {} },
    async run(page) {
      await page.waitForSelector("[data-setup-card]", { timeout: 5000 });
      // As Settings does: save the key through the backend module, which tells every listener.
      await page.evaluate(async () => {
        await window.__TAURI_INTERNALS__.invoke("api_key_set", { provider: "anthropic", key: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" });
        window.dispatchEvent(new CustomEvent("phaethon:settings-changed", { detail: { what: "key" } }));
      });
      const gone = await page.waitForFunction(() => !document.querySelector("[data-setup-card]"), { timeout: 3000 }).then(() => true, () => false);
      check(gone, "a key saved in Settings puts the card away");
    },
  },
];
