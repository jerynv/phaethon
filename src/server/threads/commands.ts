import { commands, messageOf, Refusal } from "../rpc/registry.ts";
import { whileIdle } from "../core/runs.ts";
import { spaceDir } from "../core/vault.ts";
import { deleteThreadIn, listThreadsIn, loadIn, openThreadIn, startNewIn, toUi } from "./store.ts";

function wrap<T>(prefix: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw new Refusal(`${prefix}: ${messageOf(e)}`);
  }
}

commands({
  thread_load: ({ space }: { space: string }) => {
    const dir = spaceDir(space);
    return wrap("This space’s conversation couldn’t be read", () => toUi(loadIn(dir)));
  },

  threads_list: ({ space }: { space: string }) => {
    const dir = spaceDir(space);
    return wrap("This space’s conversations couldn’t be listed", () => listThreadsIn(dir));
  },

  thread_new: ({ space }: { space: string }) => {
    const dir = spaceDir(space);
    return whileIdle(space, () => {
      wrap("A new conversation couldn’t be started", () => startNewIn(dir));
      return null;
    });
  },

  thread_open: ({ space, id }: { space: string; id: string }) => {
    const dir = spaceDir(space);
    return whileIdle(space, () => {
      wrap("That conversation couldn’t be opened", () => openThreadIn(dir, String(id)));
      return null;
    });
  },

  thread_delete: ({ space, id }: { space: string; id: string }) => {
    const dir = spaceDir(space);
    return whileIdle(space, () => {
      wrap("That conversation couldn’t be deleted", () => deleteThreadIn(dir, String(id)));
      return null;
    });
  },
});
