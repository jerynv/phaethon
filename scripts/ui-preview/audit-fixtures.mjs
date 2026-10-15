// Shared data and page helpers for the audit-*.mjs scenarios. Lives outside
// scenarios/ so shoot.mjs does not load it as a scenario file.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

// ---- Settings and threads ----

export const SETTINGS = {
  backend: "phaethon",
  hasAnthropicKey: true,
  model: "claude-opus-5-5",
  appearance: {},
  vaultPath: "/Users/you/Phaethon/default",
  version: "0.1.0",
};

export const CONVERSATION = [
  { role: "user", text: "What do I have due this week for C241?", attachments: [] },
  {
    role: "assistant",
    text: "Two things, both in `syllabus.md`:\n\n1. **Problem set 4** is due Wednesday at 11:59 pm.\n2. **Test 1** is Thursday in class. It covers chapters 1 to 4.\n\nYou also wrote in `notes/week6.md` that you wanted to redo the recursion exercises before the test. Want me to make a study plan?",
    attachments: [],
  },
  { role: "user", text: "Yes, plan Monday to Wednesday evenings.", attachments: [{ name: "calendar.png", path: "attachments/2026-10-09/calendar.png", mediaType: "image/png" }] },
  {
    role: "assistant",
    text: "Here is a plan that fits around what is on your calendar:\n\n| Evening | Focus | Time |\n| --- | --- | --- |\n| Monday | Recursion exercises 3.1 to 3.6 | 90 min |\n| Tuesday | Problem set 4 | 2 h |\n| Wednesday | Review chapters 1 to 4, then sleep | 60 min |\n\n```python\ndef fact(n):\n    return 1 if n == 0 else n * fact(n - 1)\n```",
    attachments: [],
  },
];

export const WORK_THREAD = [
  { role: "user", text: "What is on my plate at work this week?", attachments: [] },
  { role: "assistant", text: "Three things from `projects/now.md`:\n\n1. Review the onboarding doc by **Tuesday**.\n2. Send the Q4 numbers to Dana.\n3. Prep slides for Friday's sync.", attachments: [] },
];

/** 32 messages, so the conversation scrolls well past one screen. */
export const LONG = Array.from({ length: 16 }, (_, i) => [
  { role: "user", text: `Question ${i + 1}: what should I review for chapter ${(i % 4) + 1}?`, attachments: [] },
  {
    role: "assistant",
    text: `For chapter ${(i % 4) + 1}, review the worked examples in section ${(i % 4) + 1}.2 and redo exercises ${i + 1}.1 to ${i + 1}.4.\n\n- Start with the definitions.\n- Then the proofs you skipped.\n- Finish with one timed problem.`,
    attachments: [],
  },
]).flat();

export const MARKDOWN_STRESS = [
  "# Heading one: study plan",
  "## Heading two: this week",
  "### Heading three: Monday",
  "#### Heading four: details",
  "",
  "A paragraph with **bold**, *italic*, `inline code`, a [link to the syllabus](https://example.edu/c241/syllabus) and an emoji 📚✅. The Arabic word مرحبا sits inside an English sentence.",
  "",
  "1. First, ordered",
  "   - nested bullet",
  "     - deeper bullet with `code`",
  "2. Second, ordered",
  "   1. nested ordered",
  "",
  "> A blockquote that runs long enough to wrap onto a second line, so its border and spacing can be judged against the paragraphs around it.",
  "",
  "| Week | Topic | Reading | Exercises | Due | Notes | Room | Instructor |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  "| 6 | Recursion and induction | Chapter 3, sections 3.1 to 3.6 | 3.1, 3.2, 3.4, 3.6 | Wednesday 11:59 pm | Bring questions | Ballantine 013 | Prof. Okonkwo-Harrington |",
  "| 7 | Asymptotic analysis | Chapter 4, sections 4.1 to 4.3 | 4.1 to 4.9 | Wednesday 11:59 pm | Test 1 on Thursday | Ballantine 013 | Prof. Okonkwo-Harrington |",
  "",
  "A very long unbroken address: https://example.edu/c241/fall-2026/materials/week-06/recursion/exercises/solutions/annotated-version-with-comments-from-office-hours.pdf",
  "",
  "```javascript",
  ...Array.from({ length: 28 }, (_, i) => `const line${i + 1} = computeSomethingWithAVeryLongFunctionName(argumentNumberOne, argumentNumberTwo, ${i});`),
  "```",
  "",
  "---",
  "",
  "Last line after a rule.",
].join("\n");

export const GRANTS = {
  two: [
    { id: "g-cal", from: "work", path: "calendar", created: "2026-10-09T15:20:00Z", scope: "always" },
    { id: "g-now", from: "work", path: "projects/now.md", created: "2026-10-10T09:00:00Z", scope: "always" },
  ],
  many: [
    { id: "g1", from: "work", path: "calendar", created: "2026-10-01T15:20:00Z", scope: "always" },
    { id: "g2", from: "work", path: "projects/now.md", created: "2026-10-02T09:00:00Z", scope: "always" },
    { id: "g3", from: "work", path: "meetings/2026/q4/weekly-sync-notes-with-the-whole-product-and-design-team.md", created: "2026-10-03T09:00:00Z", scope: "always" },
    { id: "g4", from: "work", path: "people", created: "2026-10-04T09:00:00Z", scope: "once" },
    { id: "g5", from: "home", path: "budget.csv", created: "2026-10-05T09:00:00Z", scope: "always" },
    { id: "g6", from: "work", path: "", created: "not a date", scope: "always" },
  ],
  long: [
    { id: "g-long", from: "work", path: "archive/2025/clients/northwind-traders/contracts/master-services-agreement-amendment-3-final-final.pdf", created: "2026-10-09T15:20:00Z", scope: "always" },
  ],
};

// ---- Files ----

const dir = mkdtempSync(join(tmpdir(), "phaethon-audit-"));
export function png(w, h) {
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
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([60 + x * 3, 140 + y * 2, 150], y * row + 1 + x * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const file = (name, body) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};
export const FILES = {
  image: file("whiteboard.png", png(48, 32)),
  pdf: file("syllabus-c241-fall-2026.pdf", "%PDF-1.4\n%fake\n"),
  notes: file("week6-notes.md", "# Week 6\n\n- recursion 3.1 to 3.6\n"),
  csv: file("grades.csv", "a,b\n1,2\n"),
  longName: file("an-extremely-long-file-name-for-the-final-project-report-draft-version-seven-with-comments.md", "# long\n"),
  docx: file("essay.docx", "not really a docx"),
};
export const EIGHT = [
  FILES.image,
  FILES.pdf,
  FILES.notes,
  FILES.csv,
  file("photo-2.png", png(40, 40)),
  file("lab-3.txt", "lab"),
  file("data.json", "{}"),
  file("reading-list.md", "- a"),
];
export const ELEVEN = [...EIGHT, file("x1.txt", "1"), file("x2.txt", "2"), file("x3.txt", "3")];

const MIME = { png: "image/png", pdf: "application/pdf", md: "", txt: "text/plain", csv: "text/csv", json: "application/json", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

/** Put files on the composer's file input, as the picker would, and fire change. */
export async function pick(page, paths) {
  await page.waitForSelector('input[type="file"]', { timeout: 5000 });
  const payload = paths.map((p) => ({ name: p.split("/").pop(), type: MIME[p.split(".").pop()] ?? "", b64: readFileSync(p).toString("base64") }));
  await page.evaluate((payload) => {
    const list = payload.map((f) => new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    const input = document.querySelector('input[type="file"]');
    Object.defineProperty(input, "files", { configurable: true, get: () => list });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, payload);
}

// ---- Page helpers ----

export const check = (ok, what, detail) => {
  if (!ok) throw new Error(`check failed: ${what}${detail ? ` (${detail})` : ""}`);
  console.log(`     check: ${what}`);
};

/** Move the pointer out of the way (no hover, no tooltip). */
export const park = (page) => page.mouse.move(2, 400);

/** The window loses focus (title bar dims), as when another app is in front. */
export const blurWindow = (page) => page.evaluate(() => window.dispatchEvent(new Event("blur")));

/** Fire dragenter with a file on the conversation, as a drag from Finder does. */
export const dragFileOver = (page) =>
  page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "photo.png", { type: "image/png" }));
    const target = document.querySelector('[role="log"]');
    target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });

/** Click a button by its visible text inside `scope`. */
export async function clickText(page, scope, text) {
  const h = await page.evaluateHandle(
    (scope, text) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.trim() === text) ?? null,
    scope,
    text,
  );
  const ok = await h.evaluate((b) => !!b);
  if (!ok) throw new Error(`no button "${text}" in ${scope}`);
  await h.click();
}

/** Show the sidebar if a narrow window started it hidden (A-010), as a person would. */
export async function showSidebar(page) {
  if (await page.evaluate(() => document.getElementById("spaces-sidebar")?.hidden)) {
    await page.click('button[aria-controls="spaces-sidebar"]');
    await page.waitForSelector("#spaces-sidebar:not([hidden])", { timeout: 5000 });
  }
}

export async function openSettings(page, h, tab) {
  await h.click('#spaces-sidebar:not([hidden]) [data-testid="open-settings"], header [data-testid="titlebar-settings"]');
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await h.idle();
  if (tab) {
    await h.click(`[data-testid="settings-tab-${tab}"]`);
    await h.idle();
  }
}

export const PANEL = '[role="dialog"] [role="tabpanel"]:not([hidden])';
export const scrollPanel = (page, y) =>
  page.evaluate((y, sel) => {
    const p = document.querySelector(sel);
    if (p) p.scrollTop = y === "end" ? p.scrollHeight : y;
  }, y, PANEL);

/**
 * Settings › Spaces lists each space folded to one line; open the details
 * (its Edit button) of the spaces named, or of every space.
 */
export async function openSpaceDetails(page, ids) {
  await page.waitForSelector(`${PANEL} [data-space-edit]`, { timeout: 5000 });
  const want = ids ?? null;
  await page.evaluate(
    (want, panel) => {
      for (const b of document.querySelectorAll(`${panel} [data-space-edit][aria-expanded="false"]`)) if (!want || want.includes(b.dataset.spaceEdit)) b.click();
    },
    want,
    PANEL,
  );
  await page.waitForFunction(
    (want, panel) => [...document.querySelectorAll(`${panel} [data-space-edit]`)].every((b) => (want && !want.includes(b.dataset.spaceEdit)) || b.getAttribute("aria-expanded") === "true"),
    { timeout: 3000 },
    want,
    PANEL,
  );
}

/** Scroll an element into the middle of its scroller. */
export const reveal = (page, sel) => page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), sel);

export const activeDesc = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return a ? `${a.tagName.toLowerCase()}[${a.getAttribute("aria-label") ?? a.textContent?.trim().slice(0, 40) ?? ""}]` : "none";
  });
