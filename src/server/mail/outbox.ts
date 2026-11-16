import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { isNotFound, readJson, writeJsonAtomic } from "../core/fsx.ts";
import { spaceDir } from "../core/vault.ts";
import { Refusal, messageOf } from "../rpc/registry.ts";
import { log } from "../log.ts";
import { notifyLater } from "../background/background.ts";
import { findByEmail, logInteraction, newPerson } from "../people/people.ts";
import { accountsFor, appOf, connector, readMailSettings, resolveAccount, senderFor } from "./access.ts";
import { addressOf, isAddress, nameOf, type MailProvider, type Outgoing } from "./types.ts";

/**
 * Drafts and their sending, one file each in `<space>/.phaethon/outbox/`.
 * Nothing is sent from the renderer: a send is a time on the draft and a
 * timer here, so a reload or a second window can't lose or double it. The
 * person can stop it (back to draft), edit it (which stops it), or send it
 * now. A send whose time passed while Phaethon was closed goes back to draft.
 */

export type DraftStatus = "draft" | "scheduled" | "sending" | "sent" | "opened" | "discarded" | "failed";

export type Review = { tone: string; summary: string; issues: string[]; at: number };

export type Draft = {
  id: string;
  space: string;
  thread?: string;
  account: string;
  accountName: string;
  provider: MailProvider;
  sender: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  replyTo?: string;
  /** What the agent was asked for: a draft never sends by itself. */
  intent: "draft" | "send";
  status: DraftStatus;
  sendAt?: number;
  sentAt?: number;
  created: number;
  updated: number;
  /** Why it is where it is ("Stopped", "Phaethon was closed before it was sent"). */
  note?: string;
  error?: string;
  review?: Review;
  /** For a draft made from a `phaethon-email` block: the block's fingerprint, so showing it again finds the same draft. */
  key?: string;
  /** Recipients named without an address Phaethon could find; the card asks for them. */
  missing?: string[];
  /** Names known for recipients' addresses ("Name <address>", or a name the card asked an address for). */
  names?: Record<string, string>;
};

export type DraftFields = { account?: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; replyTo?: string };

const isDraftId = (id: unknown): id is string => typeof id === "string" && /^d_[a-z0-9]{6,32}$/.test(id);
const MAX_BODY = 100_000;
const MAX_RECIPIENTS = 50;
/** The undo window when the person presses Send themselves. */
export const MANUAL_DELAY_SECONDS = 5;

function outboxDir(space: string): string {
  return path.join(spaceDir(space), ".phaethon", "outbox");
}

function fileOf(space: string, id: string): string {
  if (!isDraftId(id)) throw new Refusal("That isn’t a draft id.");
  return path.join(outboxDir(space), `${id}.json`);
}

export function readDraft(space: string, id: string): Draft {
  let d: Draft | null;
  try {
    d = readJson<Draft | null>(fileOf(space, id), null);
  } catch (e) {
    throw new Refusal(`That draft couldn’t be read: ${messageOf(e)}`);
  }
  if (!d) throw new Refusal("That draft no longer exists.");
  return d;
}

function save(d: Draft): Draft {
  d.updated = Date.now();
  writeJsonAtomic(fileOf(d.space, d.id), d, { newline: true });
  for (const l of listeners) l(d);
  return d;
}

export function listDrafts(space: string): Draft[] {
  let names: string[];
  try {
    names = fs.readdirSync(outboxDir(space));
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  return names
    .filter((n) => n.endsWith(".json") && isDraftId(n.slice(0, -5)))
    .map((n) => {
      try {
        return readDraft(space, n.slice(0, -5));
      } catch {
        return null;
      }
    })
    .filter((d): d is Draft => d !== null)
    .sort((a, b) => b.created - a.created);
}

function cleanList(v: string[] | undefined, what: string): string[] {
  const out = [...new Set((v ?? []).flatMap((s) => s.split(/[,;]/)).map((s) => s.trim()).filter(Boolean))];
  if (out.length > MAX_RECIPIENTS) throw new Refusal(`At most ${MAX_RECIPIENTS} ${what} recipients.`);
  for (const a of out) if (!isAddress(addressOf(a))) throw new Refusal(`“${a}” isn’t an email address.`);
  return out.map(addressOf);
}

/** Names given with addresses ("Dana Reyes <dana@x.com>"), by address. */
export function namesIn(lists: (string[] | undefined)[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lists) for (const raw of (l ?? []).flatMap((s) => s.split(/[,;]/))) {
    const n = nameOf(raw);
    if (n && isAddress(addressOf(raw))) out[addressOf(raw)] = n;
  }
  return out;
}

function checkFields(f: DraftFields): { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string } {
  const to = cleanList(f.to, "To");
  const cc = cleanList(f.cc, "Cc");
  const bcc = cleanList(f.bcc, "Bcc");
  const subject = String(f.subject ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 400);
  const body = String(f.body ?? "");
  if (Buffer.byteLength(body) > MAX_BODY) throw new Refusal("That message is too long to draft here.");
  return { to, cc, bcc, subject, body };
}

// ---- Timers -------------------------------------------------------------------

const timers = new Map<string, NodeJS.Timeout>();
const listeners = new Set<(d: Draft) => void>();
const key = (space: string, id: string) => `${space}/${id}`;

/** Tests and the UI's live view: every saved change to a draft. */
export function onDraftChange(f: (d: Draft) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

function disarm(space: string, id: string): void {
  const t = timers.get(key(space, id));
  if (t) clearTimeout(t);
  timers.delete(key(space, id));
}

function arm(d: Draft): void {
  disarm(d.space, d.id);
  if (d.status !== "scheduled" || d.sendAt === undefined) return;
  const t = setTimeout(() => void fire(d.space, d.id), Math.max(0, d.sendAt - Date.now()));
  t.unref?.();
  timers.set(key(d.space, d.id), t);
}

async function fire(space: string, id: string): Promise<void> {
  timers.delete(key(space, id));
  let d: Draft;
  try {
    d = readDraft(space, id);
  } catch {
    return;
  }
  // Changed since it was armed (stopped, edited, rescheduled): the newer state wins.
  if (d.status !== "scheduled" || d.sendAt === undefined) return;
  if (d.sendAt > Date.now() + 250) return arm(d);
  await deliver(d);
}

function outgoing(d: Draft): Outgoing {
  return { account: d.account, sender: d.sender, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, body: d.body, ...(d.replyTo ? { replyTo: d.replyTo } : {}) };
}

async function deliver(d: Draft): Promise<Draft> {
  // The account must still be assigned to this space at the moment of sending.
  if (!accountsFor(d.space).some((a) => a.key === d.account)) {
    return save({ ...d, status: "failed", sendAt: undefined, error: "That account is no longer set up for this space, so the message wasn’t sent." });
  }
  if (!readMailSettings().allowSend) return save({ ...d, status: "draft", sendAt: undefined, note: "Sending is turned off in Settings › Mail, so it wasn’t sent." });
  save({ ...d, status: "sending", error: undefined });
  try {
    await connector(appOf(d.account)).send(outgoing(d));
  } catch (e) {
    log.warn("mail send failed", { error: messageOf(e) });
    notifyLater({ kind: "mail", title: `Not sent: ${d.subject || "(no subject)"}`, body: messageOf(e).slice(0, 200), target: d.thread ? { kind: "thread", space: d.space, thread: d.thread } : { kind: "space", space: d.space } });
    return save({ ...readDraft(d.space, d.id), status: "failed", sendAt: undefined, error: messageOf(e) });
  }
  const sent = save({ ...readDraft(d.space, d.id), status: "sent", sendAt: undefined, sentAt: Date.now(), error: undefined, note: undefined });
  const added = await recordSent(sent);
  notifyLater({ kind: "mail", title: `Sent: ${sent.subject || "(no subject)"}`, body: `To ${sent.to.join(", ")}${added.length ? ` · added ${added.join(" and ")} to People` : ""}`, whenAway: true, target: sent.thread ? { kind: "thread", space: sent.space, thread: sent.thread } : { kind: "space", space: sent.space } });
  return added.length ? save({ ...readDraft(d.space, d.id), note: `Added ${added.join(" and ")} to People.` }) : sent;
}

/** A sent message goes on the card of everyone it went to that Phaethon knows. */
/** The name an address goes by in this account's mail (the newest message from it), if any. */
async function nameInMail(d: Draft, address: string): Promise<string | undefined> {
  try {
    const found = await connector(appOf(d.account)).list({ account: d.account, mailbox: "inbox", from: address, since: new Date(Date.now() - 2 * 365 * 86_400_000).toISOString(), limit: 1 });
    const n = found[0] ? nameOf(found[0].from) : "";
    return n && !n.includes("@") ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A sent message goes on the card of everyone it went to; someone not in
 * People yet gets a card when a name can be found for them (given with the
 * address, asked for on the card, or in their mail). Returns who was added.
 */
async function recordSent(d: Draft): Promise<string[]> {
  const added: string[] = [];
  for (const addr of [...d.to, ...d.cc]) {
    try {
      let p = findByEmail(addr);
      if (!p) {
        const name = d.names?.[addr] ?? (await nameInMail(d, addr));
        if (name) {
          p = newPerson({ name, emails: [addr] }, d.space, "mail");
          added.push(p.name);
        }
      }
      if (p) logInteraction(p.id, { at: d.sentAt ?? Date.now(), channel: "email", direction: "out", summary: d.subject ? `Sent “${d.subject}”` : "Sent an email", ...(d.thread ? { ref: { space: d.space, thread: d.thread } } : {}) });
    } catch {
      // the send matters more than the log
    }
  }
  return added;
}

// ---- Operations ---------------------------------------------------------------

/**
 * A new draft from the agent. With intent "send" (and sending allowed, and a
 * person there to see it) it is scheduled after the configured delay.
 */
export function createDraft(space: string, f: DraftFields, opts: { intent: "draft" | "send"; thread?: string; unattended?: boolean; key?: string; missing?: string[]; names?: Record<string, string> }): Draft {
  const account = resolveAccount(space, f.account);
  const fields = checkFields(f);
  const settings = readMailSettings();
  const now = Date.now();
  const id = `d_${now.toString(36)}${randomBytes(4).toString("hex")}`;
  const addressed = fields.to.length > 0 || !!f.replyTo;
  const canSend = opts.intent === "send" && settings.allowSend && !opts.unattended && addressed;
  const d: Draft = {
    id,
    space,
    ...(opts.thread ? { thread: opts.thread } : {}),
    account: account.key,
    accountName: account.name,
    provider: account.provider,
    sender: senderFor(account, f.account?.includes("@") ? f.account : undefined),
    ...fields,
    ...(f.replyTo ? { replyTo: f.replyTo } : {}),
    intent: opts.intent,
    status: canSend ? "scheduled" : "draft",
    ...(canSend ? { sendAt: now + settings.sendDelaySeconds * 1000 } : {}),
    created: now,
    updated: now,
    ...(opts.intent === "send" && !canSend
      ? { note: opts.unattended ? "Written while you were away, so it waits for you." : !addressed ? "Add who it goes to, then send." : "Sending is turned off in Settings › Mail." }
      : {}),
    ...(opts.key ? { key: opts.key } : {}),
    ...(opts.missing?.length ? { missing: opts.missing } : {}),
    ...(() => {
      const names = { ...namesIn([f.to, f.cc, f.bcc]), ...(opts.names ?? {}) };
      return Object.keys(names).length ? { names } : {};
    })(),
  };
  save(d);
  arm(d);
  return d;
}

const editable = (d: Draft) => d.status === "draft" || d.status === "scheduled" || d.status === "failed" || d.status === "opened";

/** Changes fields; a scheduled send stops so nothing goes out that the person hasn't seen. */
export function updateDraft(space: string, id: string, patch: Partial<DraftFields>): Draft {
  const d = readDraft(space, id);
  if (!editable(d)) throw new Refusal(d.status === "sent" ? "That message was already sent." : "That draft can’t be changed now.");
  disarm(space, id);
  let account = { key: d.account, name: d.accountName, provider: d.provider, sender: d.sender };
  if (patch.account !== undefined && patch.account !== d.account) {
    const a = resolveAccount(space, patch.account);
    account = { key: a.key, name: a.name, provider: a.provider, sender: senderFor(a) };
  }
  const fields = checkFields({ to: patch.to ?? d.to, cc: patch.cc ?? d.cc, bcc: patch.bcc ?? d.bcc, subject: patch.subject ?? d.subject, body: patch.body ?? d.body, replyTo: d.replyTo });
  const missing = fields.to.length ? [] : (d.missing ?? []);
  // An address typed while a name was missing is that person's address.
  const names = { ...(d.names ?? {}), ...namesIn([patch.to, patch.cc, patch.bcc]) };
  const fresh = fields.to.filter((a) => !d.to.includes(a) && !names[a]);
  (d.missing ?? []).forEach((n, i) => {
    if (fresh[i]) names[fresh[i]!] = n;
  });
  return save({ ...d, ...fields, ...(missing.length ? { missing } : { missing: undefined }), ...(Object.keys(names).length ? { names } : {}), account: account.key, accountName: account.name, provider: account.provider, sender: account.sender, status: "draft", sendAt: undefined, note: d.status === "scheduled" ? "Paused while you edit." : fields.to.length && d.note?.startsWith("Add who") ? undefined : d.note, error: undefined, review: d.review && patch.body === undefined && patch.subject === undefined ? d.review : undefined });
}

/** Starts (or restarts) the countdown; 0 sends now. */
export async function sendDraft(space: string, id: string, delaySeconds: number): Promise<Draft> {
  const d = readDraft(space, id);
  if (!editable(d)) throw new Refusal(d.status === "sent" ? "That message was already sent." : "That draft can’t be sent now.");
  if (!readMailSettings().allowSend) throw new Refusal("Sending is turned off in Settings › Mail.");
  if (!d.to.length && !d.replyTo) throw new Refusal("Add a recipient first.");
  disarm(space, id);
  if (delaySeconds <= 0) return deliver(d);
  const next = save({ ...d, status: "scheduled", sendAt: Date.now() + Math.min(delaySeconds, 600) * 1000, note: undefined, error: undefined });
  arm(next);
  return next;
}

/** The draft made from a block with this fingerprint, if any. */
export function draftByKey(space: string, key: string): Draft | undefined {
  return listDrafts(space).find((d) => d.key === key);
}

export function stopSend(space: string, id: string): Draft {
  const d = readDraft(space, id);
  disarm(space, id);
  if (d.status !== "scheduled") return d;
  return save({ ...d, status: "draft", sendAt: undefined, note: "Stopped. Nothing was sent." });
}

export function discardDraft(space: string, id: string): Draft {
  const d = readDraft(space, id);
  if (d.status === "sent" || d.status === "sending") throw new Refusal("That message was already sent.");
  disarm(space, id);
  return save({ ...d, status: "discarded", sendAt: undefined });
}

export async function openDraft(space: string, id: string): Promise<Draft> {
  const d = readDraft(space, id);
  if (d.status === "sent" || d.status === "sending") throw new Refusal("That message was already sent.");
  if (!accountsFor(space).some((a) => a.key === d.account)) throw new Refusal("That account is no longer set up for this space.");
  disarm(space, id);
  await connector(appOf(d.account)).open(outgoing(d));
  return save({ ...readDraft(space, id), status: "opened", sendAt: undefined, note: "Opened in Mail to finish there." });
}

export function setReview(space: string, id: string, review: Review): Draft {
  return save({ ...readDraft(space, id), review });
}

/**
 * At startup: a scheduled send whose time passed while Phaethon was closed
 * goes back to draft (a person should see it before it goes); a future one
 * is armed again.
 */
export function recoverOutbox(spaces: string[]): { reverted: number; armed: number } {
  let reverted = 0;
  let armed = 0;
  const now = Date.now();
  for (const space of spaces) {
    let drafts: Draft[];
    try {
      drafts = listDrafts(space);
    } catch {
      continue;
    }
    for (const d of drafts) {
      if (d.status === "sending") {
        save({ ...d, status: "failed", error: "Phaethon closed while this was sending; check Mail’s Sent mailbox before sending again." });
        reverted++;
      } else if (d.status === "scheduled") {
        if ((d.sendAt ?? 0) <= now) {
          save({ ...d, status: "draft", sendAt: undefined, note: "Phaethon was closed before it was sent, so it wasn’t sent." });
          reverted++;
        } else {
          arm(d);
          armed++;
        }
      }
    }
  }
  return { reverted, armed };
}

/** Tests and shutdown. */
export function disarmAll(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
