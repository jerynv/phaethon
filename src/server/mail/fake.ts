import fs from "node:fs";
import { decodeRef, encodeRef, guessProvider, pickMailbox, type MailAccount, type MailConnector, type MailMessage, type MailQuery, type MailSummary, type Outgoing } from "./types.ts";

/**
 * A scripted mail app for tests, used only when PHAETHON_FAKE_MAIL names a
 * JSON file:
 *
 *   { "accounts": [{ "id": "work", "name": "Work", "emails": ["me@corp.com"], "fullName": "Me", "type": "exchange" }],
 *     "messages": [{ "account": "work", "mailbox": "INBOX", "id": 1, "from": "Dana <dana@corp.com>", "to": ["me@corp.com"],
 *                    "subject": "…", "date": "2026-10-01T15:00:00Z", "body": "…", "unread": false }],
 *     "failSend": false }
 *
 * Sends append to `<file>.sent.jsonl`, opened compose windows to `<file>.opened.jsonl`.
 */

type FakeAccount = { id: string; name: string; emails: string[]; fullName?: string; type?: string };
type FakeMessage = { account: string; mailbox: string; id: number; from: string; to: string[]; cc?: string[]; subject: string; date: string; body: string; unread?: boolean };
type Script = { accounts: FakeAccount[]; messages: FakeMessage[]; failSend?: boolean };

export function fakeMailPath(): string | undefined {
  return process.env.PHAETHON_FAKE_MAIL || undefined;
}

export class FakeMail implements MailConnector {
  readonly app = "fake" as const;
  readonly label = "Test mail";
  constructor(private readonly file: string) {}

  #read(): Script {
    const s = JSON.parse(fs.readFileSync(this.file, "utf8")) as Script;
    return { accounts: s.accounts ?? [], messages: s.messages ?? [], failSend: s.failSend };
  }

  async available() {
    return { ok: true };
  }

  async accounts(): Promise<MailAccount[]> {
    return this.#read().accounts.map((a) => ({
      key: `fake:${a.id}`,
      app: "fake",
      name: a.name,
      emails: a.emails,
      ...(a.fullName ? { fullName: a.fullName } : {}),
      provider: guessProvider(a.type ?? "", a.emails, a.name),
      enabled: true,
    }));
  }

  async list(q: MailQuery): Promise<MailSummary[]> {
    const id = q.account.replace(/^fake:/, "");
    const s = this.#read();
    const names = [...new Set(s.messages.filter((m) => m.account === id).map((m) => m.mailbox))];
    const box = pickMailbox(names.length ? names : ["INBOX"], q.mailbox) ?? q.mailbox;
    const since = q.since ? Date.parse(q.since) : 0;
    const lower = (x: string) => x.toLowerCase();
    return s.messages
      .filter((m) => m.account === id && m.mailbox === box && Date.parse(m.date) >= since)
      .filter((m) => !q.from || lower(m.from).includes(lower(q.from)))
      .filter((m) => !q.text || lower(m.subject).includes(lower(q.text)) || lower(m.from).includes(lower(q.text)))
      .filter((m) => !q.unread || m.unread)
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
      .slice(0, q.limit)
      .map((m) => ({ ref: encodeRef({ app: "fake", account: id, mailbox: box, id: m.id }), account: q.account, mailbox: box, from: m.from, to: m.to, subject: m.subject, date: m.date, unread: !!m.unread }));
  }

  async read(ref: string): Promise<MailMessage> {
    const r = decodeRef(ref);
    const m = this.#read().messages.find((x) => x.account === r.account && x.mailbox === r.mailbox && String(x.id) === r.id);
    if (!m) throw new Error("That message is no longer in Mail.");
    return { ref, account: `fake:${r.account}`, mailbox: r.mailbox, from: m.from, to: m.to, cc: m.cc ?? [], subject: m.subject, date: m.date, unread: !!m.unread, body: m.body, truncated: false };
  }

  async send(m: Outgoing): Promise<void> {
    if (this.#read().failSend) throw new Error("Mail didn’t send the message. Check that the account is online in Mail.");
    fs.appendFileSync(`${this.file}.sent.jsonl`, `${JSON.stringify({ ...m, at: Date.now() })}\n`);
  }

  async open(m: Outgoing): Promise<void> {
    fs.appendFileSync(`${this.file}.opened.jsonl`, `${JSON.stringify({ ...m, at: Date.now() })}\n`);
  }
}
