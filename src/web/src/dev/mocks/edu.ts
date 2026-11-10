/**
 * Fake core for the education screens (Study, Grades, Plan, Courses), with
 * payloads shaped like the core's (research F-ui §4, scripts/ui-preview/mock-ipc.js).
 * State lives in memory for the page's life. Scenarios (`#mock&scenario=…`):
 * `empty` (nothing imported, no decks), `nomodel` (short answers can't be
 * graded, making fails with a model error), `signedout` (the site's session
 * ended), `signin-cancelled` (the sign-in window is closed).
 */
import type { MockChannel } from "../mock-core";
import { mockScenario } from "../mock-core";

type Args = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const scenario = mockScenario();
const empty = scenario === "empty";

function spaceOk(args: Args) {
  if (!spaces.some((s) => s.id === args.space)) throw `space "${String(args.space)}" does not exist in this vault`;
}

const spaces = [
  { id: "school", name: "School", description: "Classes this term", hue: 250, educationEnabled: true, lastUsed: Date.now() },
  { id: "work", name: "Work", description: "Lab job", hue: 150, educationEnabled: true, lastUsed: Date.now() - DAY },
];

// ---- Course sites ----

const ALL = ["overview", "syllabus", "assignments", "announcements", "files", "grades"];
const lmsCourseList = [
  { id: "101", name: "Discrete Structures for Computer Science", code: "CSCI-C 241", term: "Fall 2026", current: true },
  { id: "102", name: "Calculus II", code: "MATH-M 212", term: "Fall 2026", current: true },
  { id: "103", name: "Introduction to Psychology", code: "PSY-P 101", term: "Fall 2026", current: true },
  { id: "104", name: "Elementary Spanish I", code: "SPAN-S 100", term: "Fall 2026", current: true },
  { id: "90", name: "Introduction to Programming", code: "CSCI-C 200", term: "Spring 2026", current: false },
  { id: "91", name: "Writing and Research", code: "ENG-W 131", term: "Spring 2026", current: false },
];
const schools = [
  { name: "Indiana University Bloomington", address: "https://iu.instructure.com" },
  { name: "Indiana University Indianapolis", address: "https://iu.instructure.com" },
  { name: "Indiana State University", address: "https://indstate.instructure.com" },
  { name: "Ivy Tech Community College", address: "https://ivytech.instructure.com" },
];
const connections: { id: string; kind: string; address: string; schoolName?: string; signedIn: boolean; lastSync?: number; courses: string[] }[] = empty
  ? []
  : [
      {
        id: "c1",
        kind: "canvas",
        address: "https://iu.instructure.com",
        schoolName: "Indiana University Bloomington",
        signedIn: scenario !== "signedout",
        lastSync: Date.now() - 3 * DAY,
        courses: ["101", "102", "103"],
      },
    ];
const access: Record<string, Record<string, string[]>> = empty
  ? {}
  : {
      school: { "c1/101": [...ALL], "c1/102": [...ALL], "c1/103": ["overview", "syllabus", "assignments", "announcements", "files"] },
      work: {},
    };
const material = {
  "101": {
    documents: 14,
    typedDocuments: 12,
    handwritingPages: 6,
    unreadablePages: 1,
    pictures: 3,
    readability: "fair",
    lines: ["12 of 14 documents are typed.", "6 pages of handwriting were read by text recognition; 1 page couldn’t be read."],
    flagged: [
      { path: "files/Lecture notes/Week 3 board.pdf", handwriting: 4, unreadable: 1, pictures: 1 },
      { path: "files/Homework/HW 2 solutions.pdf", handwriting: 2, unreadable: 0, pictures: 2 },
    ],
  },
} as Record<string, unknown>;

function courseInfos() {
  return connections
    .flatMap((c) =>
      c.courses.map((id) => {
        const x = lmsCourseList.find((k) => k.id === id) ?? { name: id, code: undefined, term: undefined };
        return {
          key: `${c.id}/${id}`,
          connection: c.id,
          courseId: id,
          name: x.name,
          ...(x.code ? { code: x.code } : {}),
          ...(x.term ? { term: x.term } : {}),
          folder: `courses/${x.name}`,
          ...(material[id] ? { material: material[id] } : {}),
        };
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

const contentEntries = (name: string) => [
  { path: `courses/${name}/overview.md`, title: "Overview", kind: "overview" },
  { path: `courses/${name}/syllabus.md`, title: "Syllabus", kind: "page" },
  { path: `courses/${name}/modules.md`, title: "Week 1: Propositional logic", kind: "module", anchor: "week-1", headingIndex: 1 },
  { path: `courses/${name}/modules.md`, title: "Week 2: Sets and set operations", kind: "module", anchor: "week-2", headingIndex: 2 },
  { path: `courses/${name}/modules.md`, title: "Week 3: Functions", kind: "module", anchor: "week-3", headingIndex: 3 },
  { path: `courses/${name}/assignments.md`, title: "Homework 5: Functions and relations", kind: "assignment", anchor: "homework-5" },
  { path: `courses/${name}/assignments.md`, title: "Homework 6: Induction", kind: "assignment", anchor: "homework-6" },
  { path: `courses/${name}/files/syllabus.pdf`, title: "syllabus.pdf", kind: "file", bytes: 2048 * 61 },
  { path: `courses/${name}/files/Lecture notes/Week 3 board.pdf`, title: "Week 3 board.pdf", kind: "file", bytes: 1024 * 1024 * 3.2 },
  { path: `courses/${name}/files/Rosen chapter 2.pdf`, title: "Rosen chapter 2.pdf", kind: "file", bytes: 1024 * 1024 * 8.4 },
  { path: `courses/${name}/files/Test 1 review.docx`, title: "Test 1 review.docx", kind: "file", bytes: 1024 * 44 },
  { path: `courses/${name}/pages/office-hours.md`, title: "Office hours", kind: "page" },
];

// ---- Study ----

type MockCard = { front: string; back: string; source?: string; quote?: string; picture?: number; confidence?: number; due?: number };
const C241 = "courses/Discrete Structures for Computer Science";
const CALC = "courses/Calculus II";
const now0 = Date.now();
const decks: Record<string, { title: string; course?: string; sources: string[]; cards: MockCard[] }> = empty
  ? {}
  : {
      "study/decks/Sets and functions.md": {
        title: "Sets and functions",
        course: "Discrete Structures for Computer Science",
        sources: [`${C241}/files/Rosen chapter 2.pdf`, `${C241}/syllabus.md`],
        cards: [
          { front: "What is the power set $\\mathcal{P}(S)$ of a set $S$?", back: "The set of all subsets of $S$, including $\\emptyset$ and $S$ itself.", source: `${C241}/files/Rosen chapter 2.pdf`, quote: "Given a set S, the power set of S is the set of all subsets of the set S.", confidence: 4, due: now0 - DAY },
          { front: "A function is {{injective}} when $f(a) = f(b)$ implies $a = b$.", back: "", source: `${C241}/files/Rosen chapter 2.pdf`, quote: "A function f is said to be one-to-one, or an injunction, if and only if f(a) = f(b) implies that a = b", confidence: 2, due: now0 - 3600_000 },
          { front: "How many elements does $\\mathcal{P}(S)$ have when $|S| = n$?", back: "$2^n$", source: `${C241}/files/Rosen chapter 2.pdf`, quote: "the power set of a set with n elements has 2^n elements" },
          { front: "What makes a function a bijection?", back: "It is both one-to-one (injective) and onto (surjective).", source: `${C241}/files/Lecture notes/Week 3 board.pdf`, quote: "bijection = 1-1 and onto", picture: 2 },
          { front: "State De Morgan’s law for sets.", back: "$\\overline{A \\cup B} = \\overline{A} \\cap \\overline{B}$ and $\\overline{A \\cap B} = \\overline{A} \\cup \\overline{B}$", confidence: 5, due: now0 + 5 * DAY },
          { front: "What is the Cartesian product $A \\times B$?", back: "The set of ordered pairs $(a, b)$ with $a \\in A$ and $b \\in B$." },
        ],
      },
      "study/decks/Logic and proofs.md": {
        title: "Logic and proofs",
        course: "Discrete Structures for Computer Science",
        sources: [`${C241}/modules.md`],
        cards: [
          { front: "What is the contrapositive of $p \\to q$?", back: "$\\neg q \\to \\neg p$, which is logically equivalent to $p \\to q$.", source: `${C241}/modules.md`, quote: "The contrapositive of p → q is ¬q → ¬p", confidence: 3, due: now0 - 2 * 3600_000 },
          { front: "When is $p \\to q$ false?", back: "Only when $p$ is true and $q$ is false.", confidence: 5, due: now0 + 7 * DAY },
          { front: "What does a proof by contradiction assume?", back: "That the statement is false, then derives a contradiction.", confidence: 4, due: now0 + 2 * DAY },
        ],
      },
      "study/decks/Integration techniques.md": {
        title: "Integration techniques",
        course: "Calculus II",
        sources: [`${CALC}/files/Section 7.1.pdf`],
        cards: [
          { front: "Integration by parts formula", back: "$\\int u\\,dv = uv - \\int v\\,du$", source: `${CALC}/files/Section 7.1.pdf`, quote: "∫u dv = uv − ∫v du", confidence: 1, due: now0 - DAY },
          { front: "Which substitution suits $\\sqrt{a^2 - x^2}$?", back: "$x = a \\sin\\theta$" },
          { front: "What does LIATE help you choose?", back: "Which factor to take as $u$ in integration by parts: logarithmic, inverse trig, algebraic, trig, exponential.", confidence: 4, due: now0 + 3 * DAY },
        ],
      },
      "study/decks/Vocabulary.md": {
        title: "Vocabulary",
        sources: [],
        cards: [
          { front: "Heuristic", back: "A rule of thumb that usually works but isn’t guaranteed.", confidence: 3, due: now0 - DAY },
          { front: "Corollary", back: "A result that follows directly from a theorem." },
        ],
      },
    };

type MockQuestion = {
  id: string;
  kind: string;
  prompt: string;
  choices?: string[];
  answer: string | string[];
  explanation: string;
  source?: string;
  topic?: string;
  citations?: { source: string; quote: string; at?: string; picture?: number }[];
};
const test1: MockQuestion[] = [
  {
    id: "q1",
    kind: "choice",
    prompt: "Which of these is the power set of $\\{a, b\\}$?",
    choices: ["$\\{a, b\\}$", "$\\{\\emptyset, \\{a\\}, \\{b\\}, \\{a, b\\}\\}$", "$\\{\\{a\\}, \\{b\\}\\}$", "$\\{\\emptyset, a, b\\}$"],
    answer: "$\\{\\emptyset, \\{a\\}, \\{b\\}, \\{a, b\\}\\}$",
    explanation: "The power set holds every subset, including the empty set and the set itself.",
    source: `${C241}/files/Rosen chapter 2.pdf`,
    topic: "Power sets",
    citations: [{ source: `${C241}/files/Rosen chapter 2.pdf`, quote: "Given a set S, the power set of S is the set of all subsets of the set S.", at: "§2.1" }],
  },
  {
    id: "q2",
    kind: "truefalse",
    prompt: "If $f(a) = f(b)$ implies $a = b$, then $f$ is onto.",
    choices: ["true", "false"],
    answer: "false",
    explanation: "That property is one-to-one (injective). Onto means every element of the codomain is hit.",
    source: `${C241}/files/Rosen chapter 2.pdf`,
    topic: "Functions",
    citations: [{ source: `${C241}/files/Rosen chapter 2.pdf`, quote: "A function f is said to be one-to-one, or an injunction, if and only if f(a) = f(b) implies that a = b", at: "§2.3" }],
  },
  {
    id: "q3",
    kind: "multi",
    prompt: "Which of these statements are logically equivalent to $p \\to q$? Choose all that apply.",
    choices: ["$\\neg q \\to \\neg p$", "$q \\to p$", "$\\neg p \\lor q$", "$\\neg p \\to \\neg q$"],
    answer: ["$\\neg q \\to \\neg p$", "$\\neg p \\lor q$"],
    explanation: "The contrapositive and $\\neg p \\lor q$ are equivalent; the converse and the inverse are not.",
    source: `${C241}/modules.md`,
    topic: "Conditionals",
    citations: [{ source: `${C241}/modules.md`, quote: "The contrapositive of p → q is ¬q → ¬p", at: "#2" }],
  },
  {
    id: "q4",
    kind: "cloze",
    prompt: "A function that is both one-to-one and onto is called a {{ }}.",
    answer: "bijection",
    explanation: "One-to-one plus onto is a bijection (one-to-one correspondence).",
    source: `${C241}/files/Lecture notes/Week 3 board.pdf`,
    topic: "Functions",
    citations: [{ source: `${C241}/files/Lecture notes/Week 3 board.pdf`, quote: "bijection = 1-1 and onto", at: "p. 2", picture: 2 }],
  },
  {
    id: "q5",
    kind: "short",
    prompt: "Explain why $|\\mathcal{P}(S)| = 2^n$ when $|S| = n$.",
    answer: "Each of the n elements is either in a subset or not, so there are 2 choices per element and 2^n subsets.",
    explanation: "Building a subset is n independent yes/no choices.",
    source: `${C241}/files/Rosen chapter 2.pdf`,
    topic: "Power sets",
    citations: [{ source: `${C241}/files/Rosen chapter 2.pdf`, quote: "the power set of a set with n elements has 2^n elements", at: "§2.1" }],
  },
];
const grounding = {
  exam: "Test 1",
  scope: "through HW 6; not graphs or combinatorics",
  fromUser: false,
  evidence: [{ source: `${C241}/announcements.md`, quote: "Test 1 covers everything through Homework 6. It will not cover graphs or combinatorics." }],
  asked: 7,
  kept: 5,
  dropped: [
    { text: "How many edges does $K_5$ have?", why: "Graphs aren’t on Test 1." },
    { text: "Which rule gives $\\binom{n}{k}$?", why: "The quote isn’t in Rosen chapter 2.pdf." },
  ],
  coverage: [
    { topic: "Power sets", sections: "§2.1", count: 2 },
    { topic: "Functions", sections: "§2.3", count: 2 },
    { topic: "Conditionals", sections: "§1.1", count: 1 },
    { topic: "Relations", sections: "§9.1", count: 0, why: "no passage teaches it yet" },
  ],
};
const quizzes: Record<string, { title: string; course?: string; sources: string[]; created: number; questions: MockQuestion[]; grounding?: typeof grounding; lastScore?: number; lastTaken?: number }> = empty
  ? {}
  : {
      "study/quizzes/Test 1 practice.json": {
        title: "Test 1 practice",
        course: "Discrete Structures for Computer Science",
        sources: [C241],
        created: now0 - 2 * DAY,
        questions: test1,
        grounding,
        lastScore: 0.6,
        lastTaken: now0 - DAY,
      },
      "study/quizzes/Series and sequences.json": {
        title: "Series and sequences",
        course: "Calculus II",
        sources: [CALC],
        created: now0 - 5 * DAY,
        questions: [
          { id: "s1", kind: "choice", prompt: "Does $\\sum_{n=1}^{\\infty} \\frac{1}{n^2}$ converge?", choices: ["Yes, it is a p-series with p = 2 > 1", "No, the terms go to 0 too slowly", "Only conditionally"], answer: "Yes, it is a p-series with p = 2 > 1", explanation: "A p-series converges when p > 1.", source: `${CALC}/files/Section 11.3.pdf` },
          { id: "s2", kind: "truefalse", prompt: "If $a_n \\to 0$ then $\\sum a_n$ converges.", choices: ["true", "false"], answer: "false", explanation: "The harmonic series is the counterexample." },
        ],
      },
    };
const progress: Record<string, { confidence: number; due: number }> = {};
const hash = (s: string) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(36);
const cardsOf = (path: string) =>
  (decks[path]?.cards ?? []).map((c) => {
    const id = hash(`${path}\n${c.front}`);
    const p = progress[id] ?? (c.confidence ? { confidence: c.confidence, due: c.due ?? 0 } : null);
    return {
      id,
      kind: /\{\{.+?\}\}/.test(c.front) ? "cloze" : "basic",
      front: c.front,
      back: c.back,
      ...(c.source ? { source: c.source } : {}),
      ...(c.quote ? { quote: c.quote } : {}),
      ...(c.picture ? { picture: c.picture } : {}),
      ...(p ? { confidence: p.confidence, due: p.due } : {}),
    };
  });

const scopeViews: Record<string, unknown> = {
  [C241]: {
    course: C241,
    name: "Discrete Structures for Computer Science",
    state: "fresh",
    map: {
      course: C241,
      name: "Discrete Structures for Computer Science",
      built: now0 - 4 * DAY,
      topics: [
        { id: "t1", title: "Propositional logic", sections: "§1.1–1.3", terms: [], weight: 2, homework: ["HW 1"], evidence: [] },
        { id: "t2", title: "Sets and set operations", sections: "§2.1–2.2", terms: [], weight: 2, homework: ["HW 3"], evidence: [] },
        { id: "t3", title: "Functions", sections: "§2.3", terms: [], weight: 2, homework: ["HW 5"], evidence: [] },
        { id: "t4", title: "Induction", sections: "§5.1", terms: [], weight: 1, homework: ["HW 6"], evidence: [] },
        { id: "t5", title: "Graphs", sections: "§10.1", terms: [], weight: 1, homework: [], evidence: [] },
        { id: "t6", title: "Combinatorics", sections: "§6.1", terms: [], weight: 1, homework: [], evidence: [] },
      ],
      notation: [],
      exams: [
        {
          title: "Test 1",
          date: new Date(now0 + 4 * DAY).toISOString().slice(0, 10),
          known: true,
          summary: "through HW 6",
          includes: ["t1", "t2", "t3", "t4"],
          excludes: ["t5", "t6"],
          excludedWords: ["graphs", "combinatorics"],
          homework: ["HW 1", "HW 6"],
          evidence: [{ source: `${C241}/announcements.md`, quote: "Test 1 covers everything through Homework 6. It will not cover graphs or combinatorics." }],
          fromUser: false,
        },
        { title: "Test 2", date: new Date(now0 + 38 * DAY).toISOString().slice(0, 10), known: false, summary: "", includes: [], excludes: [], excludedWords: [], homework: [], evidence: [], fromUser: false },
      ],
      dropped: 1,
    },
    stated: [] as { exam: string; text: string; at: number }[],
    material: {
      lines: [],
      pages: 120,
      sight: { sees: "yes", model: "claude-sonnet", shown: true },
      exams: [{ title: "Test 1", pages: 40 }],
      alert: { kind: "notShown", text: "6 handwritten pages were read by text recognition, so a few words may be wrong." },
    },
  },
};

function streamTo(ch: unknown) {
  return (ch as MockChannel).send;
}

// ---- Grades ----

function gradeData() {
  const at = (d: number) => new Date(Date.now() + d * DAY).toISOString();
  const item = (title: string, group: string, score: number | undefined, possible: number, extra: Record<string, unknown> = {}) => ({
    title,
    group,
    score,
    possible,
    percent: score != null && possible ? Math.round((score / possible) * 10000) / 100 : undefined,
    submitted: score != null,
    graded: score != null,
    late: false,
    missing: false,
    excused: false,
    comments: [] as string[],
    ...extra,
  });
  return [
    {
      connection: "c1",
      courseId: "102",
      course: "Calculus II",
      folder: "courses/Calculus II",
      updated: Date.now() - 2 * 3600_000,
      current: { percent: 78.6, letter: "C+" },
      groups: [
        { name: "Homework", weight: 30 },
        { name: "Quizzes", weight: 20 },
        { name: "Exams", weight: 50 },
      ],
      items: [
        item("Homework 1", "Homework", 18, 20, { due: at(-30) }),
        item("Homework 2", "Homework", 0, 20, { due: at(-16), missing: true, submitted: false }),
        item("Quiz 1", "Quizzes", 8, 10, { due: at(-12) }),
        item("Midterm 1", "Exams", 81, 100, { due: at(-6), comments: ["Review integration by parts before the next exam."] }),
        item("Homework 3", "Homework", undefined, 20, { due: at(3) }),
        item("Final exam", "Exams", undefined, 100, { due: at(40) }),
      ],
    },
    {
      connection: "c1",
      courseId: "101",
      course: "Discrete Structures for Computer Science",
      folder: C241,
      updated: Date.now() - 2 * 3600_000,
      current: { percent: 91.25, letter: "A-", points: 146, possible: 160 },
      final: { percent: 42.1, letter: "F" },
      groups: [{ name: "Problem sets" }, { name: "Labs" }],
      items: [
        item("Problem set 1", "Problem sets", 47, 50, { due: at(-28), comments: ["Clean proofs.", "Watch the base case in 3b."] }),
        item("Problem set 2", "Problem sets", 41, 50, { due: at(-14), late: true }),
        item("Lab 1", "Labs", 30, 30, { due: at(-21) }),
        item("Lab 2", "Labs", 28, 30, { due: at(-7) }),
        item("Participation", "Labs", undefined, 0, { graded: true, grade: "complete", submitted: true }),
        item("Problem set 3", "Problem sets", undefined, 50, { due: at(-1), submitted: true }),
        item("Lab 3", "Labs", undefined, 30, { due: at(-2), excused: true, graded: true }),
      ],
    },
    {
      connection: "c1",
      courseId: "103",
      course: "Introduction to Psychology",
      folder: "courses/Introduction to Psychology",
      updated: Date.now() - 2 * 3600_000,
      current: {},
      groups: [],
      items: [],
      note: "Your course site doesn’t show you grades for this course.",
    },
  ];
}
let grades: ReturnType<typeof gradeData> | null = null;

// ---- Plan ----

function at2359(days: number) {
  const d = new Date(Date.now() + days * DAY);
  d.setHours(23, 59, 0, 0);
  return d.getTime();
}
const localDate = (days: number) => {
  const d = new Date(Date.now() + days * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
let exams: { id: string; course?: string; title: string; date: string }[] = empty
  ? []
  : [
      { id: "e1", course: "Discrete Structures for Computer Science", title: "Test 1", date: localDate(4) },
      { id: "e2", course: "Calculus II", title: "Midterm 2", date: localDate(12) },
    ];
let planState = { studyDays: [0, 1, 2, 3, 4, 5], sessionsPerDay: 3, sessionMinutes: 25, done: [] as string[] };

// ---- Handlers ----

export default {
  spaces_list: () => spaces,

  // Course sites
  lms_schools: async (args: Args) => {
    await sleep(200);
    if (args.kind !== "canvas") return [];
    const q = String(args.query ?? "").trim().toLowerCase();
    if (q.length < 2) return [];
    return schools.filter((s) => s.name.toLowerCase().includes(q) || s.address.includes(q));
  },
  lms_connections: () => connections.map((c) => ({ ...c, courses: [...c.courses] })),
  lms_connect: async (args: Args) => {
    await sleep(1800);
    if (scenario === "signin-cancelled") throw "cancelled";
    const address = String(args.address).replace(/\/+$/, "");
    let c = connections.find((x) => x.kind === args.kind && x.address === address);
    if (!c) {
      c = { id: `c${connections.length + 1}`, kind: String(args.kind), address, signedIn: true, courses: [], ...(args.schoolName ? { schoolName: String(args.schoolName) } : {}) };
      connections.push(c);
    }
    c.signedIn = true;
    return { ...c, courses: [...c.courses] };
  },
  lms_courses: async (args: Args) => {
    await sleep(400);
    const c = connections.find((x) => x.id === args.connection);
    if (!c) throw "That course site isn’t connected.";
    if (!c.signedIn) throw "You’ve been signed out of your course site. Sign in again to continue.";
    return lmsCourseList.map((x) => ({ ...x, imported: c.courses.includes(x.id), ...(x.id === "104" && c.courses.length ? { partial: true } : {}) }));
  },
  lms_import: async (args: Args) => {
    const send = streamTo(args.onEvent);
    const c = connections.find((x) => x.id === args.connection);
    if (!c) throw "That course site isn’t connected.";
    const ids = args.courseIds as string[];
    let cancelled = false;
    importCancel = () => (cancelled = true);
    const late: (() => void)[] = [];
    for (const id of ids) {
      const name = lmsCourseList.find((x) => x.id === id)?.name ?? id;
      const steps: [string, number, number][] = [["reading", 0, 1], ["reading", 1, 1], ["files", 0, 12], ["files", 5, 12], ["files", 12, 12], ["readings", 0, 2], ["readings", 2, 2], ["writing", 0, 1]];
      for (const [step, done, total] of steps) {
        await sleep(350);
        if (cancelled) break;
        send({ type: "progress", course: id, step, done, total });
      }
      if (cancelled) break;
      if (id === "91") {
        send({ type: "error", message: `${name}: the site said you don’t have access to its files.` });
        continue;
      }
      const first = !c.courses.includes(id);
      if (first) {
        c.courses.push(id);
        for (const s of args.spaces as string[]) (access[s] ??= {})[`${c.id}/${id}`] = [...ALL];
      }
      const event = { type: "course", course: id, folder: `courses/${name}`, files: 12 + (Number(id) % 7), readings: Number(id) % 4, links: 5, skipped: id === "103" ? ["Announcements: the site didn’t answer."] : [], ...(material[id] ? { material: material[id] } : {}) };
      // The last course's event is big; it lands after the command has returned, as Tauri did with 8 KB+ messages.
      if (id === ids[ids.length - 1]) late.push(() => send(event));
      else send(event);
    }
    importCancel = null;
    setTimeout(() => {
      for (const f of late) f();
      send(cancelled ? { type: "cancelled" } : { type: "done" });
    }, 120);
  },
  lms_import_cancel: () => {
    if (!importCancel) return false;
    importCancel();
    return true;
  },
  lms_disconnect: (args: Args) => {
    const c = connections.find((x) => x.id === args.connection);
    if (c) c.signedIn = false;
  },
  course_access_get: (args: Args) => {
    if (args.space != null) spaceOk(args);
    const courses = courseInfos();
    const keys = new Set(courses.map((c) => c.key));
    const out: Record<string, Record<string, string[]>> = {};
    for (const [s, m] of Object.entries(access)) {
      if (args.space != null && s !== args.space) continue;
      out[s] = Object.fromEntries(Object.entries(m).filter(([k, p]) => keys.has(k) && p.length));
    }
    return { spaces: spaces.map((s) => s.id).sort(), courses, access: out, problems: [] };
  },
  course_access_set: async (args: Args) => {
    spaceOk(args);
    await sleep(120);
    const parts = ALL.filter((p) => (args.parts as string[]).includes(p));
    if (parts.length) (access[String(args.space)] ??= {})[String(args.course)] = parts;
    else delete access[String(args.space)]?.[String(args.course)];
  },
  lms_course_content: async (args: Args) => {
    spaceOk(args);
    await sleep(250);
    const c = courseInfos().find((x) => x.key === args.course);
    const parts = access[String(args.space)]?.[String(args.course)] ?? [];
    if (!c || !parts.length) throw "This space cannot access that course.";
    const allowed = (kind: string) => (kind === "file" ? parts.includes("files") : kind === "assignment" ? parts.includes("assignments") : parts.includes("overview"));
    return { entries: contentEntries(c.name).filter((e) => allowed(e.kind)), updated: Date.now() - 3 * DAY, truncated: false };
  },

  // Grades
  lms_grades: async (args: Args) => {
    spaceOk(args);
    await sleep(200);
    if (empty || args.space !== "school") return [];
    grades ??= gradeData();
    return structuredClone(grades);
  },
  lms_grades_refresh: async (args: Args) => {
    spaceOk(args);
    const send = streamTo(args.onEvent);
    grades ??= gradeData();
    const mine = grades.filter((g) => g.connection === args.connection);
    for (let n = 0; n < mine.length; n++) {
      await sleep(500);
      send({ type: "progress", course: mine[n]!.courseId, step: "grades", done: n, total: mine.length });
      if (scenario === "signedout") {
        send({ type: "error", message: "signedOut" });
        break;
      }
      const g = mine[n]!;
      g.updated = Date.now();
      const hw3 = g.items.find((i) => i.title === "Homework 3" && !i.graded);
      if (hw3) Object.assign(hw3, { score: 17, percent: 85, graded: true, submitted: true });
      send({ type: "course", course: g.courseId, grades: structuredClone(g) });
    }
    send({ type: "done" });
  },

  // Study
  study_sources: (args: Args) => {
    spaceOk(args);
    return courseInfos()
      .filter((c) => (access[String(args.space)]?.[c.key]?.length ?? 0) > 0)
      .map((c) => ({ name: c.name, folder: c.folder, syllabus: true, assignments: true, files: true, readings: c.courseId !== "103" }));
  },
  study_overview: async (args: Args) => {
    spaceOk(args);
    await sleep(150);
    const now = Date.now();
    const out = Object.entries(decks).map(([path, d]) => {
      const cards = cardsOf(path);
      const rated = cards.filter((c) => c.confidence != null);
      return {
        path,
        title: d.title,
        course: d.course,
        cards: cards.length,
        due: rated.filter((c) => (c.due ?? 0) <= now).length,
        new: cards.length - rated.length,
        mastery: cards.length ? rated.filter((c) => (c.confidence ?? 0) >= 4).length / cards.length : 0,
        updated: now,
      };
    });
    return {
      decks: out,
      quizzes: Object.entries(quizzes).map(([path, q]) => ({ path, title: q.title, course: q.course, questions: q.questions.length, lastScore: q.lastScore, lastTaken: q.lastTaken })),
      due: out.reduce((n, d) => n + d.due, 0),
      streakDays: empty ? 0 : 4,
    };
  },
  study_deck: (args: Args) => {
    const d = decks[String(args.path)];
    if (!d) throw "That deck isn’t in this space any more.";
    return { path: args.path, title: d.title, course: d.course, sources: d.sources, cards: cardsOf(String(args.path)) };
  },
  study_deck_save: (args: Args) => {
    const title = String(args.title ?? "").trim();
    if (!title) throw "A deck needs a name.";
    const cards = args.cards as { front: string; back: string; source?: string }[];
    for (const c of cards) if (!c.front.trim() || (!c.back.trim() && !/\{\{.+?\}\}/.test(c.front))) throw "Every card needs a front and a back.";
    const path = String(args.path || `study/decks/${title}.md`);
    const d = (decks[path] ??= { title, sources: [], cards: [] });
    const old = d.cards;
    d.title = title;
    // As the core: a card with the same front keeps its progress and passage; a new front keeps only the source sent.
    d.cards = cards.map((c) => {
      const o = old.find((x) => x.front.trim() === c.front.trim());
      const source = c.source?.trim() ? c.source : o?.source;
      const same = source === o?.source;
      return { ...(o && { confidence: o.confidence, due: o.due }), front: c.front.trim(), back: c.back.trim(), source, ...(same && o ? { quote: o.quote, picture: o.picture } : {}) };
    });
    return path;
  },
  study_session: async (args: Args) => {
    await sleep(200);
    const paths = (args.paths as string[] | null) ?? Object.keys(decks);
    const now = Date.now();
    const cards = paths.flatMap((p) => cardsOf(p).map((c) => ({ ...c, deck: p })));
    const due = cards.filter((c) => c.confidence != null && (c.due ?? 0) <= now);
    const fresh = cards.filter((c) => c.confidence == null);
    const later = args.paths ? cards.filter((c) => c.confidence != null && (c.due ?? 0) > now) : [];
    return [...due, ...fresh, ...later].slice(0, Number(args.limit ?? 20));
  },
  study_rate: (args: Args) => {
    const conf = Number(args.confidence);
    if (!(conf >= 1 && conf <= 5)) throw "A rating is from 1 to 5.";
    const days = [0, 0, 1, 3, 7][conf - 1]!;
    const due = Date.now() + (days ? days * DAY : 600_000);
    progress[String(args.card)] = { confidence: conf, due };
    return { due, again: conf <= 2 };
  },
  study_quiz: async (args: Args) => {
    await sleep(150);
    const q = quizzes[String(args.path)];
    if (!q) throw "That quiz isn’t in this space any more.";
    const { lastScore: _a, lastTaken: _b, ...quiz } = q;
    return quiz;
  },
  study_quiz_submit: async (args: Args) => {
    const send = streamTo(args.onEvent);
    const q = quizzes[String(args.path)];
    if (!q) throw "That quiz isn’t in this space any more.";
    const answers = args.answers as Record<string, string | string[]>;
    const norm = (s: string) => s.trim().toLowerCase();
    const results = q.questions.map((qq) => {
      const given = answers[qq.id] ?? "";
      const blank = Array.isArray(given) ? !given.length : !given.trim();
      const base = { id: qq.id, given, expected: qq.answer };
      const from = qq.source ? ` (From ${qq.source.split("/").pop()}.)` : "";
      if (blank) return { ...base, correct: false, feedback: `No answer given. The answer is ${[qq.answer].flat().join(", ")}.` };
      if (qq.kind === "multi") {
        const want = (qq.answer as string[]).map(norm);
        const picked = (given as string[]).map(norm);
        const hits = picked.filter((p) => want.includes(p)).length;
        const wrong = picked.length - hits;
        if (hits === want.length && !wrong) return { ...base, correct: true, feedback: `Right: you picked every one. ${qq.explanation}${from}` };
        const credit = Math.max(0, (hits - wrong) / want.length);
        return { ...base, correct: false, ...(credit > 0 ? { partial: credit } : {}), feedback: `Partly: you missed ${want.length - hits}. ${qq.explanation}${from}` };
      }
      if (qq.kind === "short") {
        if (scenario === "nomodel")
          return { ...base, correct: false, ungraded: true, feedback: `This one couldn’t be graded: no model is set up. Add an API key in Settings. Compare yours with a good answer: ${qq.answer}${from}` };
        return { ...base, correct: false, partial: 0.5, feedback: `Half right: you named the two choices per element but didn’t say why that gives $2^n$.${from}` };
      }
      const ok = norm(String(given)) === norm(String(qq.answer));
      return { ...base, correct: ok, feedback: ok ? `Right. ${qq.explanation}${from}` : `Not quite: the answer is ${qq.answer}. ${qq.explanation}${from}` };
    });
    for (let i = 0; i <= 2; i++) {
      await sleep(300);
      send({ type: "progress", step: "grading", done: i, total: 2 });
    }
    const graded = results.filter((r) => !("ungraded" in r && r.ungraded));
    const score = graded.length ? graded.reduce((n, r) => n + (r.correct ? 1 : ("partial" in r ? (r.partial ?? 0) : 0)), 0) / graded.length : 0;
    q.lastScore = score;
    q.lastTaken = Date.now();
    const attempt = { path: `.phaethon/study/attempts/${q.title}-${Date.now()}.json`, quiz: args.path, taken: Date.now(), score, results };
    // Big: lands after the command returns.
    setTimeout(() => send({ type: "done", attempt }), 60);
  },
  study_review_mistakes: async (args: Args) => {
    const send = streamTo(args.onEvent);
    send({ type: "progress", step: "reviewing", done: 0, total: 1 });
    await sleep(900);
    send({ type: "progress", step: "reviewing", done: 1, total: 1 });
    send({
      type: "done",
      summary:
        "## Functions\n\n- Onto and one-to-one are different properties: re-read §2.3 and try two examples of each.\n\n## Conditionals\n\n- The converse $q \\to p$ is **not** equivalent to $p \\to q$. Write out a truth table once.",
      deckPath: "study/decks/Vocabulary.md",
    });
  },
  study_delete: (args: Args) => {
    delete decks[String(args.path)];
    delete quizzes[String(args.path)];
  },
  study_scope: async (args: Args) => {
    await sleep(200);
    const v = scopeViews[String(args.course)] as { stated: unknown[] } | undefined;
    if (!v) return { course: args.course, name: String(args.course).replace(/^courses\//, ""), state: "none", stated: [] };
    return v;
  },
  study_scope_state: (args: Args) => {
    const v = scopeViews[String(args.course)] as { stated: { exam: string; text: string; at: number }[] } | undefined;
    if (!v) return;
    v.stated = v.stated.filter((s) => s.exam !== args.exam);
    if (String(args.text).trim()) v.stated.push({ exam: String(args.exam), text: String(args.text), at: Date.now() });
  },
  study_make_deck: (args: Args) => make(args, false),
  study_make_quiz: (args: Args) => make(args, true),
  study_citations_check: (args: Args) =>
    (args.citations as { path: string; quote: string }[]).map((c) => ({ found: true, path: c.path, name: c.path.split("/").pop(), passage: c.quote, before: "… ", after: " …" })),

  // Plan
  plan_upcoming: (args: Args) => {
    spaceOk(args);
    if (empty) return { courses: [], items: [] };
    return {
      courses: [
        { name: "Calculus II", folder: "Calculus II" },
        { name: "Discrete Structures for Computer Science", folder: "Discrete Structures for Computer Science" },
        { name: "Introduction to Psychology", folder: "Introduction to Psychology" },
      ],
      items: [
        { course: "Discrete Structures for Computer Science", folder: "Discrete Structures for Computer Science", title: "Homework 6: Induction", due: at2359(2), link: `${C241}/assignments.md#homework-6` },
        { course: "Calculus II", folder: "Calculus II", title: "Homework 3", due: at2359(3), link: "courses/Calculus II/assignments.md#homework-3" },
        { course: "Introduction to Psychology", folder: "Introduction to Psychology", title: "Reading: Chapter 4, Memory", due: at2359(0), link: "courses/Introduction to Psychology/assignments.md#reading-chapter-4" },
        { course: "Introduction to Psychology", folder: "Introduction to Psychology", title: "Reflection paper 2", due: at2359(9), link: "courses/Introduction to Psychology/assignments.md#reflection-paper-2" },
        { course: "Calculus II", folder: "Calculus II", title: "Quiz 3 (online)", due: at2359(6), link: "courses/Calculus II/assignments.md#quiz-3" },
      ],
    };
  },
  plan_exams_get: (args: Args) => {
    spaceOk(args);
    return exams;
  },
  plan_exams_set: (args: Args) => {
    const list = (args.exams as { id: string; course?: string; title: string; date: string }[]).map((e) => ({ ...e, title: e.title.replace(/\s+/g, " ").trim(), ...(e.course?.trim() ? {} : { course: undefined }) }));
    for (const e of list) if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw "An exam needs a date like 2026-10-15.";
    exams = list.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
    return exams;
  },
  plan_state_get: () => planState,
  plan_state_set: (args: Args) => {
    const s = args.planState as typeof planState;
    if (!s.studyDays.length) throw "Choose at least one day to study on.";
    planState = { ...s, studyDays: [...new Set(s.studyDays)].sort() };
    return planState;
  },
  plan_save: async () => {
    await sleep(200);
    return "study/plan.md";
  },
  file_open: () => undefined,
};

let importCancel: (() => void) | null = null;

async function make(args: Args, quiz: boolean) {
  const send = streamTo(args.onEvent);
  const sources = args.sources as string[];
  const options = args.options as { count: number; title?: string; focus?: string; exam?: string; fromAttempt?: string };
  if (!sources.length && !options.fromAttempt) throw "Choose what to make them from.";
  const steps: [string, number, number, number?, number?][] = [
    ["reading", 0, 1],
    ["reading", 1, 1],
    ["making", 0, 3],
    ["checking", 0, options.count, 0, 0],
    ["checking", Math.round(options.count / 2), options.count, Math.round(options.count / 2) - 1, 1],
    ["making", 1, 3],
    ["checking", options.count, options.count, options.count, 2],
    ["saving", 0, 1],
  ];
  for (const [step, done, total, kept, dropped] of steps) {
    await sleep(500);
    send({ type: "progress", step, done, total, ...(kept != null ? { kept, dropped } : {}) });
    if (scenario === "nomodel" && step === "making") {
      send({ type: "error", message: "No model is set up for this space. Add an API key in Settings, or sign in to Claude Code." });
      return;
    }
  }
  const title = options.title || (options.fromAttempt ? "Mistakes to review" : options.focus ? `${quiz ? "Quiz" : "Cards"} on ${options.focus}` : quiz ? "Practice quiz" : "New cards");
  if (quiz) {
    const path = `study/quizzes/${title}.json`;
    quizzes[path] = { title, course: "Discrete Structures for Computer Science", sources, created: Date.now(), questions: test1, grounding: { ...grounding, exam: options.exam ?? "", scope: options.exam ? grounding.scope : "" } };
    send({ type: "done", path, questions: test1.length, grounding: quizzes[path]!.grounding });
  } else {
    const path = `study/decks/${title}.md`;
    decks[path] = { title, course: "Discrete Structures for Computer Science", sources, cards: decks["study/decks/Sets and functions.md"]?.cards.map((c) => ({ ...c, confidence: undefined, due: undefined })) ?? [] };
    send({ type: "done", path, cards: decks[path]!.cards.length, grounding });
  }
}
