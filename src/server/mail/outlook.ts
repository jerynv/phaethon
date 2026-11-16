import fs from "node:fs";
import { JXA_PRELUDE, runOsascript, type ScriptRunner } from "./osascript.ts";
import { decodeRef, encodeRef, guessProvider, type MailAccount, type MailConnector, type MailMessage, type MailQuery, type MailSummary, type Outgoing } from "./types.ts";

/**
 * Classic Outlook for Mac through JavaScript for Automation. The new Outlook
 * has no scripting dictionary, so it reports itself unusable; the person can
 * add the same account to Apple Mail instead. Written against Outlook's
 * documented dictionary; not yet run against a real Outlook (none on the
 * development Mac).
 */

const APP_PATH = "/Applications/Microsoft Outlook.app";

const ACCOUNTS = `${JXA_PRELUDE}
function run() {
  const O = Application("Microsoft Outlook");
  const out = [];
  const add = (list, type) => { for (const a of list) { let full = ""; try { full = a.fullName(); } catch (e) {} out.push({ id: String(a.id()), name: a.name(), type: type, emails: [String(a.emailAddress())], fullName: full }); } };
  try { add(O.exchangeAccounts(), "exchange"); } catch (e) {}
  try { add(O.imapAccounts(), "imap"); } catch (e) {}
  try { add(O.popAccounts(), "pop"); } catch (e) {}
  return JSON.stringify(out);
}`;

const FOLDER = `function findAccount(O, id) {
  for (const k of ["exchangeAccounts", "imapAccounts", "popAccounts"]) { try { for (const a of O[k]()) if (String(a.id()) === id) return a; } catch (e) {} }
  throw new Error("That account is no longer in Outlook.");
}
function folderOf(O, acc, want) {
  const w = String(want || "inbox").toLowerCase();
  const names = { inbox: ["inbox"], sent: ["sent items", "sent"], drafts: ["drafts"], archive: ["archive"], junk: ["junk email", "junk"], trash: ["deleted items", "trash"] }[w] || [w];
  for (const f of acc.mailFolders()) if (names.includes(String(f.name()).toLowerCase())) return f;
  return null;
}
`;

const LIST = `${JXA_PRELUDE}${FOLDER}
function run() {
  const O = Application("Microsoft Outlook");
  const acc = findAccount(O, args.account);
  const f = folderOf(O, acc, args.mailbox);
  if (!f) return JSON.stringify({ error: "noMailbox" });
  const ids = f.messages.id(), dates = f.messages.timeReceived();
  const since = args.since ? new Date(args.since) : null;
  let idx = []; for (let i = 0; i < ids.length; i++) if (!since || dates[i] >= since) idx.push(i);
  const lower = s => String(s || "").toLowerCase();
  if (args.from || args.text) {
    const senders = f.messages.sender().map(s => s ? (s.address || "") + " " + (s.name || "") : "");
    const subjects = f.messages.subject();
    idx = idx.filter(i => (!args.from || lower(senders[i]).includes(lower(args.from))) && (!args.text || lower(subjects[i]).includes(lower(args.text)) || lower(senders[i]).includes(lower(args.text))));
  }
  if (args.unread) { const read = f.messages.isRead(); idx = idx.filter(i => !read[i]); }
  idx.sort((a, b) => dates[b] - dates[a]);
  idx = idx.slice(0, Math.max(1, Math.min(args.limit || 20, 100)));
  return JSON.stringify({ mailbox: String(f.name()), items: idx.map(i => { const m = f.messages.byId(ids[i]); const s = m.sender() || {}; let to = []; try { to = m.toRecipients().map(r => r.emailAddress().address); } catch (e) {} return { id: ids[i], from: (s.name ? s.name + " <" + s.address + ">" : s.address || ""), to: to, subject: m.subject(), date: dates[i].toISOString(), unread: !m.isRead() }; }) });
}`;

const READ = `${JXA_PRELUDE}${FOLDER}
function run() {
  const O = Application("Microsoft Outlook");
  const m = O.messages.byId(Number(args.id));
  const s = m.sender() || {};
  let to = [], cc = []; try { to = m.toRecipients().map(r => r.emailAddress().address); } catch (e) {} try { cc = m.ccRecipients().map(r => r.emailAddress().address); } catch (e) {}
  let body = ""; try { body = m.plainTextContent(); } catch (e) { try { body = m.content(); } catch (e2) {} }
  return JSON.stringify({ from: s.name ? s.name + " <" + s.address + ">" : s.address || "", to: to, cc: cc, subject: m.subject(), date: m.timeReceived().toISOString(), unread: !m.isRead(), body: String(body).slice(0, args.max), long: String(body).length > args.max });
}`;

const COMPOSE = `${JXA_PRELUDE}${FOLDER}
function run() {
  const O = Application("Microsoft Outlook");
  const acc = findAccount(O, args.account);
  const msg = O.OutgoingMessage({ subject: args.subject, plainTextContent: args.body, account: acc });
  O.outgoingMessages.push(msg);
  for (const a of args.to) msg.toRecipients.push(O.ToRecipient({ emailAddress: { address: a } }));
  for (const a of args.cc) msg.ccRecipients.push(O.CcRecipient({ emailAddress: { address: a } }));
  for (const a of args.bcc) msg.bccRecipients.push(O.BccRecipient({ emailAddress: { address: a } }));
  if (args.open) { msg.open(); O.activate(); return JSON.stringify({ ok: "opened" }); }
  msg.send();
  return JSON.stringify({ ok: "sent" });
}`;

export class Outlook implements MailConnector {
  readonly app = "outlook" as const;
  readonly label = "Outlook (classic)";
  constructor(private readonly run: ScriptRunner = runOsascript) {}

  async available() {
    if (process.platform !== "darwin") return { ok: false, reason: "Outlook can only be scripted on a Mac." };
    if (!fs.existsSync(APP_PATH)) return { ok: false, reason: "Outlook isn’t installed." };
    return { ok: true };
  }

  #script(script: string, args: unknown, timeoutMs = 60_000) {
    return this.run(script, args, { language: "JavaScript", app: "Outlook", timeoutMs });
  }

  async accounts(): Promise<MailAccount[]> {
    let raw: { id: string; name: string; type: string; emails: string[]; fullName: string }[];
    try {
      raw = JSON.parse(await this.#script(ACCOUNTS, null, 30_000));
    } catch (e) {
      if (/-1708|doesn.t understand/i.test(String((e as Error).message))) throw new Error("This is the new Outlook, which can’t be scripted. Add the account to Apple Mail instead, or switch Outlook back to classic.");
      throw e;
    }
    return raw.map((a) => ({ key: `outlook:${a.id}`, app: "outlook", name: a.name, emails: a.emails.map((e) => e.toLowerCase()), ...(a.fullName ? { fullName: a.fullName } : {}), provider: guessProvider(a.type, a.emails, a.name), enabled: true }));
  }

  async list(q: MailQuery): Promise<MailSummary[]> {
    const id = q.account.replace(/^outlook:/, "");
    const res = JSON.parse(await this.#script(LIST, { ...q, account: id }, 90_000)) as { error: string } | { mailbox: string; items: { id: number; from: string; to: string[]; subject: string; date: string; unread: boolean }[] };
    if ("error" in res) throw new Error(`There’s no “${q.mailbox}” folder in that Outlook account.`);
    return res.items.map((m) => ({ ref: encodeRef({ app: "outlook", account: id, mailbox: res.mailbox, id: m.id }), account: q.account, mailbox: res.mailbox, from: m.from, to: m.to, subject: m.subject, date: m.date, unread: m.unread }));
  }

  async read(ref: string): Promise<MailMessage> {
    const r = decodeRef(ref);
    const m = JSON.parse(await this.#script(READ, { id: r.id, max: 60_000 })) as { from: string; to: string[]; cc: string[]; subject: string; date: string; unread: boolean; body: string; long: boolean };
    return { ref, account: `outlook:${r.account}`, mailbox: r.mailbox, from: m.from, to: m.to, cc: m.cc, subject: m.subject, date: m.date, unread: m.unread, body: m.body, truncated: m.long };
  }

  async send(m: Outgoing): Promise<void> {
    await this.#script(COMPOSE, { ...m, open: false, account: m.account.replace(/^outlook:/, "") });
  }

  async open(m: Outgoing): Promise<void> {
    await this.#script(COMPOSE, { ...m, open: true, account: m.account.replace(/^outlook:/, "") });
  }
}
