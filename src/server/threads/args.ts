import { Refusal } from "../rpc/registry.ts";
import { isValidThreadId } from "../core/thread.ts";

/** A command's conversation argument: `thread`, or the older `id`. */
export type Named = { space: string; thread?: unknown; id?: unknown };

/** The conversation a call names; refused before it becomes a key or a path when it isn't an id. */
export function threadArg(args: Named): string {
  const id = args.thread ?? args.id;
  if (!isValidThreadId(id)) throw new Refusal("That isn’t a conversation Phaethon knows. Reload the list and try again.");
  return id;
}

/** The conversation a call names, or null for a new chat that has no id yet. */
export function optionalThread(args: Named): string | null {
  const id = args.thread ?? args.id;
  if (id === undefined || id === null) return null;
  return threadArg(args);
}
