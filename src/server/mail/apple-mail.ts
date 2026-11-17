import fs from "node:fs";
import { JXA_PRELUDE, runOsascript, type ScriptRunner } from "./osascript.ts";
import { decodeRef, encodeRef, guessProvider, type MailAccount, type MailConnector, type MailMessage, type MailQuery, type MailSummary, type Outgoing } from "./types.ts";

/**
 * Apple Mail through JavaScript for Automation. Measured on a 39,000-message
 * inbox (Nov 2026): reading one property of every message at once takes about
 * 1.5 s, a message by id 7 ms, but a `whose` filter 41 s and a message by
 * index seconds. So a search reads ids and dates of the whole mailbox in bulk,
 * filters in JavaScript, and fetches details only for the hits, by id.
 */

const MAILBOX_ALIASES = `const ALIASES = { inbox: ["inbox"], sent: ["sent messages", "sent mail", "sent items", "sent"], drafts: ["drafts"], archive: ["archive", "all mail"], junk: ["junk", "spam", "junk email", "junk e-mail"], trash: ["deleted messages", "trash", "deleted items", "bin"] };
function pick(names, want) {
  const w = String(want || "inbox").trim().toLowerCase();
  for (const a of (ALIASES[w] || [])) { const hit = names.find(n => n.toLowerCase() === a); if (hit) return hit; }
  return names.find(n => n.toLowerCase() === w);
}
// Nested mailboxes (Gmail's [Gmail]/Sent Mail) list by their own name but can't be found by it: go by position.
function boxAt(acc, name) {
  const i = acc.mailboxes.name().indexOf(name);
  if (i < 0) throw new Error("There is no mailbox called " + name + " in that account.");
  return acc.mailboxes[i];
}
`;

const ACCOUNTS = `${JXA_PRELUDE}
function run() {
  const Mail = Application("Mail");
  return JSON.stringify(Mail.accounts().map(a => {
    let full = ""; try { full = a.fullName(); } catch (e) {}
    return { id: a.id(), name: a.name(), type: String(a.accountType()), enabled: a.enabled(), emails: a.emailAddresses(), fullName: full };
  }));
}`;

const LIST = `${JXA_PRELUDE}${MAILBOX_ALIASES}
function run() {
  const Mail = Application("Mail");
  const acc = Mail.accounts.byId(args.account);
  const names = acc.mailboxes.name();
  const box = pick(names, args.mailbox);
  if (!box) return JSON.stringify({ error: "noMailbox", names: names });
  const mb = boxAt(acc, box);
  const ids = mb.messages.id();
  const dates = mb.messages.dateReceived();
  const since = args.since ? new Date(args.since) : null;
  let idx = [];
  for (let i = 0; i < ids.length; i++) if (!since || dates[i] >= since) idx.push(i);
  const lower = s => String(s || "").toLowerCase();
  if (args.from || args.text) {
    const senders = mb.messages.sender();
    const subjects = args.text ? mb.messages.subject() : null;
    const from = lower(args.from), text = lower(args.text);
    idx = idx.filter(i => (!from || lower(senders[i]).includes(from)) && (!text || lower(subjects[i]).includes(text) || lower(senders[i]).includes(text)));
  }
  if (args.unread) { const read = mb.messages.readStatus(); idx = idx.filter(i => !read[i]); }
  idx.sort((a, b) => dates[b] - dates[a]);
  idx = idx.slice(0, Math.max(1, Math.min(args.limit || 20, 100)));
  const out = idx.map(i => {
    const m = mb.messages.byId(ids[i]);
    let to = []; try { to = m.toRecipients.address(); } catch (e) {}
    return { id: ids[i], from: m.sender(), to: to, subject: m.subject(), date: dates[i].toISOString(), unread: !m.readStatus() };
  });
  return JSON.stringify({ mailbox: box, items: out, total: ids.length });
}`;

const READ = `${JXA_PRELUDE}${MAILBOX_ALIASES}
function run() {
  const Mail = Application("Mail");
  const m = boxAt(Mail.accounts.byId(args.account), args.mailbox).messages.byId(Number(args.id));
  let to = [], cc = []; try { to = m.toRecipients.address(); } catch (e) {} try { cc = m.ccRecipients.address(); } catch (e) {}
  let body = ""; try { body = m.content(); } catch (e) {}
  let mid = ""; try { mid = m.messageId(); } catch (e) {}
  return JSON.stringify({ from: m.sender(), to: to, cc: cc, subject: m.subject(), date: m.dateReceived().toISOString(), unread: !m.readStatus(), body: String(body).slice(0, args.max), long: String(body).length > args.max, messageId: mid });
}`;

/** Builds the outgoing message; sends it, or shows it for the person to finish. */
const COMPOSE = `${JXA_PRELUDE}${MAILBOX_ALIASES}
function run() {
  const Mail = Application("Mail");
  let msg;
  if (args.replyTo) {
    const orig = boxAt(Mail.accounts.byId(args.replyTo.account), args.replyTo.mailbox).messages.byId(Number(args.replyTo.id));
    msg = Mail.reply(orig, { openingWindow: !!args.open, replyToAll: false });
    const quoted = String(msg.content() || "");
    msg.content = args.body + (quoted ? "\\n\\n" + quoted : "");
    if (args.subject) msg.subject = args.subject;
  } else {
    msg = Mail.OutgoingMessage({ subject: args.subject, content: args.body, visible: !!args.open });
    Mail.outgoingMessages.push(msg);
  }
  msg.sender = args.sender;
  if (!args.replyTo) for (const a of args.to) msg.toRecipients.push(Mail.Recipient({ address: a }));
  for (const a of args.cc) msg.ccRecipients.push(Mail.CcRecipient({ address: a }));
  for (const a of args.bcc) msg.bccRecipients.push(Mail.BccRecipient({ address: a }));
  // After the text is set (setting content afterwards would drop them); Mail needs a moment to take files before it sends.
  const files = args.attachments || [];
  for (const f of files) msg.content.attachments.push(Mail.Attachment({ fileName: Path(f) }));
  if (args.open) { msg.visible = true; Mail.activate(); return JSON.stringify({ ok: "opened" }); }
  if (files.length) delay(Math.min(5, 1 + files.length * 0.5));
  const sent = msg.send();
  return JSON.stringify({ ok: sent === false ? "notSent" : "sent" });
}`;

export const MAX_BODY = 60_000;

type Cached = { at: number; value: MailSummary[] };

export class AppleMail implements MailConnector {
  readonly app = "apple-mail" as const;
  readonly label = "Apple Mail";
  readonly #cache = new Map<string, Cached>();
  constructor(private readonly run: ScriptRunner = runOsascript) {}

  async available() {
    if (process.platform !== "darwin") return { ok: false, reason: "Apple Mail is only on a Mac." };
    if (!fs.existsSync("/System/Applications/Mail.app") && !fs.existsSync("/Applications/Mail.app")) return { ok: false, reason: "The Mail app isn’t on this Mac." };
    return { ok: true };
  }

  #script(script: string, args: unknown, timeoutMs = 60_000) {
    return this.run(script, args, { language: "JavaScript", app: "Mail", timeoutMs });
  }

  async accounts(): Promise<MailAccount[]> {
    const raw = JSON.parse(await this.#script(ACCOUNTS, null, 30_000)) as { id: string; name: string; type: string; enabled: boolean; emails: string[]; fullName: string }[];
    return raw.map((a) => ({
      key: `apple-mail:${a.id}`,
      app: "apple-mail",
      name: a.name,
      emails: a.emails.map((e) => e.toLowerCase()),
      ...(a.fullName ? { fullName: a.fullName } : {}),
      provider: guessProvider(a.type, a.emails, a.name),
      enabled: a.enabled,
    }));
  }

  async list(q: MailQuery): Promise<MailSummary[]> {
    const id = q.account.replace(/^apple-mail:/, "");
    const key = JSON.stringify(q);
    const hit = this.#cache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const res = JSON.parse(await this.#script(LIST, { ...q, account: id }, 90_000)) as
      | { error: "noMailbox"; names: string[] }
      | { mailbox: string; items: { id: number; from: string; to: string[]; subject: string; date: string; unread: boolean }[] };
    if ("error" in res) throw new Error(`There’s no “${q.mailbox}” mailbox in that account. It has: ${res.names.slice(0, 30).join(", ")}.`);
    const value = res.items.map((m) => ({
      ref: encodeRef({ app: "apple-mail", account: id, mailbox: res.mailbox, id: m.id }),
      account: q.account,
      mailbox: res.mailbox,
      from: m.from,
      to: m.to,
      subject: m.subject,
      date: m.date,
      unread: m.unread,
    }));
    this.#cache.set(key, { at: Date.now(), value });
    if (this.#cache.size > 50) this.#cache.delete(this.#cache.keys().next().value!);
    return value;
  }

  async read(ref: string): Promise<MailMessage> {
    const r = decodeRef(ref);
    const m = JSON.parse(await this.#script(READ, { account: r.account, mailbox: r.mailbox, id: r.id, max: MAX_BODY })) as {
      from: string;
      to: string[];
      cc: string[];
      subject: string;
      date: string;
      unread: boolean;
      body: string;
      long: boolean;
      messageId: string;
    };
    return { ref, account: `apple-mail:${r.account}`, mailbox: r.mailbox, from: m.from, to: m.to, cc: m.cc, subject: m.subject, date: m.date, unread: m.unread, body: m.body, truncated: m.long, ...(m.messageId ? { messageId: m.messageId } : {}) };
  }

  #compose(m: Outgoing, open: boolean) {
    const replyTo = m.replyTo ? decodeRef(m.replyTo) : undefined;
    return this.#script(COMPOSE, { ...m, open, account: m.account.replace(/^apple-mail:/, ""), replyTo }, 60_000);
  }

  async send(m: Outgoing): Promise<void> {
    const res = JSON.parse(await this.#compose(m, false)) as { ok: string };
    if (res.ok !== "sent") throw new Error("Mail didn’t send the message. Check that the account is online in Mail.");
    this.#cache.clear();
  }

  async open(m: Outgoing): Promise<void> {
    await this.#compose(m, true);
  }
}

export const _scripts = { ACCOUNTS, LIST, READ, COMPOSE };
