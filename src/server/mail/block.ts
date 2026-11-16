import { createHash } from "node:crypto";
import { Refusal } from "../rpc/registry.ts";
import { findPeople } from "../people/people.ts";
import { accountsFor, readMailSettings } from "./access.ts";
import { createDraft, draftByKey, namesIn, type Draft } from "./outbox.ts";
import { addressOf, isAddress } from "./types.ts";

/**
 * Emails written as a `phaethon-email` block, which every backend can produce
 * (the coding agents have no draft tool): the chat shows the block as the
 * same email card the draft tool makes. The draft is made the first time the
 * card is shown and found again by the block's fingerprint, so a reload or a
 * second window never makes another, and nothing is sent unless the person
 * presses Send (or the block asked to send and the countdown runs out).
 */

export const EMAIL_FENCE = "phaethon-email";

export type EmailBlock = { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; account?: string; send: boolean };

const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : []).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 50);

export function parseEmailBlock(code: string): EmailBlock {
  let v: unknown;
  try {
    v = JSON.parse(code);
  } catch {
    throw new Refusal("That email block isn’t valid JSON.");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Refusal("That email block isn’t a JSON object.");
  const o = v as Record<string, unknown>;
  const body = typeof o.body === "string" ? o.body : "";
  const subject = typeof o.subject === "string" ? o.subject : "";
  if (!body.trim() && !subject.trim()) throw new Refusal("That email block has no subject or message.");
  return { to: list(o.to), cc: list(o.cc), bcc: list(o.bcc), subject, body, ...(typeof o.account === "string" && o.account.trim() ? { account: o.account.trim() } : {}), send: o.send === true };
}

export const blockKey = (code: string) => createHash("sha256").update(code.trim()).digest("hex").slice(0, 24);

/** Addresses stay; a name becomes the address on that person's card, or is reported missing. */
export function resolveRecipients(space: string, names: string[]): { addresses: string[]; missing: string[] } {
  const addresses: string[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const a = addressOf(n);
    if (isAddress(a)) {
      addresses.push(a);
      continue;
    }
    const p = findPeople(space, n.replace(/<.*>/, "").trim())[0];
    if (p?.emails[0]) addresses.push(p.emails[0]);
    else missing.push(n.replace(/<.*>/, "").trim());
  }
  return { addresses: [...new Set(addresses)], missing };
}

export function draftForBlock(space: string, code: string, thread?: string): Draft {
  const key = blockKey(code);
  const found = draftByKey(space, key);
  if (found) return found;
  const b = parseEmailBlock(code);
  if (!accountsFor(space).length) throw new Refusal("No mail account is set up for this space yet.");
  const names = namesIn([b.to, b.cc, b.bcc]);
  const to = resolveRecipients(space, b.to);
  const cc = resolveRecipients(space, b.cc);
  const bcc = resolveRecipients(space, b.bcc);
  let account = b.account;
  if (account && !accountsFor(space).some((a) => a.key === account || a.name.toLowerCase() === account!.toLowerCase() || a.emails.includes(account!.toLowerCase()))) account = undefined;
  if (!account && accountsFor(space).length > 1) account = accountsFor(space)[0]!.key;
  return createDraft(
    space,
    { ...(account ? { account } : {}), to: to.addresses, cc: cc.addresses, bcc: bcc.addresses, subject: b.subject, body: b.body },
    { intent: b.send && readMailSettings().allowSend ? "send" : "draft", key, missing: [...to.missing, ...cc.missing, ...bcc.missing], names, ...(thread ? { thread } : {}) },
  );
}

/** What the agent is told about the block. */
export function emailBlockPrompt(space: string): string {
  let accounts: ReturnType<typeof accountsFor> = [];
  try {
    accounts = accountsFor(space);
  } catch {
    // none
  }
  const where = accounts.length
    ? `It sends from this space's account${accounts.length > 1 ? "s" : ""}: ${accounts.map((a) => `${a.name} <${a.emails.join(", ")}>`).join("; ")}${accounts.length > 1 ? ' (pick one with "account", or the first is used)' : ""}.`
    : "This space has no mail account yet; the card offers to set one up and lets the user copy the email meanwhile.";
  return `# Emails

When the user asks you to write, draft, reply to or send an email, don't write the email as text in your reply. Put it in one \`\`\`${EMAIL_FENCE} block, with a short sentence before it:

\`\`\`${EMAIL_FENCE}
{"to": ["Dana Reyes"], "cc": [], "subject": "Running late", "body": "Hi Dana,\\n\\nI'm running about 15 minutes late.\\n\\nThanks,\\nJeryn", "send": false}
\`\`\`

The app shows it as an email card the user can edit, with Send and Open in Mail. ${where} "to" takes addresses or names; a name is looked up in the user's people, and the card asks for any address it can't find, so never invent one. The body is plain text with the greeting and sign-off, in the user's voice. Set "send": true only when the user asked you to send it: the card then counts down and sends unless they stop it, so say it will go unless they stop it, never that it was sent. One block per email.`;
}
