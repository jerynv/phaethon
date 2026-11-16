import { commands, messageOf, Refusal } from "../rpc/registry.ts";
import { isValidSpaceId } from "../core/vault.ts";
import { onStart, onStop } from "../lifecycle.ts";
import { log } from "../log.ts";
import { completeText } from "../providers/complete.ts";
import { listSpaces } from "../spaces/meta.ts";
import { describePerson, findByEmail } from "../people/people.ts";
import { profilesForPrompt } from "../memory/profile.ts";
import { describeItem, itemsFor } from "../memory/items.ts";
import { selectRelevant } from "../memory/relevance.ts";
import { allowedShortcuts, listShortcuts, readShortcutsSettings, setAllowedShortcuts } from "../shortcuts/shortcuts.ts";
import { SEND_DELAYS, connector, offeredApps, readMailSettings, refreshAccounts, updateMailSettings, type MailSettings } from "./access.ts";
import { MANUAL_DELAY_SECONDS, discardDraft, disarmAll, listDrafts, openDraft, readDraft, recoverOutbox, sendDraft, setReview, stopSend, updateDraft, type Draft, type DraftFields } from "./outbox.ts";
import type { MailApp } from "./types.ts";
import { accountsFor } from "./access.ts";
import { draftForBlock } from "./block.ts";
import { appIcon } from "./app-icons.ts";

/** Settings › Mail & connectors, and the draft card's buttons. */

async function appsView() {
  const s = readMailSettings();
  const out = [];
  for (const app of offeredApps()) {
    let available = { ok: false, reason: "Unknown" } as { ok: boolean; reason?: string };
    try {
      available = await connector(app).available();
    } catch (e) {
      available = { ok: false, reason: messageOf(e) };
    }
    out.push({ app, label: connector(app).label, enabled: s.connectors[app] === true, ...available });
  }
  return out;
}

function spaceIds(): string[] {
  try {
    return listSpaces().map((s) => s.id);
  } catch {
    return [];
  }
}

const REVIEW_SYSTEM = `You check an email before it is sent, for the person sending it. Reply with one JSON object and nothing else:
{"tone":"two to four words for how it reads, e.g. Warm, brief","summary":"one sentence on what it asks or says","issues":["…"]}
Issues are only real problems a careful friend would flag: the wrong person or address for what it says, a name or date that contradicts the context, a promised attachment that isn't there, a tone that doesn't fit the relationship, something unclear, a typo. At most four, each one short sentence. An empty list when it is ready to send.`;

const REWRITE_SYSTEM = `You rewrite the body of an email as asked, in the sender's own voice. Keep every fact, date, name and commitment; keep the greeting and sign-off style unless asked otherwise. Reply with the new body only: no subject line, no quotes, no commentary.`;

function draftContext(d: Draft): string {
  const parts: string[] = [];
  const profile = profilesForPrompt(d.space);
  if (profile) parts.push(profile);
  const people = [...d.to, ...d.cc].map((a) => findByEmail(a)).filter((p) => !!p);
  if (people.length) parts.push(`# Recipients Phaethon knows\n\n${people.map((p) => describePerson(p!, 6)).join("\n\n")}`);
  const now = Date.now();
  const picked = selectRelevant(itemsFor(d.space), { text: `${d.subject}\n${d.body}`, now });
  if (picked.length) parts.push(`# On the person's front burner\n\n${picked.map((p) => `- ${describeItem(p.item, now)}`).join("\n")}`);
  parts.push(`It is now ${new Date(now).toString()}.`);
  return parts.join("\n\n");
}

const emailText = (d: Draft) => `From: ${d.sender}\nTo: ${d.to.join(", ")}${d.cc.length ? `\nCc: ${d.cc.join(", ")}` : ""}\nSubject: ${d.subject}\n\n${d.body}`;

function parseReview(text: string): { tone: string; summary: string; issues: string[] } {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  try {
    const v = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>;
    return {
      tone: typeof v.tone === "string" ? v.tone.slice(0, 60) : "",
      summary: typeof v.summary === "string" ? v.summary.slice(0, 300) : "",
      issues: Array.isArray(v.issues) ? v.issues.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 240)).slice(0, 4) : [],
    };
  } catch {
    throw new Refusal("The review didn’t come back in a form Phaethon could read. Try again.");
  }
}

const space_ = (s: unknown) => {
  if (!isValidSpaceId(s)) throw new Refusal("That isn’t a space.");
  return s;
};

commands({
  mail_settings_get: async () => ({ settings: readMailSettings(), apps: await appsView(), delays: SEND_DELAYS, spaces: spaceIds() }),

  mail_settings_set: ({ patch }: { patch: Partial<Pick<MailSettings, "allowSend" | "sendDelaySeconds" | "indexForPeople" | "addPeopleFromMail">> }) =>
    updateMailSettings((s) => {
      for (const k of ["allowSend", "indexForPeople", "addPeopleFromMail"] as const) if (typeof patch?.[k] === "boolean") s[k] = patch[k]!;
      if (typeof patch?.sendDelaySeconds === "number") s.sendDelaySeconds = patch.sendDelaySeconds;
    }),

  /** Turning a connector on asks the app for its accounts (and macOS for permission, the first time). */
  mail_connector_set: async ({ app, enabled }: { app: MailApp; enabled: boolean }) => {
    if (!offeredApps().includes(app)) throw new Refusal("That mail app isn’t offered here.");
    if (enabled) {
      const a = await connector(app).available();
      if (!a.ok) throw new Refusal(a.reason ?? "That app can’t be used here.");
    }
    updateMailSettings((s) => {
      s.connectors[app] = enabled === true;
    });
    if (!enabled) return { accounts: readMailSettings().known.filter((x) => x.app !== app), errors: [] };
    const r = await refreshAccounts();
    const err = r.errors.find((e) => e.app === app);
    if (err) {
      updateMailSettings((s) => {
        s.connectors[app] = false;
      });
      throw new Refusal(err.message);
    }
    return r;
  },

  mail_accounts_refresh: () => refreshAccounts(),

  mail_access_set: ({ account, spaces }: { account: string; spaces: string[] }) =>
    updateMailSettings((s) => {
      if (!s.known.some((a) => a.key === account)) throw new Refusal("That account isn’t known; refresh the accounts first.");
      const list = (spaces ?? []).filter((x) => isValidSpaceId(x));
      if (list.length) s.access[account] = [...new Set(list)];
      else delete s.access[account];
    }),

  mail_drafts: ({ space }: { space: string }) => listDrafts(space_(space)),
  /** The draft a `phaethon-email` block stands for: found by its fingerprint, or made now (never sent here). */
  mail_draft_for_block: ({ space, code, thread }: { space: string; code: string; thread?: string }) => draftForBlock(space_(space), String(code ?? ""), typeof thread === "string" && /^[0-9-]+$/.test(thread) ? thread : undefined),
  /** The installed app's own icon (Mail, Outlook, Shortcuts) as a data URL, or null. */
  mail_app_icon: async ({ app }: { app: string }) => ({ dataUrl: await appIcon(String(app ?? "")) }),
  /** The accounts a space may send from (the card's From). */
  mail_accounts_for: ({ space }: { space: string }) => accountsFor(space_(space)),
  mail_draft_get: ({ space, id }: { space: string; id: string }) => readDraft(space_(space), id),
  mail_draft_update: ({ space, id, patch }: { space: string; id: string; patch: Partial<DraftFields> }) => updateDraft(space_(space), id, patch ?? {}),
  /** `now` sends at once; otherwise a short undo window. */
  mail_draft_send: ({ space, id, now }: { space: string; id: string; now?: boolean }) => sendDraft(space_(space), id, now ? 0 : MANUAL_DELAY_SECONDS),
  mail_draft_stop: ({ space, id }: { space: string; id: string }) => stopSend(space_(space), id),
  mail_draft_discard: ({ space, id }: { space: string; id: string }) => discardDraft(space_(space), id),
  mail_draft_open: ({ space, id }: { space: string; id: string }) => openDraft(space_(space), id),

  mail_draft_review: async ({ space, id }: { space: string; id: string }, ctx) => {
    const d = readDraft(space_(space), id);
    const reply = await completeText({
      space,
      ...(d.thread ? { thread: d.thread } : {}),
      system: REVIEW_SYSTEM,
      messages: [{ role: "user", content: `${draftContext(d)}\n\n<email>\n${emailText(d)}\n</email>` }],
      effort: "low",
      maxTokens: 800,
      signal: ctx.signal,
    });
    return setReview(space, id, { ...parseReview(reply.text), at: Date.now() });
  },

  mail_draft_rewrite: async ({ space, id, instruction }: { space: string; id: string; instruction: string }, ctx) => {
    const d = readDraft(space_(space), id);
    const ask = String(instruction ?? "").trim().slice(0, 500);
    if (!ask) throw new Refusal("Say how to change it.");
    const reply = await completeText({
      space,
      ...(d.thread ? { thread: d.thread } : {}),
      system: REWRITE_SYSTEM,
      messages: [{ role: "user", content: `${draftContext(d)}\n\n<email>\n${emailText(d)}\n</email>\n\nRewrite the body: ${ask}` }],
      effort: "low",
      maxTokens: 2000,
      signal: ctx.signal,
    });
    const body = reply.text.trim();
    if (!body) throw new Refusal("The rewrite came back empty.");
    return updateDraft(space, id, { body });
  },

  shortcuts_get: async ({ space }: { space?: string }) => {
    let names: string[] = [];
    let error: string | undefined;
    try {
      names = await listShortcuts();
    } catch (e) {
      error = messageOf(e);
    }
    return { names, error, allowed: space ? allowedShortcuts(space) : readShortcutsSettings().allowed };
  },

  shortcuts_allowed_set: ({ space, names }: { space: string; names: string[] }) => setAllowedShortcuts(space_(space), Array.isArray(names) ? names : []),
});

onStart("recover the outbox", () => {
  const r = recoverOutbox(spaceIds());
  if (r.reverted || r.armed) log.info("outbox recovered", r);
});

onStop("stop pending sends", () => disarmAll());
