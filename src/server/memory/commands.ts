import { commands, messageOf, Refusal } from "../rpc/registry.ts";
import { whileIdle } from "../core/runs.ts";
import { spaceDir } from "../core/vault.ts";
import { completeText } from "../providers/complete.ts";
import { clearIn, forgetIn, forgetPreviewIn } from "./memory.ts";

commands({
  thread_clear: ({ space, id }: { space: string; id: string }) => {
    const dir = spaceDir(space);
    return whileIdle(space, (run) =>
      clearIn(dir, String(id), async (system, ask) => {
        const reply = await completeText({ space, system, messages: [{ role: "user", content: ask }], signal: run.abort.signal });
        return reply.text;
      }),
    );
  },

  thread_forget_preview: ({ space, id }: { space: string; id: string }) => {
    const dir = spaceDir(space);
    try {
      return forgetPreviewIn(dir, String(id));
    } catch (e) {
      throw new Refusal(`That conversation couldn’t be read: ${messageOf(e)}`);
    }
  },

  thread_forget: ({ space, id }: { space: string; id: string }) => {
    const dir = spaceDir(space);
    return whileIdle(space, () => forgetIn(dir, String(id)));
  },
});
