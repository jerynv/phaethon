/**
 * Typed calls for memory, people, mail and automations (docs/MEMORY-MAIL-AUTOMATIONS.md):
 * Settings › Memory, People, Mail & connectors, Automations, and the draft card in chat.
 */
import { invoke } from "@/lib/core";
import { invalidate } from "@/lib/query";

/** A write: once it succeeds, every cached read under `prefix` refreshes (lib/query.ts). */
function write<T>(prefix: string | string[], p: Promise<T>): Promise<T> {
  return p.then((v) => {
    for (const x of Array.isArray(prefix) ? prefix : [prefix]) invalidate(x);
    return v;
  });
}

// ---- Memory -------------------------------------------------------------------

export type MemoryKind = "event" | "state" | "task" | "note";
export type MemoryStatus = "active" | "done" | "expired" | "dismissed";
export type MemoryItem = {
  id: string;
  kind: MemoryKind;
  text: string;
  why?: string;
  space: string;
  scope: "space" | "vault";
  created: number;
  updated: number;
  when?: number;
  until?: number;
  status: MemoryStatus;
  outcome?: string;
  closed?: number;
  keywords: string[];
  people: string[];
  source?: { space: string; thread: string };
  origin: "agent" | "user" | "review";
};
export type MemorySettings = {
  capture: boolean;
  review: boolean;
  shareAcrossSpaces: boolean;
  profileLearning: boolean;
  eventGraceDays: number;
  archiveDays: number;
  isolatedSpaces: string[];
};
/** A profile as the editor shows it: the person's own words, and the lines agents added (listed apart). */
export type ProfileDoc = { mine: string; exists: boolean; noticed: string[] };
export type Preview = { id: string; text: string; kind: MemoryKind; score: number; reasons: string[] };

export const memorySettings = () => invoke<MemorySettings>("memory_settings_get");
export const setMemorySettings = (patch: Partial<MemorySettings>) => write("memory:settings", invoke<MemorySettings>("memory_settings_set", { patch }));
export const memoryItems = (opts: { space?: string; includeClosed?: boolean } = {}) => invoke<MemoryItem[]>("memory_items", opts);
export const addMemory = (a: { space: string; kind: MemoryKind; text: string; why?: string; when?: string; until?: string; scope?: "space" | "vault" }) => write("memory:items", invoke<MemoryItem>("memory_item_add", a));
export const updateMemory = (id: string, patch: { text?: string; why?: string | null; status?: MemoryStatus; outcome?: string | null; when?: string | null; until?: string | null; scope?: "space" | "vault" }) => write("memory:items", invoke<MemoryItem>("memory_item_update", { id, patch }));
export const deleteMemory = (id: string) => write("memory:items", invoke<boolean>("memory_item_delete", { id }));
export const previewMemory = (space: string, text: string) => invoke<Preview[]>("memory_preview", { space, text });
export const getProfiles = (space?: string) => invoke<{ vault: ProfileDoc; space?: ProfileDoc }>("profile_get", space ? { space } : {});
/** `scope` is "vault" or a space id. */
export const setProfile = (scope: string, text: string) => write("memory:profile", invoke<ProfileDoc>("profile_set", { scope, text }));
export const removeNotice = (scope: string, notice: string) => write("memory:profile", invoke<boolean>("profile_notice_remove", { scope, notice }));

// ---- People -------------------------------------------------------------------

export type Interaction = {
  at: number;
  channel: "email" | "chat" | "meeting" | "call" | "message" | "other";
  direction?: "in" | "out";
  summary: string;
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
  spaces: string[];
  notes: string[];
  interactions: Interaction[];
  created: number;
  updated: number;
  source: "user" | "agent" | "mail" | "review";
};
export type PersonListed = Person & { interactionCount: number };

export const listPeople = (space?: string) => invoke<PersonListed[]>("people_list", space ? { space } : {});
export const getPerson = (id: string) => invoke<Person>("person_get", { id });
export const createPerson = (name: string, space: string) => write("people:", invoke<Person>("person_create", { name, space }));
export const savePerson = (person: Person) => write("people:", invoke<Person>("person_save", { person }));
export const deletePerson = (id: string) => write("people:", invoke<boolean>("person_delete", { id }));

// ---- Mail ---------------------------------------------------------------------

export type MailApp = "apple-mail" | "outlook" | "fake";
export type MailProvider = "icloud" | "gmail" | "outlook" | "exchange" | "yahoo" | "school" | "other";
export type MailAccount = { key: string; app: MailApp; name: string; emails: string[]; fullName?: string; provider: MailProvider; enabled: boolean };
export type MailSettings = {
  connectors: Partial<Record<MailApp, boolean>>;
  access: Record<string, string[]>;
  known: MailAccount[];
  allowSend: boolean;
  sendDelaySeconds: number;
  indexForPeople: boolean;
  addPeopleFromMail: boolean;
};
export type MailAppView = { app: MailApp; label: string; enabled: boolean; ok: boolean; reason?: string };
export type MailView = { settings: MailSettings; apps: MailAppView[]; delays: number[]; spaces: string[] };

export const mailSettings = () => invoke<MailView>("mail_settings_get");
export const setMailSettings = (patch: Partial<Pick<MailSettings, "allowSend" | "sendDelaySeconds" | "indexForPeople" | "addPeopleFromMail">>) => write("mail:settings", invoke<MailSettings>("mail_settings_set", { patch }));
export const setConnector = (app: MailApp, enabled: boolean) => write("mail:", invoke<{ accounts: MailAccount[]; errors: { app: MailApp; message: string }[] }>("mail_connector_set", { app, enabled }));
export const refreshAccounts = () => write("mail:", invoke<{ accounts: MailAccount[]; errors: { app: MailApp; message: string }[] }>("mail_accounts_refresh"));
export const setAccountSpaces = (account: string, spaces: string[]) => write("mail:", invoke<MailSettings>("mail_access_set", { account, spaces }));
export const getShortcuts = (space?: string) => invoke<{ names: string[]; error?: string; allowed: string[] | Record<string, string[]> }>("shortcuts_get", space ? { space } : {});
export const setAllowedShortcuts = (space: string, names: string[]) => write("mail:shortcuts", invoke<{ allowed: Record<string, string[]> }>("shortcuts_allowed_set", { space, names }));

export type DraftStatus = "draft" | "scheduled" | "sending" | "sent" | "opened" | "discarded" | "failed";
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
  intent: "draft" | "send";
  status: DraftStatus;
  sendAt?: number;
  sentAt?: number;
  created: number;
  updated: number;
  note?: string;
  error?: string;
  review?: { tone: string; summary: string; issues: string[]; at: number };
  key?: string;
  missing?: string[];
};
export type DraftPatch = Partial<Pick<Draft, "account" | "to" | "cc" | "bcc" | "subject" | "body">>;

export const getDraft = (space: string, id: string) => invoke<Draft>("mail_draft_get", { space, id });
export const draftForBlock = (space: string, code: string, thread?: string) => invoke<Draft>("mail_draft_for_block", { space, code, ...(thread ? { thread } : {}) });
export const accountsFor = (space: string) => invoke<MailAccount[]>("mail_accounts_for", { space });
export const updateDraft = (space: string, id: string, patch: DraftPatch) => invoke<Draft>("mail_draft_update", { space, id, patch });
export const sendDraft = (space: string, id: string, now = false) => invoke<Draft>("mail_draft_send", { space, id, now });
export const stopDraft = (space: string, id: string) => invoke<Draft>("mail_draft_stop", { space, id });
export const discardDraft = (space: string, id: string) => invoke<Draft>("mail_draft_discard", { space, id });
export const openDraft = (space: string, id: string) => invoke<Draft>("mail_draft_open", { space, id });
export const reviewDraft = (space: string, id: string) => invoke<Draft>("mail_draft_review", { space, id });
export const rewriteDraft = (space: string, id: string, instruction: string) => invoke<Draft>("mail_draft_rewrite", { space, id, instruction });

// ---- Automations ----------------------------------------------------------------

export type Ready = { ok: true } | { ok: false; reason: string };
export type JobView = {
  id: string;
  title: string;
  description: string;
  cron: string;
  enabled: boolean;
  optional: boolean;
  ready: Ready;
  running: boolean;
  next: number | null;
  lastRun?: number;
  lastOk?: boolean;
  lastResult?: string;
  lastError?: string;
};
export type Schedule = { id: string; space: string; title: string; prompt: string; cron: string; enabled: boolean; created: number; updated: number; origin: "user" | "agent"; when: string };
export type DigestSettings = { spaces: string[]; time: string };

export const listJobs = () => invoke<JobView[]>("jobs_list");
export const setJobEnabled = (id: string, enabled: boolean) => write("jobs:", invoke<JobView[]>("job_set_enabled", { id, enabled }));
export const runJob = (id: string) => write("jobs:", invoke<{ result: string }>("job_run", { id }));
export const listSchedules = () => invoke<Schedule[]>("schedules_list");
export const saveSchedule = (s: { id?: string; space: string; title: string; prompt: string; when: string; enabled?: boolean }) => write("jobs:", invoke<Schedule>("schedule_save", s));
export const setScheduleEnabled = (id: string, enabled: boolean) => write("jobs:", invoke<Schedule>("schedule_set_enabled", { id, enabled }));
export const deleteSchedule = (id: string) => write("jobs:", invoke<boolean>("schedule_delete", { id }));
export const runScheduleNow = (id: string) => write("jobs:", invoke<{ thread: string; summary: string }>("schedule_run_now", { id }));
export const describeSchedule = (when: string) => invoke<{ ok: boolean; cron?: string; text: string }>("schedule_describe", { when });
export const getDigest = () => invoke<DigestSettings>("digest_get");
export const setDigest = (d: DigestSettings) => write("jobs:", invoke<DigestSettings>("digest_set", d));
