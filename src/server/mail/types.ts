/**
 * Mail through apps already on the computer. A connector is one app (Apple
 * Mail, Outlook); it lists the accounts the person added there and reads and
 * sends through them, so an account a workplace or school won't let a
 * third-party app sign into still works.
 */

export type MailApp = "apple-mail" | "outlook" | "fake";

/** A guess from the account's type and addresses, for the mark shown beside it. */
export type MailProvider = "icloud" | "gmail" | "outlook" | "exchange" | "yahoo" | "school" | "other";

export type MailAccount = {
  /** `<app>:<the app's account id>`; stable while the account stays in the app. */
  key: string;
  app: MailApp;
  name: string;
  emails: string[];
  fullName?: string;
  provider: MailProvider;
  enabled: boolean;
};

export type MailSummary = {
  /** Opaque: what `mail_read` takes. */
  ref: string;
  account: string;
  mailbox: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  unread: boolean;
};

export type MailMessage = MailSummary & { cc: string[]; body: string; messageId?: string; truncated: boolean };

export type MailQuery = {
  account: string;
  /** "inbox", "sent", "drafts", "archive", "junk", "trash" or a mailbox's own name. */
  mailbox: string;
  /** ISO time; only mail received after it. */
  since?: string;
  from?: string;
  /** Matches the subject or the sender. */
  text?: string;
  unread?: boolean;
  limit: number;
};

export type Outgoing = {
  account: string;
  /** "Full Name <address>", chosen from the account. */
  sender: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** A message to reply to (its ref). */
  replyTo?: string;
};

export interface MailConnector {
  readonly app: MailApp;
  readonly label: string;
  /** Whether it can be used on this computer at all (installed, right platform). */
  available(): Promise<{ ok: boolean; reason?: string }>;
  accounts(): Promise<MailAccount[]>;
  list(q: MailQuery): Promise<MailSummary[]>;
  read(ref: string): Promise<MailMessage>;
  send(m: Outgoing): Promise<void>;
  /** Opens a compose window filled in, for the person to finish in the app. */
  open(m: Outgoing): Promise<void>;
}

const SCHOOL = /\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/i;

export function guessProvider(type: string, emails: string[], name = ""): MailProvider {
  const t = type.toLowerCase();
  const domains = emails.map((e) => e.split("@")[1]?.toLowerCase() ?? "");
  if (t.includes("icloud") || domains.some((d) => /^(icloud|me|mac)\.com$/.test(d))) return "icloud";
  if (domains.some((d) => d === "gmail.com" || d === "googlemail.com") || /google|gmail/i.test(name)) return "gmail";
  if (domains.some((d) => /^(outlook|hotmail|live|msn)\.com$/.test(d))) return "outlook";
  if (domains.some((d) => /^(yahoo|ymail)\./.test(d))) return "yahoo";
  // A school account on Exchange is an Exchange account (its mark says who runs the mail).
  if (t.includes("exchange") || t === "ews" || /exchange|office|microsoft/i.test(name)) return "exchange";
  if (domains.some((d) => SCHOOL.test(d))) return "school";
  return "other";
}

/** Refs carry where a message lives; they are opaque to the model. */
export function encodeRef(r: { app: MailApp; account: string; mailbox: string; id: string | number }): string {
  return Buffer.from(JSON.stringify([r.app, r.account, r.mailbox, String(r.id)])).toString("base64url");
}

export function decodeRef(ref: string): { app: MailApp; account: string; mailbox: string; id: string } {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(ref, "base64url").toString("utf8"));
  } catch {
    throw new Error("That isn’t a message reference from mail_search.");
  }
  if (!Array.isArray(v) || v.length !== 4 || !v.every((x) => typeof x === "string")) throw new Error("That isn’t a message reference from mail_search.");
  const [app, account, mailbox, id] = v as string[];
  if (app !== "apple-mail" && app !== "outlook" && app !== "fake") throw new Error("That isn’t a message reference from mail_search.");
  return { app, account: account!, mailbox: mailbox!, id: id! };
}

export const MAILBOX_NAMES: Record<string, string[]> = {
  inbox: ["inbox"],
  sent: ["sent messages", "sent mail", "sent items", "sent"],
  drafts: ["drafts"],
  archive: ["archive", "all mail"],
  junk: ["junk", "spam", "junk email", "junk e-mail"],
  trash: ["deleted messages", "trash", "deleted items", "bin"],
};

/** The mailbox a query means, among an account's mailbox names. */
export function pickMailbox(names: string[], want: string): string | undefined {
  const w = want.trim().toLowerCase() || "inbox";
  for (const alias of MAILBOX_NAMES[w] ?? []) {
    const hit = names.find((n) => n.toLowerCase() === alias);
    if (hit) return hit;
  }
  return names.find((n) => n.toLowerCase() === w);
}

/** "Name <a@b.c>" → "a@b.c"; a bare address stays. */
export function addressOf(s: string): string {
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1]! : s).trim().toLowerCase();
}

export function nameOf(s: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*</.exec(s);
  return (m?.[1] ?? "").trim();
}

const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
export const isAddress = (s: string) => ADDRESS.test(s.trim());
