import type { MockContext, MockHandlers } from "../mock-core";

/**
 * Fake core for the shell: spaces, conversations, search, settings,
 * appearance, version and updates. State lives in memory for the page's
 * life; reload to start over.
 */

type Space = { id: string; name: string; description: string; hue: number; educationEnabled: boolean; lastUsed: number | null };
type Thread = { id: string; title: string; updated: number; messages: number; current: boolean; text: string[] };

const now = Date.now();
const min = 60_000;
const hour = 60 * min;
const day = 24 * hour;

const spaces: Space[] = [
  { id: "school", name: "School", description: "Courses, deadlines, study notes", hue: 240, educationEnabled: true, lastUsed: now - 5 * min },
  { id: "work", name: "Work", description: "Lab job and the research group", hue: 50, educationEnabled: false, lastUsed: now - 2 * hour },
  { id: "thesis", name: "Senior thesis", description: "Reading notes and drafts", hue: 320, educationEnabled: false, lastUsed: now - 3 * day },
];

const threads: Record<string, Thread[]> = {
  school: [
    {
      id: "current",
      title: "Strong induction for the Fibonacci bound",
      updated: now - 4 * min,
      messages: 6,
      current: true,
      text: [
        "Can you walk me through proving F(n) < 2^n with strong induction?",
        "Start with the premises: F(1) = 1 and F(2) = 1, so the bound holds for n = 1 and n = 2. Assume it holds for every k below n…",
      ],
    },
    {
      id: "1762700000000",
      title: "Series convergence: ratio vs root test",
      updated: now - 3 * hour,
      messages: 12,
      current: false,
      text: ["When should I prefer the root test over the ratio test?", "Use the root test when the terms have nth powers, like (n/(2n+1))^n…"],
    },
    {
      id: "1762600000000",
      title: "C241 homework 6, problem 4",
      updated: now - day - 2 * hour,
      messages: 8,
      current: false,
      text: ["Is this relation transitive? R = {(a,b) | a divides b}", "Yes. If a divides b and b divides c, then c = b·m = a·k·m…"],
    },
    {
      id: "1762300000000",
      title: "Make a plan for Test 1 (through HW 6)",
      updated: now - 4 * day,
      messages: 4,
      current: false,
      text: ["Help me plan review for C241 Test 1. It covers through homework 6.", "Here's a five-day plan, one topic per day, with a mixed review the night before…"],
    },
    {
      id: "1761900000000",
      title: "Psychology reading summary, chapter 3",
      updated: now - 9 * day,
      messages: 2,
      current: false,
      text: ["Summarize chapter 3 on sensation and perception.", "Chapter 3 separates sensation (detecting energy) from perception (interpreting it)…"],
    },
  ],
  work: [
    {
      id: "current",
      title: "Email to Dr. Alvarez about the poster deadline",
      updated: now - 2 * hour,
      messages: 4,
      current: true,
      text: ["Draft a short email asking for one more week on the poster.", "Here's a draft that keeps it brief and offers a new date…"],
    },
    {
      id: "1762500000000",
      title: "Clean up the survey CSV",
      updated: now - 2 * day,
      messages: 10,
      current: false,
      text: ["The survey export has duplicate respondents. How do I dedupe by email?", "Group by the lowercase, trimmed email and keep the latest submission…"],
    },
  ],
  thesis: [],
};

const settings = {
  backend: "phaethon",
  hasAnthropicKey: false,
  model: null,
  provider: "anthropic",
  defaultModel: null,
  providerReady: false,
  providers: [],
  appearance: {} as unknown,
  vaultPath: "/Users/student/Phaethon/default",
  version: "0.2.0",
};

let update: {
  currentVersion: string;
  source: string | null;
  canInstall: boolean;
  status: Record<string, unknown>;
} = {
  currentVersion: "0.2.0",
  source: "https://github.com/jerynv/phaethon/releases",
  canInstall: true,
  status: { state: "idle" },
};

function space(id: string): Space {
  const s = spaces.find((x) => x.id === id);
  if (!s) throw "That space isn’t in your Phaethon folder any more.";
  return s;
}

function list(id: string): Thread[] {
  space(id);
  threads[id] ??= [];
  return threads[id];
}

function summary(t: Thread) {
  return { id: t.id, title: t.title, updated: t.updated, messages: t.messages, current: t.current };
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "space";
}

function fold(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export default {
  core_info: () => ({ version: "0.2.0", platform: "darwin", desktop: false }),

  settings_get: () => ({ ...settings }),
  appearance_set: (args: { appearance: unknown }) => {
    if (!args.appearance || typeof args.appearance !== "object") throw "Appearance must be an object.";
    settings.appearance = args.appearance;
  },

  spaces_list: () => [...spaces].sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0)),
  space_create: (args: { name: string; description?: string | null; hue?: number | null; educationEnabled?: boolean | null }) => {
    const name = args.name.trim();
    if (!name) throw "A space needs a name.";
    let id = slug(name);
    for (let n = 2; spaces.some((s) => s.id === id); n++) id = `${slug(name)}-${n}`;
    const s: Space = {
      id,
      name,
      description: (args.description ?? "").trim(),
      hue: args.hue ?? 200,
      educationEnabled: !!args.educationEnabled,
      lastUsed: null,
    };
    spaces.push(s);
    threads[id] = [];
    return s;
  },
  space_update: (args: { id: string; name?: string; description?: string; hue?: number; educationEnabled?: boolean }) => {
    const s = space(args.id);
    if (args.name !== undefined) {
      if (!args.name.trim()) throw "A space needs a name.";
      s.name = args.name.trim();
    }
    if (args.description !== undefined) s.description = args.description.trim();
    if (args.hue !== undefined) s.hue = Math.round(args.hue);
    if (args.educationEnabled !== undefined) s.educationEnabled = args.educationEnabled;
    return { ...s };
  },
  space_touch: (args: { id: string }) => {
    space(args.id).lastUsed = Date.now();
  },
  space_show: (args: { id: string }) => {
    space(args.id);
  },

  threads_list: (args: { space: string }) => {
    const all = list(args.space);
    const current = all.find((t) => t.current) ?? { id: "current", title: "New conversation", updated: Date.now(), messages: 0, current: true, text: [] };
    const archived = all.filter((t) => !t.current).sort((a, b) => b.updated - a.updated);
    return [summary(current), ...archived.map(summary)];
  },
  thread_new: (args: { space: string }) => {
    const all = list(args.space);
    const current = all.find((t) => t.current);
    if (current) {
      if (current.messages === 0) all.splice(all.indexOf(current), 1);
      else {
        current.current = false;
        current.id = String(Date.now());
      }
    }
    all.unshift({ id: "current", title: "New conversation", updated: Date.now(), messages: 0, current: true, text: [] });
  },
  thread_open: (args: { space: string; id: string }) => {
    if (args.id === "current") return;
    const all = list(args.space);
    const chosen = all.find((t) => t.id === args.id);
    if (!chosen) throw "That conversation couldn’t be opened: that conversation is no longer there";
    const current = all.find((t) => t.current);
    if (current) {
      if (current.messages === 0) all.splice(all.indexOf(current), 1);
      else {
        current.current = false;
        current.id = String(Date.now());
      }
    }
    chosen.current = true;
    chosen.id = "current";
  },
  thread_delete: (args: { space: string; id: string }) => {
    const all = list(args.space);
    const i = all.findIndex((t) => t.id === args.id);
    if (i === -1) return;
    if (args.id === "current") all[i] = { id: "current", title: "New conversation", updated: Date.now(), messages: 0, current: true, text: [] };
    else all.splice(i, 1);
  },

  conversations_search: (args: { space: string; query: string; allSpaces: boolean }) => {
    const q = fold(args.query.trim()).slice(0, 200);
    if (!q) return { conversations: [], truncated: false };
    const ids = args.allSpaces ? spaces.map((s) => s.id) : [args.space];
    const conversations = [];
    for (const id of ids) {
      for (const t of list(id)) {
        const snippets = [];
        let matches = 0;
        for (const [i, text] of ["", ...t.text].entries()) {
          if (i === 0) continue;
          const at = fold(text).indexOf(q);
          if (at === -1) continue;
          matches++;
          if (snippets.length < 3 && i > 0) {
            snippets.push({
              message: i - 1,
              role: i % 2 === 1 ? "user" : "assistant",
              before: (at > 48 ? "…" : "") + text.slice(Math.max(0, at - 48), at),
              matched: text.slice(at, at + q.length),
              after: text.slice(at + q.length, at + q.length + 96) + (text.length > at + q.length + 96 ? "…" : ""),
            });
          }
        }
        if (matches) conversations.push({ space: id, threadId: t.id, title: t.title, updated: t.updated, current: t.current, matches, snippets });
      }
    }
    conversations.sort((a, b) => b.updated - a.updated);
    return { conversations: conversations.slice(0, 50), truncated: conversations.length > 50 };
  },

  update_state: () => update,
  update_check: async (_args: unknown, ctx: MockContext) => {
    update = { ...update, status: { state: "checking" } };
    await ctx.sleep(900);
    update = { ...update, status: { state: "available", version: "0.2.1", notes: "Faster course import and a clearer study plan.", date: "2026-11-08" } };
    return update;
  },
  update_install: async (args: { onEvent: unknown }, ctx: MockContext) => {
    const ch = ctx.channel(args.onEvent);
    const total = 48_000_000;
    for (let received = 0; received <= total; received += 6_000_000) {
      ch.send({ kind: "downloading", received, total });
      await ctx.sleep(250);
    }
    ch.send({ kind: "installing" });
    await ctx.sleep(600);
    ch.send({ kind: "restarting" });
    await new Promise(() => {});
  },
} satisfies MockHandlers;
