import path from "node:path";
import { randomBytes } from "node:crypto";
import { readJson, writeJsonAtomic } from "../core/fsx.ts";
import { isValidSpaceId, vaultStateDir } from "../core/vault.ts";
import { Refusal } from "../rpc/registry.ts";
import { describeCron, parseCron, toCron } from "./cron.ts";

/**
 * The person's own schedules: a prompt run in a space on a schedule, each run
 * a new conversation there. `<vault>/.phaethon/schedules.json`. One the agent
 * suggests starts off and runs only once the person turns it on.
 */

export type Schedule = {
  id: string;
  space: string;
  title: string;
  prompt: string;
  /** Five-field cron, local time. */
  cron: string;
  enabled: boolean;
  created: number;
  updated: number;
  /** Who made it: the person in Settings, or the agent (off until turned on). */
  origin: "user" | "agent";
};

const MAX = 50;
const isScheduleId = (id: unknown): id is string => typeof id === "string" && /^s_[a-z0-9]{6,32}$/.test(id);

export function schedulesFile(): string {
  return path.join(vaultStateDir(), "schedules.json");
}

function parse(raw: unknown): Schedule | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!isScheduleId(o.id) || !isValidSpaceId(o.space) || typeof o.title !== "string" || typeof o.prompt !== "string" || typeof o.cron !== "string") return null;
  try {
    parseCron(o.cron);
  } catch {
    return null;
  }
  const now = Date.now();
  return {
    id: o.id,
    space: o.space,
    title: o.title.slice(0, 120),
    prompt: o.prompt.slice(0, 8000),
    cron: o.cron,
    enabled: o.enabled === true,
    created: typeof o.created === "number" ? o.created : now,
    updated: typeof o.updated === "number" ? o.updated : now,
    origin: o.origin === "agent" ? "agent" : "user",
  };
}

export function readSchedules(): Schedule[] {
  try {
    const doc = readJson<{ schedules?: unknown[] }>(schedulesFile(), { schedules: [] });
    return (Array.isArray(doc.schedules) ? doc.schedules : []).map(parse).filter((s): s is Schedule => s !== null);
  } catch {
    return [];
  }
}

function write(list: Schedule[]): void {
  writeJsonAtomic(schedulesFile(), { version: 1, schedules: list }, { newline: true });
}

export type ScheduleInput = { space: string; title: string; prompt: string; when: string; enabled?: boolean };

function check(i: ScheduleInput): { title: string; prompt: string; cron: string } {
  if (!isValidSpaceId(i.space)) throw new Refusal("That isn’t a space.");
  const title = String(i.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const prompt = String(i.prompt ?? "").trim().slice(0, 8000);
  if (!title) throw new Refusal("A schedule needs a name.");
  if (!prompt) throw new Refusal("A schedule needs something to do.");
  let cron: string;
  try {
    cron = toCron(String(i.when ?? ""));
  } catch (e) {
    throw new Refusal(`That schedule isn’t one Phaethon understands: ${(e as Error).message}`);
  }
  return { title, prompt, cron };
}

export function addSchedule(i: ScheduleInput, origin: Schedule["origin"]): Schedule {
  const list = readSchedules();
  if (list.length >= MAX) throw new Refusal(`At most ${MAX} schedules.`);
  const c = check(i);
  const now = Date.now();
  const s: Schedule = { id: `s_${now.toString(36)}${randomBytes(3).toString("hex")}`, space: i.space, ...c, enabled: origin === "user" ? i.enabled !== false : false, created: now, updated: now, origin };
  list.push(s);
  write(list);
  return s;
}

export function updateSchedule(id: string, patch: Partial<ScheduleInput> & { enabled?: boolean }): Schedule {
  const list = readSchedules();
  const s = list.find((x) => x.id === id);
  if (!s) throw new Refusal("That schedule no longer exists.");
  const c = check({ space: patch.space ?? s.space, title: patch.title ?? s.title, prompt: patch.prompt ?? s.prompt, when: patch.when ?? s.cron });
  Object.assign(s, c, { space: patch.space ?? s.space, enabled: patch.enabled ?? s.enabled, updated: Date.now() });
  write(list);
  return s;
}

export function removeSchedule(id: string): boolean {
  const list = readSchedules();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return false;
  write(next);
  return true;
}

export function describeSchedule(s: Schedule): string {
  return describeCron(s.cron);
}
