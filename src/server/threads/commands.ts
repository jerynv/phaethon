import { commands, messageOf, Refusal } from "../rpc/registry.ts";
import { runningIn, turnKey, whileIdle } from "../core/runs.ts";
import { spaceDir } from "../core/vault.ts";
import { setWritesAllowed, writePermissions, type WriteScope } from "../grants/writes.ts";
import { optionalThread, threadArg, type Named } from "./args.ts";
import { effectivePick, parsePick, savePick } from "./pick.ts";
import { createIn, deleteThreadIn, existsIn, listThreadsIn, loadIn, migrateIn, toUi, updateMetaIn, type ThreadSummary } from "./store.ts";

/**
 * Conversation commands. Every one names its conversation (`thread`; the
 * older `id` is read too), so a reply running in one never blocks another:
 * only deleting or clearing the conversation that is replying is refused.
 */

function wrap<T>(prefix: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw new Refusal(`${prefix}: ${messageOf(e)}`);
  }
}

/** A listed conversation, with whether it is replying right now (in this window or another). */
export type ThreadListed = ThreadSummary & { running?: true };

commands({
  /** A new conversation's id. Nothing is saved until its first message, so an unsent new chat leaves nothing behind. */
  thread_create: ({ space }: { space: string }) => {
    const dir = spaceDir(space);
    return wrap("A new conversation couldn’t be started", () => createIn(dir));
  },

  /** Conversation `thread` as the timeline shows it; one not saved yet is empty. */
  thread_load: (args: Named) => {
    const dir = spaceDir(args.space);
    const thread = threadArg(args);
    return wrap("This conversation couldn’t be read", () => {
      migrateIn(dir);
      return toUi(loadIn(dir, thread));
    });
  },

  threads_list: ({ space }: { space: string }): ThreadListed[] => {
    const dir = spaceDir(space);
    const list = wrap("This space’s conversations couldn’t be listed", () => listThreadsIn(dir));
    const running = new Set(runningIn(space));
    return list.map((t) => (running.has(t.id) ? { ...t, running: true as const } : t));
  },

  thread_delete: (args: Named) => {
    const dir = spaceDir(args.space);
    const thread = threadArg(args);
    return whileIdle(turnKey(args.space, thread), () => {
      wrap("That conversation couldn’t be deleted", () => deleteThreadIn(dir, thread));
      return null;
    });
  },
});

commands({
  /** Gives a conversation its own title; an empty one goes back to the title from its first message. */
  thread_rename: (args: Named & { title: unknown }) => {
    const dir = spaceDir(args.space);
    const thread = threadArg(args);
    if (typeof args.title !== "string") throw new Refusal("A title has to be text.");
    const title = args.title;
    return wrap("That conversation couldn’t be renamed", () => updateMetaIn(dir, thread, { title }));
  },

  /** Pins a conversation to the top of its space, or unpins it. */
  thread_pin: (args: Named & { pinned: unknown }) => {
    const dir = spaceDir(args.space);
    const thread = threadArg(args);
    return wrap("That conversation couldn’t be pinned", () => updateMetaIn(dir, thread, { pinned: args.pinned ? Date.now() : null }));
  },
});

commands({
  /** The model conversation `thread` answers with (see pick.ts); with none, the one a new chat starts with. */
  thread_model_get: (args: Named) => {
    spaceDir(args.space);
    const thread = optionalThread(args);
    return wrap("This conversation’s model couldn’t be read", () => effectivePick(String(args.space), thread));
  },

  /** Chooses the model for conversation `thread` (and for new ones). A new chat's choice is kept only as the default until it is sent. */
  thread_model_set: (args: Named & { pick: unknown }) => {
    const dir = spaceDir(args.space);
    const thread = optionalThread(args);
    const parsed = parsePick(args.pick);
    if (!parsed) throw new Refusal("That isn’t a model Phaethon knows how to use.");
    const saved = thread !== null && existsIn(dir, thread) ? thread : null;
    wrap("The model couldn’t be saved", () => savePick(String(args.space), saved, parsed));
    return effectivePick(String(args.space), saved);
  },
});

const SCOPES: WriteScope[] = ["conversation", "space"];

commands({
  /** Whether `space` lets Phaethon write without asking, and which of its conversations do (for Settings). */
  write_permissions_list: ({ space }: { space: string }) => {
    spaceDir(space);
    return writePermissions(space);
  },

  /** Lets Phaethon write files without asking, in one conversation or a whole space, or takes that back. */
  write_permission_set: (args: Named & { scope: unknown; allow: unknown }) => {
    spaceDir(args.space);
    const scope = args.scope as WriteScope;
    if (!SCOPES.includes(scope)) throw new Refusal("That isn’t a permission Phaethon knows.");
    const thread = scope === "conversation" ? threadArg(args) : null;
    wrap("The permission couldn’t be saved", () => setWritesAllowed(args.space, thread, scope, args.allow === true));
    return writePermissions(args.space);
  },
});
