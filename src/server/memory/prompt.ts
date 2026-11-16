import { accountsFor } from "../mail/access.ts";
import { describePerson, peopleFor, personRefs } from "../people/people.ts";
import { describeItem, formatWhen, itemsFor, memorySettings } from "./items.ts";
import { peopleNamed, selectRelevant } from "./relevance.ts";

/**
 * The memory part of a turn's system prompt. Only what this message makes
 * relevant goes in: nothing for small talk, the Saturday meeting when the
 * message is about Saturday morning, the boss's card when the message says
 * "my boss". Built once per turn, from the user's latest message and the one
 * before it.
 */

export type TurnContext = { text: string; recent?: string; now?: number };

const HOW =
  "# Memory, people and your tools\n\n" +
  "You have Phaethon's tools for the user's life outside these files: recall, person, remember, update_memory, update_person and note_profile (and mail_search, mail_read and draft_email when this space has a mail account). Use them; don't keep notes in files instead, and never say you have no memory or profile. Phaethon brings back only the memories a message touches (below, when there are any). Keep them accurate as you go:\n" +
  "- When the user tells you how they want you to write or work from now on (\"no em dashes ever\", \"sign as J\", \"keep it short\"), save it at once with note_profile (scope \"user\" for everywhere, \"space\" for here only), then follow it. Don't just promise to.\n" +
  "- When the user mentions an event with a time, a temporary state (sick, travelling, swamped until Friday) or a commitment, save it with remember, with your best estimate of when it ends. Don't announce it; a small note appears under your reply.\n" +
  "- As soon as the user says how something went (attended, missed, moved, done), close it with update_memory and the outcome, so it stops coming up. If they extend a state, move its end.\n" +
  "- Before writing to or about someone (\"my boss\", a name), look them up with person; if they're unknown, search mail for them (mail_search with from or text). When you learn who someone is or find their address, add it with update_person so it's known next time.\n" +
  "- Use recall when the user refers to something earlier that isn't in this conversation, before asking them to repeat it.\n" +
  "- Never save small talk, a one-off remark or vent as a statement, or secrets. If a remark shows a lasting dynamic (with a manager, a teammate), save the underlying why in neutral words, or nothing.\n" +
  "- A memory below is background, not a topic: use it only when it bears on what the user asked, and don't bring it up otherwise.";

function zone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "local time";
  }
}

function offset(now: number): string {
  const m = -new Date(now).getTimezoneOffset();
  const sign = m >= 0 ? "+" : "-";
  const a = Math.abs(m);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

export function nowLine(now: number): string {
  const d = new Date(now);
  const long = new Intl.DateTimeFormat("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
  return `It is now ${long} (${zone()}, UTC${offset(now)}).`;
}


export function memoryPromptSection(space: string, ctx: TurnContext | undefined, opts: { cli?: boolean } = {}): string | undefined {
  const now = ctx?.now ?? Date.now();
  const s = memorySettings();
  const parts: string[] = [];
  // Coding agents get the same tools (Codex as its own tools, Claude Code and Gemini CLI as the "phaethon" MCP server).
  parts.push(s.capture ? (opts.cli ? `${HOW}\n\nThe tools are Phaethon's, offered to you in this conversation (with Claude Code they are named mcp__phaethon__<tool>).` : HOW) : "# Memory\n\nMemory capture is turned off by the user; don't offer to remember things. You can still use recall and person.");
  parts.push(nowLine(now));

  let accounts: ReturnType<typeof accountsFor> = [];
  try {
    accounts = accountsFor(space);
  } catch {
    // no mail
  }
  if (accounts.length) {
    parts.push(
      `Mail accounts this space can use (through the Mail app on the user's computer): ${accounts.map((a) => `${a.name} <${a.emails.join(", ")}>`).join("; ")}. ` +
        "Drafts never send by themselves; a send counts down on screen first and the user can stop it.",
    );
  }

  if (ctx?.text) {
    let refs: ReturnType<typeof personRefs> = [];
    try {
      refs = personRefs(space);
    } catch {
      // no people
    }
    const items = itemsFor(space);
    const picked = selectRelevant(items, { text: ctx.text, recent: ctx.recent, now, people: refs });
    if (picked.length) {
      parts.push(
        "## Possibly relevant right now\n\nPicked because this message seems to touch them. From earlier conversations; ids are for update_memory.\n" +
          picked.map((p) => `- ${describeItem(p.item, now)}${p.item.space !== space ? ` (from the ${p.item.space} space)` : ""} — ${p.reasons[0]}`).join("\n"),
      );
    }
    const named = peopleNamed(ctx.text, refs).slice(0, 2);
    if (named.length) {
      const cards = peopleFor(space).filter((p) => named.includes(p.id));
      if (cards.length) parts.push(`## People this message mentions\n\n${cards.map((p) => describePerson(p, 6)).join("\n\n")}`);
    }
  }
  return parts.join("\n\n");
}

export { formatWhen };
