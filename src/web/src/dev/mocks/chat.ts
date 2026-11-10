/**
 * Fake core commands for the conversation and the file viewer (dev only,
 * `#mock` in the page's address). `agent_send` streams a scripted reply chosen
 * by a keyword in the prompt, so every state can be seen:
 *   (default)        markdown, math, a table, a citation, tool work
 *   "write"/"save"   a write that waits for approval (a replace, with a diff)
 *   "calendar"       an access request to another space
 *   "teach"          a lesson plan with its map, then a check question
 *   "explain back"   an explain-back question
 *   "practice"       a quiz offered as a phaethon-study card
 *   "settings"       buttons (phaethon-actions)
 *   "error"/"rate"   a failed reply (no API key / rate limit)
 *   "slow"           a long reply, slow enough to stop
 * `#mock&thread=pending` loads a conversation that ends with an unanswered question;
 * `&thread=empty` an empty one; `&thread=long` a long one.
 */
import { zipSync, strToU8 } from "fflate";

import type { AccessAnswer, AgentEvent, LessonAnswer, UiMessage } from "#shared/agent.ts";
import { sleep, type MockChannel } from "../mock-core";

const hash = new URLSearchParams(location.hash.slice(1));
const C241 = "courses/CSCI-C 241 Fall 2026";
const now = Date.now();

const NOTES_BEFORE = `# Week 6: Functions

- A function f: A → B assigns each a in A exactly one b in B.
- Injective: f(a) = f(b) implies a = b.
- Surjective: every b has some a with f(a) = b.

## To review
- Composition
`;

const NOTES_AFTER = `# Week 6: Functions

- A function $f: A \\to B$ assigns each $a \\in A$ exactly one $b \\in B$.
- **Injective** (one-to-one): $f(a) = f(b)$ implies $a = b$.
- **Surjective** (onto): every $b \\in B$ has some $a$ with $f(a) = b$.
- **Bijective**: both. Then $f$ has an inverse $f^{-1}$.

## To review
- Composition: $(g \\circ f)(x) = g(f(x))$
- Is the composition of two injections injective? (Yes.)
`;

const DEFAULT_REPLY = `An **injective** function never sends two inputs to the same output; a **surjective** one reaches every element of its codomain. Your course states it this way [source: ${C241}/files/Lecture 7 Functions.pdf "A function is injective if f(a) = f(b) implies a = b"].

Here is the reasoning, one step at a time:

1. Take $f(x) = 2x + 1$ on the integers.
2. If $f(a) = f(b)$ then $2a + 1 = 2b + 1$, so $a = b$. **Injective.**
3. Is $4$ reached? We'd need $2x + 1 = 4$, so $x = \\tfrac{3}{2} \\notin \\mathbb{Z}$. **Not surjective.**

$$
|A| \\le |B| \\quad\\text{whenever an injection } f\\colon A \\to B \\text{ exists.}
$$

| Property | Test | Example on $\\mathbb{Z}$ |
|---|---|---|
| Injective | $f(a)=f(b) \\Rightarrow a=b$ | $x \\mapsto 2x+1$ |
| Surjective | every $b$ is hit | $x \\mapsto x - 3$ |
| Bijective | both | $x \\mapsto -x$ |

A quick check in Python:

\`\`\`python
def is_injective(f, domain):
    seen = set()
    for x in domain:
        if f(x) in seen:
            return False
        seen.add(f(x))
    return True
\`\`\`

Test 1 covers this, but not graphs or combinatorics [source: ${C241}/announcements.md "Test 1 will not cover graphs or combinatorics."].`;

const SAVED: UiMessage[] = [
  { role: "user", text: "What’s the difference between injective and surjective? I keep mixing them up.", attachments: [], index: 0, records: [], at: now - 3_600_000 },
  {
    role: "assistant",
    text: DEFAULT_REPLY,
    attachments: [],
    index: 1,
    records: [
      { kind: "tool", id: "t1", category: "search", label: "Searching files for “injective”", status: "success" },
      { kind: "tool", id: "t2", category: "read", label: "Reading file", target: `${C241}/files/Lecture 7 Functions.md`, status: "success" },
      { kind: "tool", id: "t3", category: "read", label: "Reading file", target: `${C241}/announcements.md`, status: "success" },
    ],
    at: now - 3_590_000,
  },
  {
    role: "user",
    text: "Can you turn my week 6 notes into a cleaner summary?",
    attachments: [{ name: "whiteboard.png", path: "files/whiteboard.png", mediaType: "image/png" }],
    index: 2,
    records: [],
    at: now - 1_800_000,
  },
  {
    role: "assistant",
    text: "Done. I rewrote **notes/week6.md** with the definitions in math notation and added the composition rule.\n\n```phaethon-actions\nshow-folder\n```",
    attachments: [],
    index: 3,
    records: [
      { kind: "tool", id: "t4", category: "read", label: "Reading file", target: "notes/week6.md", status: "success" },
      { kind: "tool", id: "t5", category: "write", label: "Changing file", target: "notes/week6.md", status: "success" },
      { kind: "approval", path: "notes/week6.md", action: "replace", allowed: true },
    ],
    at: now - 1_790_000,
  },
];

const PENDING: UiMessage[] = [
  { role: "user", text: "Teach me how to prove a function is injective.", attachments: [], index: 0, records: [], at: now - 120_000 },
  {
    role: "assistant",
    text: "Before I explain, make a prediction. There is no wrong answer here: it shows me where to start.",
    attachments: [],
    index: 1,
    records: [
      {
        kind: "lessonPlan",
        id: "lp1",
        goal: "Prove that a function is injective",
        map: "flowchart LR\n  a[What a function is] --> b[Injective means one-to-one]\n  b --> c[Direct proof: assume f a = f b]\n  c --> d[Algebra to reach a = b]\n  d --> e[Counterexamples for non-injective]",
        nodes: [
          { id: "a", label: "What a function is" },
          { id: "b", label: "Injective means one-to-one" },
          { id: "c", label: "Direct proof: assume f(a) = f(b)" },
          { id: "d", label: "Algebra to reach a = b" },
          { id: "e", label: "Counterexamples for functions that aren’t injective" },
        ],
      },
    ],
    at: now - 110_000,
    pending: {
      kind: "check",
      question: {
        id: "q-saved",
        role: "predict",
        question: "To prove $f(x) = 3x - 7$ is injective on $\\mathbb{R}$, what is the first line of the proof?",
        options: [
          { value: "a", label: "Let $y \\in \\mathbb{R}$; find $x$ with $f(x) = y$." },
          { value: "b", label: "Suppose $f(a) = f(b)$ for some $a, b \\in \\mathbb{R}$." },
          { value: "c", label: "Check that $f(0) \\ne f(1)$." },
          { value: "d", label: "Show that $f$ is increasing." },
        ],
        multiSelect: false,
      },
    },
  },
];

function longThread(): UiMessage[] {
  const out: UiMessage[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({ role: "user", text: `Question ${i + 1}: what about part (${String.fromCharCode(97 + i)})?`, attachments: [], index: i * 2, records: [], at: now - (9 - i) * 600_000 });
    out.push({ role: "assistant", text: DEFAULT_REPLY, attachments: [], index: i * 2 + 1, records: [], at: now - (9 - i) * 600_000 + 20_000 });
  }
  return out;
}

const threads: Record<string, UiMessage[]> = {
  school: hash.get("thread") === "pending" ? PENDING : hash.get("thread") === "empty" ? [] : hash.get("thread") === "long" ? longThread() : SAVED,
  work: [],
};

// ---- A running turn ----

type Turn = { cancelled: boolean; wake?: () => void };
const turns = new Map<string, Turn>();
const waiting = new Map<string, (v: unknown) => void>();

function waitFor<T>(space: string, id: string, turn: Turn): Promise<T | "cancelled"> {
  return new Promise((resolve) => {
    waiting.set(`${space}\n${id}`, resolve as (v: unknown) => void);
    turn.wake = () => resolve("cancelled");
  });
}

async function say(ch: MockChannel, turn: Turn, text: string, speed = 14) {
  let i = 0;
  while (i < text.length) {
    if (turn.cancelled || ch.closed) return;
    const n = 3 + Math.floor(Math.random() * 9);
    ch.send({ kind: "text", delta: text.slice(i, i + n) } satisfies AgentEvent);
    i += n;
    await sleep(speed);
  }
}

async function tool(ch: MockChannel, turn: Turn, id: string, category: "read" | "search" | "list" | "write", label: string, target?: string, ms = 350, status: "success" | "failed" = "success", detail?: string) {
  if (turn.cancelled) return;
  ch.send({ kind: "toolStart", id, category, label, target } satisfies AgentEvent);
  ch.send({ kind: "tool", label: target ? `${label} ${target}` : label } satisfies AgentEvent);
  await sleep(ms);
  ch.send({ kind: "toolEnd", id, status, detail } satisfies AgentEvent);
  ch.send({ kind: "record", record: { kind: "tool", id, category, label, target, status, detail } } satisfies AgentEvent);
}

function end(ch: MockChannel, space: string, turn: Turn, saved?: UiMessage[]) {
  if (turn.cancelled) {
    ch.send({ kind: "cancelled" });
    ch.send({ kind: "record", record: { kind: "stopped" } });
  }
  if (saved) threads[space] = saved;
  ch.send({ kind: "end", sessionId: null });
  turns.delete(space);
}

/** What the core would save: the prompt and the reply's text, at the next positions. */
function saveTurn(space: string, prompt: string, reply: string, records: UiMessage["records"] = [], replaceFrom?: number, pending?: UiMessage["pending"]) {
  const base = replaceFrom !== undefined ? threads[space].filter((m) => m.index < replaceFrom) : threads[space];
  const next = base.length ? Math.max(...base.map((m) => m.index)) + 1 : 0;
  const out = [...base];
  if (prompt) out.push({ role: "user", text: prompt, attachments: [], index: next, records: [], at: Date.now() });
  out.push({ role: "assistant", text: reply, attachments: [], index: next + 1, records, at: Date.now(), pending });
  return out;
}

async function run(args: Record<string, unknown>) {
  const space = String(args.space);
  const prompt = String(args.prompt ?? "");
  const ch = args.onEvent as MockChannel;
  const replaceFrom = typeof args.replaceFrom === "number" ? args.replaceFrom : undefined;
  const turn: Turn = { cancelled: false };
  turns.set(space, turn);
  const p = prompt.toLowerCase();
  await sleep(500);

  if (typeof args.continueFrom === "number") {
    await say(ch, turn, "Picking up where it stopped: the last step is to check that the inverse really undoes $f$, so $f^{-1}(f(x)) = x$ for every $x$.");
    return end(ch, space, turn);
  }

  if (p.includes("error")) {
    ch.send({ kind: "error", code: "noApiKey", message: "No API key is saved for Anthropic." });
    return end(ch, space, turn);
  }
  if (p.includes("rate")) {
    await say(ch, turn, "Let me look at your notes for");
    ch.send({ kind: "error", code: "rateLimit", message: "429 Too Many Requests: rate_limit_error", retryAfterSecs: 42 });
    return end(ch, space, turn);
  }

  if (p.includes("write") || p.includes("save")) {
    await tool(ch, turn, "w0", "read", "Reading file", "notes/week6.md");
    await say(ch, turn, "I’ll tidy the definitions and add the composition rule.\n\n");
    ch.send({ kind: "toolStart", id: "w1", category: "write", label: "Changing file", target: "notes/week6.md" });
    ch.send({ kind: "tool", label: "Waiting for you to allow: Writing file notes/week6.md" });
    ch.send({
      kind: "approval",
      id: "w1",
      summary: `Replace the file notes/week6.md with new contents (${NOTES_AFTER.trimEnd().split("\n").length} lines).`,
      detail: NOTES_AFTER,
      action: "replace",
      path: "notes/week6.md",
      space,
      before: NOTES_BEFORE,
      truncated: false,
    });
    const allowed = await waitFor<boolean>(space, "w1", turn);
    const ok = allowed === true;
    ch.send({ kind: "approvalDone", id: "w1", allowed: ok });
    if (allowed === "cancelled") return end(ch, space, turn);
    ch.send({ kind: "record", record: { kind: "approval", path: "notes/week6.md", action: "replace", allowed: ok } });
    if (ok) ch.send({ kind: "tool", label: "Writing file notes/week6.md" });
    await sleep(250);
    ch.send({ kind: "toolEnd", id: "w1", status: ok ? "success" : "failed", detail: ok ? undefined : "Declined" });
    ch.send({ kind: "record", record: { kind: "tool", id: "w1", category: "write", label: "Changing file", target: "notes/week6.md", status: ok ? "success" : "failed" } });
    const reply = ok ? "Saved. The notes now use math notation and end with the composition rule." : "Nothing was changed. Tell me what you’d like different and I’ll try again.";
    await say(ch, turn, reply);
    return end(ch, space, turn, saveTurn(space, prompt, `I’ll tidy the definitions and add the composition rule.\n\n${reply}`, [{ kind: "approval", path: "notes/week6.md", action: "replace", allowed: ok }], replaceFrom));
  }

  if (p.includes("calendar")) {
    await tool(ch, turn, "c0", "list", "Listing the space");
    ch.send({ kind: "toolStart", id: "c1", category: "other", label: "Using tool", target: "calendar" });
    ch.send({ kind: "tool", label: "Waiting for you to answer: Asking for read access to work/calendar" });
    ch.send({ kind: "accessRequest", id: "c1", space: "work", path: "calendar", reason: "To check which evenings are free before planning study sessions for Test 1." });
    const answer = await waitFor<AccessAnswer>(space, "c1", turn);
    const a: AccessAnswer = answer === "cancelled" ? "deny" : answer;
    ch.send({ kind: "accessRequestDone", id: "c1", answer: a });
    if (answer === "cancelled") return end(ch, space, turn);
    ch.send({ kind: "record", record: { kind: "access", space: "work", path: "calendar", answer: a } });
    ch.send({ kind: "toolEnd", id: "c1", status: a === "deny" ? "failed" : "success" });
    if (a !== "deny") {
      ch.send({ kind: "tool", label: "Reading work/calendar/oct.md" });
      await sleep(300);
      ch.send({ kind: "record", record: { kind: "read", space: "work", path: "calendar/oct.md", tool: "read" } });
    }
    const reply =
      a === "deny"
        ? "Understood. Tell me which evenings you’re free and I’ll plan around them."
        : "You’re free Tuesday and Thursday evenings, so I’d put two 45-minute sessions there before Test 1:\n\n- **Tue:** functions and relations (HW 5)\n- **Thu:** proofs by induction (HW 6)";
    await say(ch, turn, reply);
    return end(ch, space, turn, saveTurn(space, prompt, reply, [{ kind: "access", space: "work", path: "calendar", answer: a }], replaceFrom));
  }

  if (p.includes("explain back")) {
    const intro = "You’ve worked through composition. Now put it in your own words.";
    await say(ch, turn, intro);
    const q = { id: "eb1", question: "Explain why the composition of two injective functions is injective, as if to a classmate who missed the lecture." };
    ch.send({ kind: "explainBack", question: q });
    return end(ch, space, turn, saveTurn(space, prompt, intro, [], replaceFrom, { kind: "explainBack", question: q }));
  }

  if (p.includes("teach")) {
    await tool(ch, turn, "l0", "read", "Reading file", `${C241}/files/Lecture 7 Functions.md`);
    const plan = {
      kind: "lessonPlan" as const,
      id: "lp2",
      goal: "Prove that a function is injective",
      map: "flowchart LR\n  a[What a function is] --> b[Injective means one-to-one]\n  b --> c[Direct proof]\n  c --> d[Algebra to reach a = b]\n  b --> e[Counterexamples]",
      nodes: [
        { id: "a", label: "What a function is" },
        { id: "b", label: "Injective means one-to-one" },
        { id: "c", label: "Direct proof: assume f(a) = f(b)" },
        { id: "d", label: "Algebra to reach a = b" },
        { id: "e", label: "Counterexamples for functions that aren’t injective" },
      ],
    };
    ch.send({ kind: "record", record: plan });
    const intro = "Here’s the path we’ll take. First, a prediction: there’s no wrong answer, it shows me where to start.";
    await say(ch, turn, intro);
    const q = {
        id: "q1",
        role: "predict" as const,
        question: "To prove $f(x) = 3x - 7$ is injective on $\\mathbb{R}$, what is the first line of the proof?",
        options: [
          { value: "a", label: "Let $y \\in \\mathbb{R}$; find $x$ with $f(x) = y$." },
          { value: "b", label: "Suppose $f(a) = f(b)$ for some $a, b \\in \\mathbb{R}$." },
          { value: "c", label: "Check that $f(0) \\ne f(1)$." },
          { value: "d", label: "Show that $f$ is increasing." },
        ],
        multiSelect: false,
    };
    ch.send({ kind: "check", question: q });
    return end(ch, space, turn, saveTurn(space, prompt, intro, [plan], replaceFrom, { kind: "check", question: q }));
  }

  if (p.includes("practice")) {
    const reply = `I’ll have Phaethon make a 10-question practice test for **Test 1** from your C241 notes and homework, through HW 6 and leaving out graphs and combinatorics. It mixes multiple choice, true or false and short proofs at exam level.\n\n\`\`\`phaethon-study\n{"kind": "quiz", "title": "Test 1 practice", "exam": "Test 1", "focus": "", "count": 10, "kinds": ["choice", "truefalse", "short"], "difficulty": "exam", "sources": ["${C241}"]}\n\`\`\``;
    await say(ch, turn, reply, 8);
    return end(ch, space, turn, saveTurn(space, prompt, reply, [], replaceFrom));
  }

  if (p.includes("settings") || p.includes("key")) {
    const reply = "Keys live in **Settings › Assistant**, and you can bring files into this space from your computer.\n\n```phaethon-actions\nsettings-assistant\nadd-files\nshow-folder\n```";
    await say(ch, turn, reply, 8);
    return end(ch, space, turn, saveTurn(space, prompt, reply, [], replaceFrom));
  }

  // Default: tool work, a progress line, a markdown reply.
  ch.send({ kind: "thinking", delta: "The student mixes up the two definitions. " });
  await sleep(200);
  ch.send({ kind: "thinking", delta: "Start from the course's own wording, then one worked example that is injective but not surjective, then a table." });
  await tool(ch, turn, "d1", "search", "Searching files for “injective”", undefined, 400);
  await tool(ch, turn, "d2", "read", "Reading file", `${C241}/files/Lecture 7 Functions.md`, 450);
  await tool(ch, turn, "d3", "read", "Reading file", `${C241}/syllabus.md`, 300, "failed", "No such file in this course");
  ch.send({ kind: "progress", text: "Found the definition in Lecture 7; checking what Test 1 covers." });
  await tool(ch, turn, "d4", "read", "Reading file", `${C241}/announcements.md`, 300);
  await say(ch, turn, DEFAULT_REPLY, p.includes("slow") ? 60 : 6);
  if (turn.cancelled) {
    return end(ch, space, turn, saveTurn(space, prompt, DEFAULT_REPLY.slice(0, 200), [{ kind: "stopped" }], replaceFrom));
  }
  return end(ch, space, turn, saveTurn(space, prompt, DEFAULT_REPLY, [], replaceFrom));
}

async function lesson(args: Record<string, unknown>) {
  const space = String(args.space);
  const ch = args.onEvent as MockChannel;
  const a = args.answer as LessonAnswer;
  const turn: Turn = { cancelled: false };
  turns.set(space, turn);
  await sleep(400);
  const right = a.answers?.includes("b") ?? false;
  const question = "To prove f(x) = 3x − 7 is injective on ℝ, what is the first line of the proof?";
  ch.send({
    kind: "record",
    record: { kind: "check", id: String(args.id), question: a.text ? "Explain why the composition of two injective functions is injective." : question, answered: true, correct: a.dontKnow ? false : a.text ? undefined : right, confidence: a.confidence },
  });
  const reply = a.dontKnow
    ? "That’s fine: this is what we’re here for. An injectivity proof always starts from two inputs with the same output: **suppose $f(a) = f(b)$**. Then you show $a = b$."
    : a.text
      ? "Good explanation. You named the key step: from $g(f(a)) = g(f(b))$, injectivity of $g$ gives $f(a) = f(b)$, and then injectivity of $f$ gives $a = b$. One gap: say where each assumption is used."
      : right
        ? `Yes. You start from **$f(a) = f(b)$** and work toward $a = b$:\n\n$$3a - 7 = 3b - 7 \\;\\Rightarrow\\; 3a = 3b \\;\\Rightarrow\\; a = b.$$\n\n${a.confidence !== undefined && a.confidence < 50 ? "You were unsure, but your instinct was right." : "And you were sure, rightly."}`
        : "Not quite: that line starts a **surjectivity** proof. For injectivity, start from two inputs with the same output: **suppose $f(a) = f(b)$**, then show $a = b$.";
  await say(ch, turn, reply);
  const t = threads[space];
  const last = t[t.length - 1];
  const rec = { kind: "check" as const, id: String(args.id), question, answered: true, correct: a.dontKnow ? false : a.text ? undefined : right, confidence: a.confidence };
  end(ch, space, turn, [...t.slice(0, -1), { ...last, pending: undefined, text: `${last.text}\n\n${reply}`, records: [...last.records, rec] }]);
  return true;
}

// ---- Files for the viewer ----

function pdfBytes(): Uint8Array {
  const lines = ["BT /F1 22 Tf 60 740 Td (Lecture 7: Functions) Tj ET", "BT /F1 12 Tf 60 700 Td (A function is injective if f\\(a\\) = f\\(b\\) implies a = b.) Tj ET", "BT /F1 12 Tf 60 680 Td (A function is surjective if every b in B has a preimage.) Tj ET"];
  const content = lines.join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return strToU8(out);
}

function docxBytes(): Uint8Array {
  const p = (t: string, bold = false) => `<w:p><w:r>${bold ? "<w:rPr><w:b/><w:sz w:val=\"32\"/></w:rPr>" : ""}<w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p("Homework 6", true)}${p("1. Prove that f(x) = 3x − 7 is injective.")}${p("2. Is the composition of two surjections surjective? Prove it.")}${p("3. Give a function from ℕ to ℕ that is surjective but not injective.")}</w:body></w:document>`,
    ),
  });
}

async function pngBytes(): Promise<ArrayBuffer> {
  const c = new OffscreenCanvas(640, 400);
  const g = c.getContext("2d")!;
  g.fillStyle = "#f7f7f5";
  g.fillRect(0, 0, 640, 400);
  g.strokeStyle = "#2b6cb0";
  g.lineWidth = 3;
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.ellipse(170, 200, 90, 150, 0, 0, Math.PI * 2);
    g.stroke();
  }
  g.beginPath();
  g.ellipse(470, 200, 90, 150, 0, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = "#1a202c";
  g.font = "28px sans-serif";
  ["1", "2", "3"].forEach((t, i) => g.fillText(t, 160, 120 + i * 80));
  ["a", "b", "c"].forEach((t, i) => g.fillText(t, 460, 120 + i * 80));
  g.beginPath();
  [0, 1, 2].forEach((i) => {
    g.moveTo(185, 112 + i * 80);
    g.lineTo(450, 112 + ((i + 1) % 3) * 80);
  });
  g.stroke();
  return (await c.convertToBlob({ type: "image/png" })).arrayBuffer();
}

const FILES: Record<string, { name: string; kind: string; mediaType: string; text?: string; language?: string }> = {
  "notes/week6.md": { name: "week6.md", kind: "markdown", mediaType: "text/markdown", text: NOTES_AFTER },
  [`${C241}/files/Lecture 7 Functions.pdf`]: { name: "Lecture 7 Functions.pdf", kind: "pdf", mediaType: "application/pdf" },
  [`${C241}/files/Lecture 7 Functions.md`]: { name: "Lecture 7 Functions.md", kind: "markdown", mediaType: "text/markdown", text: "# Lecture 7: Functions\n\nA function is injective if f(a) = f(b) implies a = b.\n\nSee also [the homework](HW6.docx)." },
  [`${C241}/files/HW6.docx`]: { name: "HW6.docx", kind: "docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  "files/whiteboard.png": { name: "whiteboard.png", kind: "image", mediaType: "image/png" },
  "scripts/check.py": { name: "check.py", kind: "text", mediaType: "text/x-python", language: "python", text: "def is_injective(f, domain):\n    seen = set()\n    for x in domain:\n        if f(x) in seen:\n            return False\n        seen.add(f(x))\n    return True\n" },
};

export default {
  spaces_list: () => [
    { id: "school", name: "School", description: "Courses, notes and exam prep for the fall term.", hue: 255, educationEnabled: true, lastUsed: now },
    { id: "work", name: "Work", description: "", hue: 35, educationEnabled: false, lastUsed: now - 86_400_000 },
  ],
  settings_get: () => ({
    backend: hash.get("backend") ?? "phaethon",
    hasAnthropicKey: true,
    model: "claude-sonnet-5-5",
    provider: "anthropic",
    defaultModel: "claude-sonnet-5-5",
    providerReady: true,
    providers: [
      { id: "anthropic", name: "Anthropic", key: "required", local: false, editableBase: false, hasKey: true, baseUrl: "", defaultBaseUrl: "", model: null, keysUrl: "", keyPrefix: "sk-ant-", ready: true },
      { id: "openrouter", name: "OpenRouter", key: "required", local: false, editableBase: false, hasKey: true, baseUrl: "", defaultBaseUrl: "", model: "openai/gpt-5", keysUrl: "", keyPrefix: "sk-or-", ready: true },
      { id: "ollama", name: "Ollama", key: "none", local: true, editableBase: true, hasKey: false, baseUrl: "", defaultBaseUrl: "http://127.0.0.1:11434/v1", model: "llama3.2:3b", keysUrl: "", keyPrefix: "", ready: true },
      { id: "openai", name: "OpenAI", key: "required", local: false, editableBase: false, hasKey: false, baseUrl: "", defaultBaseUrl: "", model: null, keysUrl: "", keyPrefix: "sk-", ready: false },
    ],
    appearance: {},
    vaultPath: "~/Phaethon/default",
    version: "0.2.0",
  }),
  models_list: async (args: Record<string, unknown>) => {
    await sleep(250);
    const p = String(args.provider ?? "anthropic");
    if (p === "anthropic")
      return [
        { id: "claude-opus-5-5", name: "Claude Opus 5.5", sees: "yes" },
        { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", sees: "yes" },
        { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", sees: "yes" },
      ];
    if (p === "openrouter")
      return [
        { id: "openai/gpt-5", name: "GPT-5", sees: "yes" },
        { id: "google/gemini-3-pro", name: "Gemini 3 Pro", sees: "yes" },
        { id: "deepseek/deepseek-r2", name: "DeepSeek R2", sees: "no" },
      ];
    if (p === "ollama") return [{ id: "llama3.2:3b", name: "llama3.2:3b", sees: "no" }, { id: "qwen3:8b", name: "qwen3:8b", sees: "no" }];
    throw "That provider isn’t ready.";
  },
  space_models_list: () => ({}),
  space_model_set: () => null,
  space_tutor_modes_list: () => ({}),
  space_tutor_mode_set: () => null,
  thread_load: (args: Record<string, unknown>) => threads[String(args.space)] ?? [],
  agent_send: (args: Record<string, unknown>) => {
    void run(args);
    return null;
  },
  agent_cancel: (args: Record<string, unknown>) => {
    const t = turns.get(String(args.space));
    if (!t) return false;
    t.cancelled = true;
    t.wake?.();
    return true;
  },
  agent_approve: (args: Record<string, unknown>) => {
    const k = `${args.space}\n${args.id}`;
    const w = waiting.get(k);
    waiting.delete(k);
    w?.(Boolean(args.allow));
    return !!w;
  },
  agent_access_answer: (args: Record<string, unknown>) => {
    const k = `${args.space}\n${args.id}`;
    const w = waiting.get(k);
    waiting.delete(k);
    w?.(args.answer);
    return !!w;
  },
  lesson_answer: (args: Record<string, unknown>) => {
    void lesson(args);
    return true;
  },
  study_chat_plan: async (args: Record<string, unknown>) => {
    await sleep(300);
    const v = JSON.parse(String(args.block));
    return {
      origin: "a1b2c3d4e5f60718",
      kind: v.kind === "quiz" ? "quiz" : "deck",
      title: v.title,
      count: v.count ?? 10,
      kinds: v.kinds ?? ["choice", "truefalse", "short"],
      difficulty: v.difficulty ?? "exam",
      sources: [{ path: C241, name: "CSCI-C 241 Fall 2026" }],
      unknown: [],
      notes: [],
      running: false,
      exam: v.exam,
      scope: v.exam
        ? { exam: "Test 1", state: "known", words: "through HW 6; not graphs or combinatorics", fromUser: false, evidence: [], course: C241, courseName: "CSCI-C 241" }
        : undefined,
    };
  },
  study_chat_make: async (args: Record<string, unknown>) => {
    const ch = args.onEvent as MockChannel;
    const steps: [string, number][] = [["mapping", 1], ["reading", 6], ["making", 10], ["checking", 10], ["saving", 1]];
    for (const [step, total] of steps) {
      for (let d = 0; d <= total; d += Math.max(1, Math.floor(total / 3))) {
        ch.send({ type: "progress", step, done: d, total });
        await sleep(220);
      }
    }
    ch.send({ type: "done", path: "study/quizzes/test-1-practice.json", questions: 10 });
    return null;
  },
  study_chat_cancel: () => true,
  study_citations_check: (args: Record<string, unknown>) =>
    (args.citations as { path: string; quote: string }[]).map((c) =>
      c.path.endsWith("announcements.md")
        ? { found: true, path: c.path, name: "announcements.md", before: "Reminder: ", passage: c.quote, after: " Bring a pencil." }
        : c.path.endsWith(".pdf")
          ? { found: true, path: c.path, name: "Lecture 7 Functions.pdf", at: "p. 3", page: 3, before: "Definition 7.2. ", passage: c.quote, after: " for all a, b in A." }
          : { found: false, path: c.path, name: c.path.split("/").pop(), why: "Those words aren’t in that file." },
    ),
  file_view: async (args: Record<string, unknown>) => {
    await sleep(200);
    const path = String(args.path);
    const f = FILES[path];
    if (!f) throw `${path} isn’t in this space.`;
    const size = f.text?.length ?? (f.kind === "pdf" ? pdfBytes().length : 48_000);
    return { path, name: f.name, kind: f.kind, size, mediaType: f.mediaType, text: f.text ?? null, language: f.language ?? null, tooBig: false };
  },
  file_bytes: async (args: Record<string, unknown>) => {
    const path = String(args.path);
    const f = FILES[path];
    if (f?.kind === "pdf") return pdfBytes();
    if (f?.kind === "docx") return docxBytes();
    if (f?.kind === "image") return pngBytes();
    throw "No bytes for that file.";
  },
  file_open: () => null,
  space_show: () => null,
  space_add: async () => ({ paths: ["files/Lecture slides"], files: 12, skipped: 0 }),
};
