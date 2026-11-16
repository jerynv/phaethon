import fs from "node:fs";
import path from "node:path";
import { isNotFound, lstatOrNull, readJson, writeJsonAtomic } from "../core/fsx.ts";
import { vaultRoot } from "../core/vault.ts";
import { Refusal } from "../rpc/registry.ts";
import { contentWords, words, type PersonRef } from "../memory/relevance.ts";

/**
 * People: one card per person in `<vault>/memory/people/<id>.json`. A card
 * holds who they are to the user (names, aliases like "my boss", relation,
 * where they work), how to reach them, notes on the dynamic (the why, never a
 * one-off remark) and a running log of interactions across chat and mail, so
 * "tell my boss I'm running late" needs nothing more.
 *
 * Cards belong to the vault but each lists the spaces that may see it
 * (`["*"]` for all). A space never sees a card that doesn't list it.
 */

export type Channel_ = "email" | "chat" | "meeting" | "call" | "message" | "other";
export const CHANNELS: readonly Channel_[] = ["email", "chat", "meeting", "call", "message", "other"];

export type Interaction = {
  at: number;
  channel: Channel_;
  direction?: "in" | "out";
  summary: string;
  /** Where it happened: a conversation, or a mail message. */
  ref?: { space: string; thread: string } | { account: string; message: string };
};

export type Person = {
  id: string;
  name: string;
  aliases: string[];
  relation?: string;
  org?: string;
  title?: string;
  emails: string[];
  phones: string[];
  links: { label: string; url: string }[];
  /** Spaces that may see this card; "*" for every space. */
  spaces: string[];
  /** The dynamic: what matters about working with them, in the user's interest. */
  notes: string[];
  interactions: Interaction[];
  created: number;
  updated: number;
  source: "user" | "agent" | "mail" | "review";
};

const MAX_INTERACTIONS = 300;
const MAX_NOTES = 40;
const MAX_FIELD = 200;

export function peopleDir(): string {
  return path.join(vaultRoot(), "memory", "people");
}

const isValidPersonId = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);

function fileOf(id: string): string {
  if (!isValidPersonId(id)) throw new Refusal(`"${String(id)}" is not a person id`);
  return path.join(peopleDir(), `${id}.json`);
}

const str = (v: unknown, max = MAX_FIELD) => (typeof v === "string" && v.trim() ? [...v.trim()].slice(0, max).join("") : undefined);
const strings = (v: unknown, max = 40, each = MAX_FIELD) =>
  Array.isArray(v) ? [...new Set(v.map((s) => str(s, each)).filter((s): s is string => !!s))].slice(0, max) : [];

export function normalEmail(e: string): string {
  return e.trim().toLowerCase().replace(/^mailto:/, "");
}

export function parsePerson(raw: unknown): Person | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" && isValidPersonId(o.id) ? o.id : undefined;
  const name = str(o.name);
  if (!id || !name) return null;
  const now = Date.now();
  const interactions: Interaction[] = Array.isArray(o.interactions)
    ? o.interactions
        .map((x): Interaction | null => {
          if (!x || typeof x !== "object") return null;
          const i = x as Record<string, unknown>;
          const summary = str(i.summary, 400);
          if (typeof i.at !== "number" || !summary) return null;
          const r = i.ref && typeof i.ref === "object" ? (i.ref as Record<string, unknown>) : undefined;
          const ref =
            r && typeof r.space === "string" && typeof r.thread === "string"
              ? { space: r.space, thread: r.thread }
              : r && typeof r.account === "string" && typeof r.message === "string"
                ? { account: r.account, message: r.message }
                : undefined;
          return {
            at: i.at,
            channel: CHANNELS.includes(i.channel as Channel_) ? (i.channel as Channel_) : "other",
            ...(i.direction === "in" || i.direction === "out" ? { direction: i.direction } : {}),
            summary,
            ...(ref ? { ref } : {}),
          };
        })
        .filter((x): x is Interaction => x !== null)
        .slice(-MAX_INTERACTIONS)
    : [];
  const links = Array.isArray(o.links)
    ? o.links
        .map((l) => (l && typeof l === "object" ? { label: str((l as Record<string, unknown>).label, 60) ?? "Link", url: str((l as Record<string, unknown>).url, 500) } : null))
        .filter((l): l is { label: string; url: string } => !!l?.url && /^https?:\/\//i.test(l.url))
        .slice(0, 20)
    : [];
  return {
    id,
    name,
    aliases: strings(o.aliases, 20, 80),
    ...(str(o.relation) ? { relation: str(o.relation) } : {}),
    ...(str(o.org) ? { org: str(o.org) } : {}),
    ...(str(o.title) ? { title: str(o.title) } : {}),
    emails: strings(o.emails, 20).map(normalEmail),
    phones: strings(o.phones, 10, 40),
    links,
    spaces: strings(o.spaces, 100, 64),
    notes: strings(o.notes, MAX_NOTES, 280),
    interactions,
    created: typeof o.created === "number" ? o.created : now,
    updated: typeof o.updated === "number" ? o.updated : now,
    source: o.source === "agent" || o.source === "mail" || o.source === "review" ? o.source : "user",
  };
}

export function readPerson(id: string): Person | null {
  try {
    return parsePerson(readJson<unknown>(fileOf(id), null));
  } catch {
    return null;
  }
}

export function allPeople(): Person[] {
  let names: string[];
  try {
    names = fs.readdirSync(peopleDir());
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  const out: Person[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const id = n.slice(0, -5);
    if (!isValidPersonId(id)) continue;
    const st = lstatOrNull(path.join(peopleDir(), n));
    if (!st?.isFile()) continue;
    const p = readPerson(id);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function canSee(p: Person, space: string): boolean {
  return p.spaces.includes("*") || p.spaces.includes(space);
}

export function peopleFor(space: string): Person[] {
  return allPeople().filter((p) => canSee(p, space));
}

export function savePerson(p: Person): Person {
  const clean = parsePerson({ ...p, updated: Date.now() });
  if (!clean) throw new Refusal("A person needs a name.");
  writeJsonAtomic(fileOf(clean.id), clean, { newline: true });
  return clean;
}

export function deletePerson(id: string): boolean {
  try {
    fs.rmSync(fileOf(id));
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

/** A readable, unused id from the name: "dana-reyes", "dana-reyes-2". */
export function idFor(name: string): string {
  const base =
    words(name)
      .join("-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "person";
  let id = base;
  for (let n = 2; fs.existsSync(path.join(peopleDir(), `${id}.json`)); n++) id = `${base}-${n}`;
  return id;
}

export function newPerson(fields: Partial<Person> & { name: string }, space: string, source: Person["source"]): Person {
  const now = Date.now();
  return savePerson({
    aliases: [],
    emails: [],
    phones: [],
    links: [],
    notes: [],
    interactions: [],
    ...fields,
    spaces: fields.spaces?.length ? fields.spaces : [space],
    id: idFor(fields.name),
    created: now,
    updated: now,
    source,
  });
}

/** Names a message might use for them: name, first name, aliases, "my <relation>", and "boss" for a manager. */
export function namesOf(p: Person): string[] {
  const out = new Set<string>([p.name, ...p.aliases]);
  const first = p.name.split(/\s+/)[0];
  if (first && first.length > 2) out.add(first);
  if (p.relation) {
    out.add(p.relation);
    const rel = p.relation.toLowerCase();
    if (/\b(manager|supervisor|boss|lead)\b/.test(rel)) out.add("boss");
    if (/\b(professor|instructor|teacher|lecturer)\b/.test(rel)) out.add("professor");
  }
  return [...out];
}

export function personRefs(space: string): PersonRef[] {
  return peopleFor(space).map((p) => ({ id: p.id, names: namesOf(p) }));
}

/**
 * Finds people for a query: an email address, a name or alias, "my boss", a
 * relation or an org. Best first; only cards this space can see.
 */
export function findPeople(space: string, query: string): Person[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const people = peopleFor(space);
  if (q.includes("@")) {
    const e = normalEmail(q);
    return people.filter((p) => p.emails.includes(e));
  }
  const qw = contentWords(q.replace(/\bmy\b/g, ""));
  const scored = people
    .map((p) => {
      let s = 0;
      const ns = namesOf(p).map((n) => n.toLowerCase());
      if (ns.includes(q) || ns.includes(q.replace(/^my /, ""))) s += 10;
      const hay = new Set(words(`${ns.join(" ")} ${p.org ?? ""} ${p.title ?? ""} ${p.emails.join(" ")}`));
      for (const w of qw) if (hay.has(w)) s += 2;
      return { p, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  return scored.map((x) => x.p);
}

export function findByEmail(email: string): Person | undefined {
  const e = normalEmail(email);
  return allPeople().find((p) => p.emails.includes(e));
}

/** Adds an interaction, skipping one already logged for the same mail message or conversation summary. */
export function logInteraction(id: string, i: Interaction): boolean {
  const p = readPerson(id);
  if (!p) return false;
  const dup = p.interactions.some((x) =>
    i.ref && x.ref && "message" in i.ref && "message" in x.ref ? x.ref.message === i.ref.message : x.summary === i.summary && Math.abs(x.at - i.at) < 3_600_000,
  );
  if (dup) return false;
  p.interactions.push(i);
  p.interactions.sort((a, b) => a.at - b.at);
  savePerson(p);
  return true;
}

const when = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The card as text for the model: who they are, how to reach them, the dynamic, the latest interactions. */
export function describePerson(p: Person, recent = 12): string {
  const lines = [`${p.name} [${p.id}]`];
  if (p.aliases.length) lines.push(`Also called: ${p.aliases.join(", ")}`);
  const role = [p.title, p.org].filter(Boolean).join(" at ");
  if (p.relation || role) lines.push(`Who they are to the user: ${[p.relation, role].filter(Boolean).join("; ")}`);
  if (p.emails.length) lines.push(`Email: ${p.emails.join(", ")}`);
  if (p.phones.length) lines.push(`Phone: ${p.phones.join(", ")}`);
  for (const l of p.links) lines.push(`${l.label}: ${l.url}`);
  if (p.notes.length) lines.push(`Notes:\n${p.notes.map((n) => `- ${n}`).join("\n")}`);
  const last = p.interactions.slice(-recent);
  if (last.length) {
    lines.push(
      `Latest interactions (oldest first, ${p.interactions.length} in all):\n${last
        .map((i) => {
          const where = i.ref ? ("thread" in i.ref ? ` [conversation ${i.ref.space}/${i.ref.thread}]` : ` [mail ${i.ref.account} ${i.ref.message}]`) : "";
          return `- ${when(i.at)} ${i.channel}${i.direction ? ` ${i.direction === "in" ? "from them" : "to them"}` : ""}: ${i.summary}${where}`;
        })
        .join("\n")}`,
    );
  }
  return lines.join("\n");
}
