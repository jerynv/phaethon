import { commands, messageOf, Refusal } from "../rpc/registry.ts";
import { isValidSpaceId } from "../core/vault.ts";
import { setSetting, readSettings } from "../settings/settings.ts";
import { personRefs } from "../people/people.ts";
import { parseTime } from "../agent/tools/life.ts";
import {
  MAX_TEXT,
  MEMORY_KINDS,
  mutateItems,
  newId,
  parseMemorySettings,
  memorySettings,
  readItems,
  type MemoryItem,
  type MemoryKind,
  type MemorySettings,
} from "./items.ts";
import { removeNotice, splitProfile, writeMine, type ProfileScope } from "./profile.ts";
import { selectRelevant } from "./relevance.ts";

/** Settings › Memory: the front burner, its archive, the profiles and what the agent would see. */

const scopeOf = (s: unknown): ProfileScope => {
  if (s === "vault" || s === undefined || s === null) return { kind: "vault" };
  if (!isValidSpaceId(s)) throw new Refusal("That isn’t a space.");
  return { kind: "space", space: s };
};

function text(v: unknown, what: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Refusal(`${what} can’t be empty.`);
  return [...v.replace(/\s+/g, " ").trim()].slice(0, MAX_TEXT).join("");
}

commands({
  memory_settings_get: () => memorySettings(),

  memory_settings_set: ({ patch }: { patch: Partial<MemorySettings> }) => {
    const next = parseMemorySettings({ ...memorySettings(), ...(patch ?? {}) });
    setSetting("memory", next);
    return next;
  },

  memory_items: ({ space, includeClosed }: { space?: string; includeClosed?: boolean }) => {
    const all = readItems();
    return all
      .filter((i) => (!space || i.space === space || i.scope === "vault") && (includeClosed || i.status === "active"))
      // Open first; among them, what has a time in time order, then background notes.
      .sort((a, b) => {
        const t = (i: MemoryItem) => i.when ?? i.until ?? Number.MAX_SAFE_INTEGER;
        return (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || t(a) - t(b) || b.created - a.created;
      });
  },

  memory_item_add: (a: { space: string; kind: MemoryKind; text: string; why?: string; when?: string; until?: string; scope?: "space" | "vault" }) => {
    if (!isValidSpaceId(a.space)) throw new Refusal("That isn’t a space.");
    if (!MEMORY_KINDS.includes(a.kind)) throw new Refusal("Pick a kind.");
    const now = Date.now();
    const when = parseTime(a.when, "When");
    const until = parseTime(a.until, "Until");
    if (a.kind === "event" && when === undefined) throw new Refusal("An event needs a time.");
    const item: MemoryItem = {
      id: newId(),
      kind: a.kind,
      text: text(a.text, "The memory"),
      ...(a.why?.trim() ? { why: text(a.why, "Why") } : {}),
      space: a.space,
      scope: a.scope === "vault" ? "vault" : "space",
      created: now,
      updated: now,
      ...(when !== undefined ? { when } : {}),
      ...(until !== undefined ? { until } : {}),
      status: "active",
      keywords: [],
      people: [],
      origin: "user",
    };
    mutateItems((items) => items.push(item));
    return item;
  },

  memory_item_update: ({ id, patch }: { id: string; patch: { text?: string; why?: string | null; status?: MemoryItem["status"]; outcome?: string | null; when?: string | null; until?: string | null; scope?: "space" | "vault" } }) =>
    mutateItems((items) => {
      const it = items.find((x) => x.id === id);
      if (!it) throw new Refusal("That memory no longer exists.");
      const now = Date.now();
      if (patch.text !== undefined) it.text = text(patch.text, "The memory");
      if (patch.why !== undefined) {
        if (patch.why?.trim()) it.why = text(patch.why, "Why");
        else delete it.why;
      }
      if (patch.outcome !== undefined) {
        if (patch.outcome?.trim()) it.outcome = text(patch.outcome, "Outcome");
        else delete it.outcome;
      }
      for (const k of ["when", "until"] as const) {
        if (patch[k] === undefined) continue;
        if (patch[k] === null || patch[k] === "") delete it[k];
        else it[k] = parseTime(patch[k], k === "when" ? "When" : "Until");
      }
      if (patch.scope) it.scope = patch.scope === "vault" ? "vault" : "space";
      if (patch.status && patch.status !== it.status) {
        it.status = patch.status;
        if (patch.status === "active") delete it.closed;
        else it.closed = now;
      }
      it.updated = now;
      return { ...it };
    }),

  memory_item_delete: ({ id }: { id: string }) =>
    mutateItems((items) => {
      const i = items.findIndex((x) => x.id === id);
      if (i < 0) return false;
      items.splice(i, 1);
      return true;
    }),

  /** What the agent would be shown for a message, and why: the "try it" box in Settings. */
  memory_preview: ({ space, text: message }: { space: string; text: string }) => {
    if (!isValidSpaceId(space)) throw new Refusal("That isn’t a space.");
    const s = memorySettings();
    const items = readItems().filter((i) => i.status === "active" && (i.space === space || (i.scope === "vault" && s.shareAcrossSpaces && !s.isolatedSpaces.includes(space))));
    let refs: ReturnType<typeof personRefs> = [];
    try {
      refs = personRefs(space);
    } catch {
      // none
    }
    return selectRelevant(items, { text: String(message ?? ""), now: Date.now(), people: refs }).map((p) => ({ id: p.item.id, text: p.item.text, kind: p.item.kind, score: Math.round(p.score * 10) / 10, reasons: p.reasons }));
  },

  /** Each profile as the editor shows it: the person's own words, and the agents' lines apart. */
  profile_get: ({ space }: { space?: string }) => {
    try {
      const out: Record<string, unknown> = { vault: splitProfile({ kind: "vault" }) };
      if (space) out.space = splitProfile(scopeOf(space));
      return out;
    } catch (e) {
      throw new Refusal(`The profile couldn’t be read: ${messageOf(e)}`);
    }
  },

  /** Saves the person's own words; the agents' lines stay as they are. */
  profile_set: ({ scope, text: body }: { scope: string; text: string }) => {
    try {
      writeMine(scopeOf(scope), String(body ?? ""));
      return splitProfile(scopeOf(scope));
    } catch (e) {
      throw new Refusal(`The profile couldn’t be saved: ${messageOf(e)}`);
    }
  },

  profile_notice_remove: ({ scope, notice }: { scope: string; notice: string }) => removeNotice(scopeOf(scope), String(notice ?? "")),
});

export const _keep = readSettings;
