import path from "node:path";
import type { AgentEvent } from "../../shared/agent.ts";
import { writeFileAtomic } from "../core/fsx.ts";
import { claim, release, turnKey } from "../core/runs.ts";
import { isTrashedSpace, spaceDir } from "../core/vault.ts";
import { CollectingChannel } from "../rpc/channel.ts";
import { messageOf, Refusal } from "../rpc/registry.ts";
import { forSpace } from "../providers/build.ts";
import { completeText } from "../providers/complete.ts";
import { readSettings, setSetting } from "../settings/settings.ts";
import { listSpaces } from "../spaces/meta.ts";
import { create, listThreadsIn, loadConversationIn, toUi, updateMetaIn } from "../threads/store.ts";
import { runOwnTurn } from "../agent/loop.ts";
import { runLifeTool } from "../agent/tools/life.ts";
import { transcript } from "../memory/memory.ts";
import { awaitingOutcome, describeItem, formatWhen, itemsFor, memorySettings, sweepNow } from "../memory/items.ts";
import { allPeople, canSee, findByEmail, logInteraction, newPerson, peopleFor } from "../people/people.ts";
import { accountsFor, connector, readMailSettings } from "../mail/access.ts";
import { addressOf, nameOf, type MailSummary } from "../mail/types.ts";
import { readSchedules, type Schedule } from "./schedules.ts";
import { jobBaseline, registerJob, setDynamicJobs, type JobDef, type Ready } from "./scheduler.ts";
import { notifyLater } from "../background/background.ts";

/**
 * The jobs Phaethon runs by itself, and the person's schedules as jobs.
 */

const DAY = 86_400_000;

function spaceIds(): string[] {
  try {
    return listSpaces().map((s) => s.id);
  } catch {
    return [];
  }
}

function providerReady(space?: string): Ready {
  try {
    forSpace(space);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `No model is set up yet: ${messageOf(e)}` };
  }
}

// ---- Memory sweep ---------------------------------------------------------------

export const SWEEP: JobDef = {
  id: "memory-sweep",
  title: "Let memories die off",
  description: "Closes states whose time is up and events nobody followed up on, and clears the archive past its keep time. No model.",
  cron: () => "*/15 * * * *",
  defaultOn: true,
  optional: false,
  model: false,
  ready: () => ({ ok: true }),
  run: async () => {
    const r = sweepNow();
    return r.expired.length || r.purged.length ? `Closed ${r.expired.length}, cleared ${r.purged.length} from the archive.` : "Nothing to close.";
  },
};

// ---- Memory review --------------------------------------------------------------

export const REVIEW_SYSTEM = `You keep a person's memory up to date from conversations they had with their assistants. You get one conversation (or its newest part), the memories already open, and the people already known. Reply with one JSON object and nothing else:

{"memories":[{"kind":"event|state|task|note","text":"…","why":"…","when":"ISO","until":"ISO","scope":"space|vault","people":["Name"]}],
 "close":[{"id":"m_…","status":"done|dismissed","outcome":"…"}],
 "people":[{"name":"…","aliases":["…"],"relation":"…","org":"…","title":"…","emails":["…"],"note":"…"}],
 "profile":[{"scope":"user|space","text":"…"}]}

Rules:
- memories: only what will matter in a later conversation: events with a time, temporary states with an estimated end, commitments, lasting context. Times as ISO 8601 with the offset given. Skip anything already open (same meaning), small talk, and anything only about this conversation.
- close: an open memory the conversation shows has happened, finished or no longer applies, with the outcome in a few words.
- people: someone the person deals with again (a manager, a teammate, a professor, a recruiter), with what the conversation says about them. Never guess an address. A note is the lasting dynamic in neutral words, never a quote or a vent.
- profile: lasting things about how the person works or what they need, never moods.
- Never anything secret (passwords, codes, account numbers) or a one-off remark about someone.
- Empty arrays when there is nothing. Usually there is little or nothing.`;

type ReviewOut = { memories?: unknown[]; close?: unknown[]; people?: unknown[]; profile?: unknown[] };

export function parseReview(text: string): ReviewOut {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return {};
  try {
    const v = JSON.parse(text.slice(a, b + 1)) as ReviewOut;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function hasNewConversation(since: number | undefined): boolean {
  const cutoff = since ?? Date.now() - 2 * DAY;
  for (const id of spaceIds()) {
    try {
      if (listThreadsIn(spaceDir(id)).some((t) => t.updated > cutoff)) return true;
    } catch {
      // skip
    }
  }
  return false;
}

export async function reviewConversations(signal: AbortSignal, since: number | undefined): Promise<string> {
  const cutoff = since ?? Date.now() - 2 * DAY;
  const tally = { conversations: 0, saved: 0, closed: 0, people: 0, profile: 0 };
  const now = Date.now();
  for (const space of spaceIds()) {
    let dir: string;
    try {
      dir = spaceDir(space);
    } catch {
      continue;
    }
    const threads = listThreadsIn(dir)
      .filter((t) => t.updated > cutoff)
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 8);
    for (const t of threads) {
      if (signal.aborted) throw new Error("cancelled");
      let msgs;
      try {
        msgs = loadConversationIn(dir, t.id);
      } catch {
        continue;
      }
      const fresh = msgs.filter((m) => (m.at ?? 0) > cutoff);
      if (!toUi(fresh).some((m) => m.role === "user")) continue;
      tally.conversations++;
      const open = itemsFor(space).map((it) => `- ${describeItem(it, now)}`);
      const people = peopleFor(space).map((p) => `- ${p.name}${p.relation ? ` (${p.relation})` : ""}`);
      const ask =
        `Now: ${new Date(now).toString()}\nSpace: ${space}\n\nOpen memories:\n${open.join("\n") || "(none)"}\n\nKnown people:\n${people.join("\n") || "(none)"}\n\n` +
        `<conversation title="${t.title.replace(/"/g, "'")}">\n${transcript(fresh)}</conversation>`;
      const reply = await completeText({ space, system: REVIEW_SYSTEM, messages: [{ role: "user", content: ask }], effort: "low", maxTokens: 2500, signal });
      const out = parseReview(reply.text);
      const ctx = { space, thread: t.id, signal };
      const tryTool = async (name: string, input: unknown) => {
        try {
          await runLifeTool(name, input, ctx);
          return true;
        } catch {
          return false;
        }
      };
      for (const m of (out.memories ?? []).slice(0, 8)) if (await tryTool("remember", m)) tally.saved++;
      for (const c of (out.close ?? []).slice(0, 8)) if (await tryTool("update_memory", c)) tally.closed++;
      for (const p of (out.people ?? []).slice(0, 6)) if (await tryTool("update_person", p)) tally.people++;
      if (memorySettings().profileLearning) for (const p of (out.profile ?? []).slice(0, 3)) if (await tryTool("note_profile", p)) tally.profile++;
    }
  }
  if (!tally.conversations) return "No new conversations.";
  return `Read ${tally.conversations} conversation${tally.conversations === 1 ? "" : "s"}: ${tally.saved} remembered, ${tally.closed} closed, ${tally.people} people, ${tally.profile} profile notes.`;
}

export const REVIEW: JobDef = {
  id: "memory-review",
  title: "Review conversations for memories",
  description: "Once a day, reads conversations that changed since the last review (including ones with coding agents, which can't remember by themselves) and keeps the front burner, people and profiles up to date. Uses your model.",
  cron: () => "30 3 * * *",
  defaultOn: true,
  optional: true,
  model: true,
  ready: () => {
    const s = memorySettings();
    if (!s.capture || !s.review) return { ok: false, reason: "Turned off in Settings › Memory." };
    const p = providerReady();
    if (!p.ok) return p;
    return hasNewConversation(jobBaseline("memory-review")) ? { ok: true } : { ok: false, reason: "No conversation has changed since the last review." };
  },
  run: reviewConversations,
};

// ---- Mail to people ---------------------------------------------------------------

const NOREPLY = /(^|[._-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounce|newsletter|news|updates?|info|support|alerts?)([._-]|@)/i;

export async function mailToPeople(signal: AbortSignal, since: number | undefined): Promise<string> {
  const s = readMailSettings();
  const from = new Date(Math.max(since ?? 0, Date.now() - 30 * DAY)).toISOString();
  let logged = 0;
  let added = 0;
  const seen = new Set<string>();
  const accounts = s.known.filter((a) => s.connectors[a.app] && (s.access[a.key] ?? []).length);
  for (const a of accounts) {
    if (signal.aborted) throw new Error("cancelled");
    const spaces = s.access[a.key] ?? [];
    const mine = new Set(a.emails);
    let inbox: MailSummary[] = [];
    let sent: MailSummary[] = [];
    try {
      inbox = await connector(a.app).list({ account: a.key, mailbox: "inbox", since: from, limit: 100 });
      sent = await connector(a.app).list({ account: a.key, mailbox: "sent", since: from, limit: 100 });
    } catch {
      continue;
    }
    // Back-and-forth: people the person wrote to who also wrote to them.
    const wroteTo = new Map<string, { n: number; name: string }>();
    for (const m of sent) for (const t of m.to) {
      const addr = addressOf(t);
      if (mine.has(addr)) continue;
      const cur = wroteTo.get(addr) ?? { n: 0, name: nameOf(t) };
      cur.n++;
      wroteTo.set(addr, cur);
    }
    const heardFrom = new Map<string, string>();
    for (const m of inbox) heardFrom.set(addressOf(m.from), nameOf(m.from));
    if (s.addPeopleFromMail) {
      for (const [addr, w] of wroteTo) {
        if (NOREPLY.test(addr) || !heardFrom.has(addr) || findByEmail(addr)) continue;
        const name = heardFrom.get(addr) || w.name;
        if (!name || name.includes("@")) continue;
        newPerson({ name, emails: [addr], spaces }, spaces[0] ?? "work", "mail");
        added++;
      }
    }
    const log = (addr: string, m: MailSummary, direction: "in" | "out") => {
      const p = findByEmail(addr);
      if (!p || !spaces.some((sp) => canSee(p, sp))) return;
      const k = `${p.id}:${m.ref}`;
      if (seen.has(k)) return;
      seen.add(k);
      if (logInteraction(p.id, { at: Date.parse(m.date) || Date.now(), channel: "email", direction, summary: m.subject ? `“${m.subject}”` : "(no subject)", ref: { account: a.key, message: m.ref } })) logged++;
    };
    for (const m of inbox) log(addressOf(m.from), m, "in");
    for (const m of sent) for (const t of m.to) log(addressOf(t), m, "out");
  }
  return `Logged ${logged} email${logged === 1 ? "" : "s"} on people’s cards${added ? `, added ${added} ${added === 1 ? "person" : "people"}` : ""}.`;
}

export const MAIL_PEOPLE: JobDef = {
  id: "mail-people",
  title: "Keep people’s email history",
  description: "Every six hours, reads the senders, recipients and subjects of recent mail (never the message bodies) and logs them on the cards of people you know; optionally adds people you write back and forth with.",
  cron: () => "5 */6 * * *",
  defaultOn: true,
  optional: true,
  model: false,
  ready: () => {
    const s = readMailSettings();
    if (!s.indexForPeople) return { ok: false, reason: "Turned off in Settings › Mail." };
    const any = s.known.some((a) => s.connectors[a.app] && (s.access[a.key] ?? []).length);
    return any ? { ok: true } : { ok: false, reason: "No mail account is assigned to a space yet." };
  },
  run: mailToPeople,
};

// ---- Daily digest ---------------------------------------------------------------

export type DigestSettings = { spaces: string[]; time: string };

export function digestSettings(): DigestSettings {
  const raw = readSettings().digest as Record<string, unknown> | undefined;
  const spaces = Array.isArray(raw?.spaces) ? raw.spaces.filter((s): s is string => typeof s === "string") : [];
  const time = typeof raw?.time === "string" && /^\d{1,2}:\d{2}$/.test(raw.time) ? raw.time : "07:00";
  return { spaces, time };
}

export function setDigestSettings(d: DigestSettings): DigestSettings {
  setSetting("digest", { spaces: [...new Set(d.spaces)], time: /^\d{1,2}:\d{2}$/.test(d.time) ? d.time : "07:00" });
  return digestSettings();
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** The digest for one space as Markdown. No model: what's on, what's waiting, who wrote. */
export async function digestFor(space: string, now = Date.now()): Promise<string> {
  const items = itemsFor(space);
  const tomorrow = now + DAY;
  const today = items.filter((i) => i.when !== undefined && sameDay(i.when, now) && i.kind !== "note");
  const next = items.filter((i) => i.when !== undefined && sameDay(i.when, tomorrow) && i.kind !== "note");
  const states = items.filter((i) => i.kind === "state");
  const tasks = items.filter((i) => i.kind === "task");
  const waiting = items.filter((i) => awaitingOutcome(i, now));
  const date = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date(now));
  const out = [`# ${date}`, ""];
  const list = (title: string, xs: typeof items, f: (i: (typeof items)[number]) => string) => {
    if (!xs.length) return;
    out.push(`## ${title}`, "", ...xs.map((i) => `- ${f(i)}`), "");
  };
  const t = (ms: number) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  list("Today", today, (i) => `${t(i.when!)} — ${i.text}`);
  list("Tomorrow", next, (i) => `${t(i.when!)} — ${i.text}`);
  list("Going on", states, (i) => `${i.text}${i.until ? ` (until ${formatWhen(i.until)})` : ""}`);
  list("To do", tasks, (i) => `${i.text}${i.when ? ` (due ${formatWhen(i.when)})` : ""}`);
  list("How did these go?", waiting, (i) => `${i.text} (${formatWhen(i.when!)})`);
  const people = new Map(allPeople().filter((p) => canSee(p, space)).flatMap((p) => p.emails.map((e) => [e, p] as const)));
  const lines: string[] = [];
  for (const a of accountsFor(space)) {
    try {
      const recent = await connector(a.app).list({ account: a.key, mailbox: "inbox", since: new Date(now - DAY).toISOString(), limit: 50 });
      for (const m of recent) {
        const p = people.get(addressOf(m.from));
        if (p) lines.push(`- ${p.name}: “${m.subject}”${m.unread ? " (unread)" : ""}`);
      }
    } catch {
      // mail is a nicety here
    }
  }
  if (lines.length) out.push("## From people you know (last day)", "", ...lines.slice(0, 20), "");
  if (out.length === 2) out.push("Nothing on the front burner.", "");
  return out.join("\n");
}

export const DIGEST: JobDef = {
  id: "daily-digest",
  title: "Daily digest",
  description: "Each morning, writes digests/<date>.md in the spaces you choose: today and tomorrow, what's going on, what's due, what to follow up, and mail from people you know. No model.",
  cron: () => {
    const [h, m] = digestSettings().time.split(":").map(Number);
    return `${m} ${h} * * *`;
  },
  defaultOn: true,
  optional: true,
  model: false,
  ready: () => (digestSettings().spaces.length ? { ok: true } : { ok: false, reason: "No space is chosen for a digest yet." }),
  run: async () => {
    const now = Date.now();
    const name = `${new Date(now).toISOString().slice(0, 10)}.md`;
    const done: string[] = [];
    for (const space of digestSettings().spaces) {
      let dir: string;
      try {
        spaceDir(space);
      } catch {
        continue;
      }
      const text = await digestFor(space, now);
      try {
        // The space may have been moved to the trash while mail was loading.
        dir = spaceDir(space);
      } catch {
        continue;
      }
      const file = path.join(dir, "digests", name);
      writeFileAtomic(file, text);
      done.push(space);
    }
    if (done.length) notifyLater({ kind: "digest", title: "Your daily digest is ready", body: `digests/${name} in ${done.join(", ")}`, target: { kind: "space", space: done[0]!, view: "files" } });
    return done.length ? `Wrote digests/${name} in ${done.join(", ")}.` : "No space to write in.";
  },
};

// ---- The person's schedules -------------------------------------------------------

const RUN_LIMIT_MS = 10 * 60_000;

export async function runSchedule(s: Schedule, signal?: AbortSignal): Promise<{ thread: string; summary: string }> {
  const dir = spaceDir(s.space);
  const thread = create(s.space);
  const run = claim(turnKey(s.space, thread));
  if (!run) throw new Refusal("That conversation is busy.");
  const stop = () => run.abort.abort();
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, RUN_LIMIT_MS);
  const events = new CollectingChannel<AgentEvent>();
  try {
    await runOwnTurn({ space: s.space, thread, provider: forSpace(s.space), events, run, mode: { kind: "prompt", prompt: s.prompt, attachments: [] }, unattended: true });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    release(run);
  }
  const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date());
  try {
    updateMetaIn(dir, thread, { title: `${s.title} · ${date}` });
  } catch {
    // the conversation stands without a title
  }
  const error = events.messages.find((e): e is Extract<AgentEvent, { kind: "error" }> => e.kind === "error");
  const wrote = events.messages.some((e) => e.kind === "text");
  if (error && !wrote) throw new Refusal(error.message);
  const said = events.messages.filter((e): e is Extract<AgentEvent, { kind: "text" }> => e.kind === "text").map((e) => e.delta).join("").trim();
  notifyLater({ kind: "schedule", title: s.title, body: said ? said.replace(/\s+/g, " ").slice(0, 180) : "Done.", target: { kind: "thread", space: s.space, thread } });
  return { thread, summary: `Wrote “${s.title} · ${date}” in ${s.space}.` };
}

export function scheduleJobs(): JobDef[] {
  return readSchedules()
    .filter((s) => s.enabled && !isTrashedSpace(s.space))
    .map((s) => ({
      id: `schedule:${s.id}`,
      title: s.title,
      description: `In ${s.space}: ${s.prompt.length > 140 ? `${s.prompt.slice(0, 139)}…` : s.prompt}`,
      cron: () => s.cron,
      defaultOn: true,
      optional: false,
      model: true,
      ready: () => providerReady(s.space),
      run: async (signal) => (await runSchedule(s, signal)).summary,
    }));
}

export function registerBuiltinJobs(): void {
  registerJob(SWEEP);
  registerJob(REVIEW);
  registerJob(MAIL_PEOPLE);
  registerJob(DIGEST);
  setDynamicJobs(scheduleJobs);
}
