// Chat scenarios: attachments, the + menu, a long markdown reply, errors, and
// behaviour checks (what agent_send receives, the approval flow, the status
// region). A check that fails throws, so shoot.mjs reports the scenario FAILED.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

// ---- fixture files, written once per run ----
const dir = mkdtempSync(join(tmpdir(), "phaethon-chat-"));
function png(w, h) {
  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (const b of buf) {
      let c = (crc ^ b) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set([60 + x * 3, 140 + y * 2, 150], y * row + 1 + x * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const files = {
  image: join(dir, "whiteboard.png"),
  notes: join(dir, "week6-notes.md"),
  zip: join(dir, "lecture-recordings.zip"),
};
writeFileSync(files.image, png(48, 32));
writeFileSync(files.notes, "# Week 6\n\n- recursion 3.1 to 3.6\n- problem set 4\n");
writeFileSync(files.zip, "PK");

// ---- helpers ----
const types = { ".png": "image/png", ".md": "", ".zip": "application/zip" };
/**
 * Put files on the composer's file input as the picker would. Obscura refuses
 * DOM.setFileInputFiles without --allow-file-access and has no DataTransfer,
 * so the File objects are built in the page, put on the input's `files`, and
 * `change` is fired: the same event the picker fires.
 */
const pick = async (page, ...paths) => {
  await page.waitForSelector('input[type="file"]', { timeout: 5000 });
  const payload = paths.map((p) => ({
    name: p.split("/").pop(),
    type: types[p.slice(p.lastIndexOf("."))] ?? "",
    b64: readFileSync(p).toString("base64"),
  }));
  await page.evaluate((payload) => {
    const list = payload.map((f) => {
      const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      return new File([bytes], f.name, { type: f.type });
    });
    const input = document.querySelector('input[type="file"]');
    Object.defineProperty(input, "files", { configurable: true, get: () => list });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, payload);
};
const attach = async (page, ...paths) => {
  await pick(page, ...paths);
  await page.waitForFunction((n) => document.querySelectorAll('[aria-label="Attached files"] li').length >= n, { timeout: 5000 }, paths.length);
};
const check = (ok, what, detail) => {
  if (!ok) throw new Error(`check failed: ${what}${detail ? ` (${detail})` : ""}`);
  console.log(`     check: ${what}`);
};
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter((c) => c[0] === cmd).map((c) => c[1]), cmd);

const markdownReply = [
  "## Study plan for Test 1",
  "",
  "Here is what I found in `syllabus.md` and your week 6 notes. The test covers **chapters 1 to 4**; recursion is the part you flagged as shaky.",
  "",
  "### What to do each evening",
  "",
  "1. **Monday**: recursion exercises 3.1 to 3.6, then check against the solutions.",
  "2. **Tuesday**: finish problem set 4, which is due Wednesday at 11:59 pm.",
  "3. **Wednesday**: one pass over chapters 1 to 4, then sleep.",
  "",
  "| Evening | Focus | Time | Done |",
  "| --- | --- | ---: | :---: |",
  "| Monday | Recursion 3.1 to 3.6 | 90 min | no |",
  "| Tuesday | Problem set 4 | 2 h | no |",
  "| Wednesday | Review ch. 1 to 4 | 60 min | no |",
  "",
  "A quick way to test yourself on recursion:",
  "",
  "```python",
  "def fact(n: int) -> int:",
  "    \"\"\"n! by recursion; fact(0) is 1.\"\"\"",
  "    return 1 if n == 0 else n * fact(n - 1)",
  "",
  "assert fact(5) == 120",
  "```",
  "",
  "> Tip from your notes: write the base case first, then the step.",
  "",
  "- Bring a pencil and your student ID.",
  "- The room is **Ballantine 013**.",
].join("\n");

const reloaded = [
  {
    role: "user",
    text: "Can you turn these into a study plan?",
    attachments: [
      { name: "whiteboard.png", path: "attachments/2026-10-09/whiteboard.png", mediaType: "image/png" },
      { name: "syllabus-c241-fall-2026.pdf", path: "attachments/2026-10-09/syllabus-c241-fall-2026.pdf", mediaType: "application/pdf" },
      { name: "week6-notes.md", path: "attachments/2026-10-09/week6-notes.md", mediaType: "text/plain" },
    ],
  },
  { role: "assistant", text: markdownReply, attachments: [] },
];

export default [
  {
    name: "chat-attachments",
    mock: { threads: {} },
    async run(page, h) {
      await attach(page, files.image, files.notes);
      await page.focus("[data-composer-input]");
      await page.keyboard.type("What should I study first?");
      await h.idle();
    },
  },
  {
    name: "chat-rejected",
    mock: { threads: {} },
    async run(page, h) {
      await pick(page, files.zip);
      await h.waitText("lecture-recordings.zip can’t be attached");
      const n = await page.evaluate(() => document.querySelectorAll('[aria-label="Attached files"] li').length);
      check(n === 0, "a .zip is refused, with a visible reason, and not attached");
      await h.idle();
    },
  },
  {
    name: "chat-menu",
    mock: { threads: {} },
    async run(page, h) {
      await h.click('button[aria-label="Add to message"]');
      await page.waitForSelector('[role="menu"]', { timeout: 5000 });
      await h.idle();
    },
  },
  {
    name: "chat-reloaded",
    mock: { threads: { school: reloaded } },
    async run(page, h) {
      await h.waitText("Study plan for Test 1");
      const chips = await page.evaluate(() => [...document.querySelectorAll('[aria-label="Files sent"] li')].map((li) => li.textContent));
      check(chips.length === 3, "a reloaded user message shows its 3 saved attachments", chips.join(" | "));
      const status = await page.evaluate(() => document.querySelector('[data-testid="reply-status"]').textContent);
      check(status === "", "a reply loaded from the saved thread is not announced", JSON.stringify(status));
      await page.evaluate(() => {
        const log = document.querySelector('[role="log"]');
        log.scrollTop = 0;
      });
      await h.idle();
    },
  },
  {
    name: "chat-markdown-end",
    mock: { threads: { school: reloaded } },
    async run(page, h) {
      await h.waitText("Ballantine 013");
      await h.idle();
    },
  },
  {
    name: "chat-attachment-error",
    mock: {
      threads: {},
      sendError: { code: "attachment", message: "These files are too large together (the limit is 30 MB per message)." },
    },
    async run(page, h) {
      await attach(page, files.notes);
      await h.send("Summarise this");
      await h.waitText("too large together");
      const alert = await page.evaluate(() => document.querySelector('[data-role="assistant"] [role="alert"]')?.textContent ?? "");
      check(alert.includes("A file couldn’t be attached"), "an attachment error renders in the message as role=alert with a recovery line", alert);
      await h.idle();
    },
  },
  {
    name: "chat-send-files",
    mock: { threads: {}, turn: [{ kind: "tool", label: "Reading file week6-notes.md" }, { kind: "text", delta: "Start with recursion." }] },
    async run(page, h) {
      await attach(page, files.image, files.notes);
      // Sent with the Send button: Obscura ignores preventDefault on Enter in a
      // textarea and inserts a newline after the composer clears.
      await page.focus("[data-composer-input]");
      await page.keyboard.type("What should I study first?");
      await h.click('button[aria-label="Send message"]');
      await h.waitText("Start with recursion.");
      const [args] = await calls(page, "agent_send");
      check(!!args, "agent_send was called");
      check(args.prompt === "What should I study first?", "agent_send got the prompt", args.prompt);
      const a = args.attachments ?? [];
      check(a.length === 2, "agent_send got 2 attachments", String(a.length));
      check(a[0].name === "whiteboard.png" && a[0].mediaType === "image/png", "first is whiteboard.png, image/png", `${a[0].name} ${a[0].mediaType}`);
      check(a[1].name === "week6-notes.md" && /^text\//.test(a[1].mediaType), "second is week6-notes.md, text/*", `${a[1].name} ${a[1].mediaType}`);
      check(!a[0].data.startsWith("data:") && a[0].data.startsWith("iVBORw0KGgo"), "image data is bare base64 of a PNG", a[0].data.slice(0, 16));
      check(Buffer.from(a[1].data, "base64").toString().startsWith("# Week 6"), "text data decodes to the file's contents");
      const sent = await page.evaluate(() => [...document.querySelectorAll('[aria-label="Files sent"] li')].length);
      check(sent === 2, "the sent message shows both files");
      const left = await page.evaluate(() => document.querySelectorAll('[aria-label="Attached files"] li').length);
      check(left === 0, "the composer's attachments are cleared after sending");
      const value = await page.evaluate(() => document.querySelector("[data-composer-input]").value);
      check(value === "", "the composer's text is cleared after sending", JSON.stringify(value));
      await page.waitForFunction(() => document.querySelector('[data-testid="reply-status"]').textContent.startsWith("Phaethon replied"), { timeout: 5000 });
      const status = await page.evaluate(() => document.querySelector('[data-testid="reply-status"]').textContent);
      check(status === "Phaethon replied: Start with recursion.", "status region announces the whole reply once complete", status);
      await h.idle();
    },
  },
  {
    name: "chat-escape-stops",
    mock: { threads: {}, holdOpen: true, turn: [{ kind: "tool", label: "Reading file syllabus.md" }] },
    async run(page, h) {
      await page.focus("[data-composer-input]");
      await page.keyboard.type("What is due?");
      await h.click('button[aria-label="Send message"]');
      await page.waitForSelector('button[aria-label="Stop reply"]', { timeout: 5000 });
      await h.idle();
      await page.focus("[data-composer-input]");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => window.__calls.some((c) => c[0] === "agent_cancel"), { timeout: 5000 });
      check(true, "Escape in the composer stops the reply (agent_cancel called)");
      // The real backend answers a cancel with a `cancelled` event ("Reply
      // stopped."); mock-ipc does not send one, so the reply stays running here.
      await h.idle();
    },
  },
  {
    name: "chat-approval-flow",
    mock: {
      threads: {},
      turn: [
        { kind: "text", delta: "I'll put the plan in a file so you can tick things off." },
        { kind: "tool", label: "Waiting for you to allow: Writing file plans/week6.md" },
        { waitApproval: true, id: "toolu_1", summary: "Create a new file plans/week6.md (4 lines).", detail: "# Week 6\n\n- [ ] Mon: recursion\n- [ ] Tue: problem set 4\n" },
        { kind: "tool", label: "Writing file plans/week6.md" },
        { kind: "text", delta: " Done: plans/week6.md is in your school space." },
      ],
    },
    async run(page, h) {
      await h.send("Make the plan a file.");
      await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 });
      await h.idle();
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("role"));
      check(focused === "alertdialog", "the approval card takes focus when it appears", focused);
      const modal = await page.evaluate(() => document.querySelector('[role="alertdialog"]').getAttribute("aria-modal"));
      check(modal === "false", "the approval card is aria-modal=false");
      // N-008: the primary answer is last in Tab order and rightmost, as on the access card.
      const answers = await page.evaluate(() =>
        [...document.querySelectorAll('[role="alertdialog"] button:not([data-view]):not([data-approval-show-all])')].map((b) => {
          const r = b.getBoundingClientRect();
          return { text: b.textContent.trim(), right: r.right, mid: r.top + r.height / 2 };
        }),
      );
      check(answers.map((a) => a.text).join("|") === "Don’t allow|Allow", "the approval card's answers are Don’t allow, then Allow", answers.map((a) => a.text).join("|"));
      const sameRow = Math.abs(answers[1].mid - answers[0].mid) < 8;
      check(sameRow ? answers[1].right > answers[0].right : answers[1].mid > answers[0].mid, "Allow (the primary) is last and on the right", JSON.stringify(answers));
      const stops = [];
      while (stops.length < 6) {
        await page.keyboard.press("Tab");
        const el = await page.evaluate(() => {
          const a = document.activeElement;
          return a?.hasAttribute("data-approval-preview") ? "preview" : a?.getAttribute("role") === "alertdialog" ? "card" : a?.textContent.trim();
        });
        stops.push(el);
        if (el === "Allow" || el === "card") break;
      }
      // Obscura does not move focus on Tab from a tabindex=-1 element; Chromium does.
      if (stops[0] === "card") console.log("     (this engine does not Tab out of a focused card; DOM order check above stands)");
      else check(stops.join("|") === "Formatted|Plain text|preview|Don’t allow|Allow", "Tab from the card visits the views, the preview, Don’t allow, Allow", stops.join("|"));
      await page.evaluate(() => document.querySelector('[role="alertdialog"]').focus());
      const status = await page.evaluate(() => document.querySelector('[data-testid="reply-status"]').textContent);
      check(!status.includes("Waiting for you"), "the status region does not also announce the approval", status);
      const allow = await page.evaluateHandle(() => [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.trim() === "Allow"));
      await allow.click();
      await page.waitForFunction(() => !document.querySelector('[role="alertdialog"]'), { timeout: 5000 });
      const approvals = await calls(page, "agent_approve");
      check(approvals.length === 1 && approvals[0].allow === true && approvals[0].id === "toolu_1", "Allow calls agent_approve with allow:true", JSON.stringify(approvals));
      const back = await page.evaluate(() => document.activeElement?.hasAttribute("data-composer-input"));
      check(back, "focus is back in the composer after answering");
      await h.waitText("Done: plans/week6.md");
      await page.waitForFunction(() => document.querySelector('[data-testid="reply-status"]').textContent.includes("Phaethon replied"), { timeout: 5000 });
      const done = await page.evaluate(() => document.querySelector('[data-testid="reply-status"]').textContent);
      check(done.includes("Done: plans/week6.md"), "status region announces the reply after the approval", done);
      await h.idle();
    },
  },
];
