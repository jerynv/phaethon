import { isValidSpaceId, spaceDir } from "../core/vault.ts";
import { readSettings, setSettings } from "../settings/settings.ts";
import { listThreadsIn, readMetaIn, updateMetaIn } from "../threads/store.ts";
import { log } from "../log.ts";

/**
 * Letting the agent write files without an approval card each time. The
 * walls stay: `write_file` still resolves inside its own space only (no
 * absolute paths, no `..`, no links out, `.phaethon/` hidden), and another
 * space is never writable. What the person can skip is the question:
 *
 * - for one conversation: `allowWrites` (when, in ms) in its `threads/<id>.meta`;
 * - for a whole space: `allowWrites.<space>` (when) in the vault's settings.json.
 *
 * Both are visible, hand-editable files and both can be taken back in
 * Settings (`write_permission_set` with `allow: false`).
 */

export type WriteScope = "conversation" | "space";

function spaceMap(): Record<string, number> {
  const raw = readSettings().allowWrites;
  // No prototype: a space named like an Object method ("constructor") must not read as allowed.
  const out: Record<string, number> = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [space, at] of Object.entries(raw as Record<string, unknown>)) {
    if (isValidSpaceId(space) && typeof at === "number" && Number.isFinite(at) && at > 0) out[space] = Math.floor(at);
  }
  return out;
}

/** When writes were allowed for the whole space, if they are. */
export function spaceAllowsWrites(space: string): number | undefined {
  const map = spaceMap();
  return Object.hasOwn(map, space) ? map[space] : undefined;
}

/** Why a write in `space`'s conversation `thread` needs no question, or null when it does. */
export function writesAllowed(space: string, thread: string): WriteScope | null {
  if (spaceAllowsWrites(space)) return "space";
  try {
    if (readMetaIn(spaceDir(space), thread).allowWrites) return "conversation";
  } catch {
    // An unreadable meta file asks again.
  }
  return null;
}

/** Allows (or takes back) writing without asking, for one conversation or for its whole space. */
export function setWritesAllowed(space: string, thread: string | null, scope: WriteScope, allow: boolean): void {
  if (scope === "space") {
    const map = spaceMap();
    if (allow) map[space] = Object.hasOwn(map, space) ? map[space]! : Date.now();
    else delete map[space];
    setSettings({ allowWrites: Object.keys(map).length ? { ...map } : undefined });
    return;
  }
  if (thread === null) throw new Error("no conversation named");
  updateMetaIn(spaceDir(space), thread, { allowWrites: allow ? Date.now() : null });
}

export type WritePermissions = {
  /** Spaces where Phaethon writes without asking. */
  spaces: { space: string; since: number }[];
  /** Conversations of `space` that write without asking. */
  conversations: { thread: string; title: string; since: number }[];
};

/** What Settings lists for `space`: whether the space allows writes, and which of its conversations do. */
export function writePermissions(space: string): WritePermissions {
  const spaces = Object.entries(spaceMap()).map(([s, since]) => ({ space: s, since }));
  let conversations: WritePermissions["conversations"] = [];
  try {
    conversations = listThreadsIn(spaceDir(space))
      .filter((t) => t.allowWrites)
      .map((t) => ({ thread: t.id, title: t.title, since: t.allowWrites! }));
  } catch (e) {
    log.debug("couldn't list conversations for write permissions", { space, error: (e as Error).message });
  }
  return { spaces, conversations };
}
