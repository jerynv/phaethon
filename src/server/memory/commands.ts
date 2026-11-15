import { commands, messageOf, Refusal } from "../rpc/registry.ts";
import { turnKey, whileIdle } from "../core/runs.ts";
import { threadArg } from "../threads/args.ts";
import { spaceDir } from "../core/vault.ts";
import { completeText } from "../providers/complete.ts";
import { clearIn, forgetIn, forgetPreviewIn } from "./memory.ts";

commands({
  thread_clear: (args: { space: string; thread?: string; id?: string }) => {
    const { space } = args;
    const dir = spaceDir(space);
    const id = threadArg(args);
    return whileIdle(turnKey(space, id), (run) =>
      clearIn(dir, id, async (system, ask) => {
        const reply = await completeText({ space, thread: id, system, messages: [{ role: "user", content: ask }], signal: run.abort.signal });
        return reply.text;
      }),
    );
  },

  thread_forget_preview: (args: { space: string; thread?: string; id?: string }) => {
    const dir = spaceDir(args.space);
    const id = threadArg(args);
    try {
      return forgetPreviewIn(dir, id);
    } catch (e) {
      throw new Refusal(`That conversation couldn’t be read: ${messageOf(e)}`);
    }
  },

  thread_forget: (args: { space: string; thread?: string; id?: string }) => {
    const dir = spaceDir(args.space);
    const id = threadArg(args);
    return whileIdle(turnKey(args.space, id), () => forgetIn(dir, id));
  },
});
