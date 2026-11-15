import type { AccessAnswer, AgentEvent } from "../../shared/agent.ts";
import { requireHome, selected } from "../cli/instances.ts";
import { Channel, CollectingChannel } from "../rpc/channel.ts";
import { commands, messageOf, Refusal, type CallContext } from "../rpc/registry.ts";
import { answer as deliver } from "../core/pending.ts";
import { BUSY, cancel, claim, release, turnKey, type Run } from "../core/runs.ts";
import { isValidThreadId, load, openQuestionCall, type Block } from "../core/thread.ts";
import { spaceDir } from "../core/vault.ts";
import { saveUploads, type Upload } from "../attachments/attachments.ts";
import { runCliTurn } from "../cli/turn.ts";
import { isFullAccess } from "../fullaccess/fullaccess.ts";
import { cliDirs } from "../grants/grants.ts";
import { setWritesAllowed, type WriteScope } from "../grants/writes.ts";
import { fullyVisibleCourseDirs } from "../lms/access.ts";
import { touchSpace } from "../spaces/meta.ts";
import { workingDirFor } from "../workspace/workspace.ts";
import { forSpace, providerFor } from "../providers/build.ts";
import { keptAttachments as keptFrom } from "../threads/store.ts";
import { parseRef } from "../providers/presets.ts";
import { effectivePick, parsePick, savePick, type ModelPick } from "../threads/pick.ts";
import { cleanAnswer, healedCall } from "./lesson.ts";
import { runOwnTurn, type TurnMode } from "./loop.ts";

/**
 * The agent commands. Every one names its conversation (`thread`), and a
 * reply claims only that conversation, so different conversations reply at
 * the same time, in the same space too. `agent_send` runs one turn on the
 * conversation's backend (Phaethon's own loop or a CLI) and always ends its
 * channel with exactly one `end`. `lesson_answer` hands the student's answer
 * to an open question back to the model and continues in a new turn.
 */

export const BUSY_TURN = "This conversation is still answering the previous message. Stop it or wait for it to finish.";
const NO_THREAD = "That isn’t a conversation Phaethon knows. Start a new chat and send again.";
const CLI_CONTINUE = "Continuing a stopped reply works only with Phaethon’s own agent.";
const CLI_ANSWER = "Answering a question works only with Phaethon’s own agent.";

type SendArgs = {
  space: string;
  /** The conversation (from `thread_create` for a new chat). */
  thread: string;
  prompt: string;
  attachments?: Upload[];
  onEvent: Channel<AgentEvent>;
  replaceFrom?: number | null;
  keepAttachments?: string[] | null;
  continueFrom?: number | null;
  /** The model chosen for this conversation in the composer; saved with it (threads/pick.ts). */
  model?: unknown;
};

const CLIS = { "claude-cli": "claude", "codex-cli": "codex", "gemini-cli": "gemini" } as const;

/** Attachment refs of the edited message the user kept, first, in their original order. */
function keptAttachments(space: string, thread: string, index: number, keep: string[]): Block[] {
  try {
    return keptFrom(load(space, thread), index, keep);
  } catch {
    return [];
  }
}

async function ownTurn(space: string, thread: string, events: Channel<AgentEvent>, mode: TurnMode, run: Run, pick: ModelPick): Promise<void> {
  let provider;
  try {
    const ref = pick.model ? parseRef(pick.model) : undefined;
    provider = ref ? providerFor(ref) : forSpace(space);
  } catch (e) {
    events.send({ kind: "error", code: "noApiKey", message: messageOf(e) });
    return;
  }
  await runOwnTurn({ space, thread, provider, events, run, mode, effort: pick.effort });
}

/** When the window that started a turn goes away, the turn stops (nothing could answer its questions). */
function stopWith(signal: AbortSignal | undefined, run: Run): () => void {
  if (!signal) return () => {};
  const stop = () => run.abort.abort();
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  return () => signal.removeEventListener("abort", stop);
}

export async function agentSend(args: SendArgs, signal?: AbortSignal): Promise<void> {
  const events = args.onEvent ?? new CollectingChannel<AgentEvent>();
  const end = () => events.send({ kind: "end", sessionId: null });
  const { space, thread } = args;
  let dir: string;
  try {
    dir = spaceDir(space);
  } catch (e) {
    events.send({ kind: "error", code: "invalidSpace", message: messageOf(e) });
    return end();
  }
  if (!isValidThreadId(thread)) {
    events.send({ kind: "error", code: "badRequest", message: NO_THREAD });
    return end();
  }
  touchSpace(space);
  let chosen: ModelPick | undefined;
  if (args.model !== undefined && args.model !== null) {
    chosen = parsePick(args.model) ?? undefined;
    if (!chosen) {
      events.send({ kind: "error", code: "badRequest", message: "That isn’t a model Phaethon knows how to use. Pick another one." });
      return end();
    }
  }
  let pick: ModelPick;
  try {
    pick = chosen ?? effectivePick(space, thread).pick;
  } catch (e) {
    events.send({ kind: "error", code: "storage", message: messageOf(e) });
    return end();
  }
  const continueFrom = typeof args.continueFrom === "number" ? args.continueFrom : undefined;
  const replaceFrom = typeof args.replaceFrom === "number" ? args.replaceFrom : undefined;
  if (continueFrom !== undefined && pick.backend !== "phaethon") {
    events.send({ kind: "error", code: "cli", message: CLI_CONTINUE });
    return end();
  }
  // A coding agent answers with the account chosen for it; a connection without its folder can't start.
  const cli = pick.backend === "phaethon" ? null : CLIS[pick.backend];
  let configDir: string | null = null;
  if (cli) {
    try {
      configDir = requireHome(selected(cli));
    } catch (e) {
      events.send({ kind: "error", code: "cli", message: messageOf(e) });
      return end();
    }
  }
  const run = claim(turnKey(space, thread));
  if (!run) {
    events.send({ kind: "error", code: "busy", message: BUSY_TURN });
    return end();
  }
  // Saved only once the conversation is ours, so a send refused as busy can't change a running conversation's model.
  if (chosen) {
    try {
      savePick(space, thread, chosen);
    } catch (e) {
      release(run);
      events.send({ kind: "error", code: "storage", message: `The model choice couldn’t be saved: ${messageOf(e)}` });
      return end();
    }
  }
  const unhook = stopWith(signal, run);
  // Saved only once the conversation is ours, so a refused send leaves no files behind.
  let attachments: Block[] = [];
  if (continueFrom === undefined) {
    try {
      attachments = saveUploads(space, args.attachments ?? []);
    } catch (e) {
      unhook();
      release(run);
      events.send({ kind: "error", code: "attachment", message: messageOf(e) });
      return end();
    }
    if (replaceFrom !== undefined && args.keepAttachments?.length) attachments = [...keptAttachments(space, thread, replaceFrom, args.keepAttachments), ...attachments];
  }
  try {
    if (!cli) {
      const mode: TurnMode = continueFrom !== undefined ? { kind: "continue", from: continueFrom } : { kind: "prompt", prompt: String(args.prompt ?? ""), attachments, replaceFrom };
      await ownTurn(space, thread, events, mode, run, pick);
    } else {
      const model = pick.model;
      const reasoning = pick.effort;
      // runCliTurn sends its own single `end`.
      return await runCliTurn(
        {
          cli,
          space,
          thread,
          spaceDir: dir,
          workingDir: workingDirFor(space),
          prompt: String(args.prompt ?? ""),
          attachments,
          replaceFrom,
          configDir,
          addDirs: [...cliDirs(space), ...fullyVisibleCourseDirs(space)],
          model,
          reasoning,
          fullAccess: isFullAccess(space),
        },
        events,
        run,
      );
    }
  } catch (e) {
    events.send({ kind: "error", code: "provider", message: messageOf(e) });
  } finally {
    unhook();
    release(run);
    try {
      touchSpace(space);
    } catch {
      // the space may have gone
    }
  }
  end();
}

type AnswerArgs = { space: string; thread: string; id: string; answer: unknown; onEvent?: Channel<AgentEvent> };

/** Returns false (and sends nothing) when that question isn't waiting any more. */
export async function lessonAnswer(args: AnswerArgs, signal?: AbortSignal): Promise<boolean> {
  const { space, thread, id } = args;
  spaceDir(space);
  if (!isValidThreadId(thread)) throw new Refusal(NO_THREAD);
  const pick = effectivePick(space, thread).pick;
  if (pick.backend !== "phaethon") throw new Refusal(CLI_ANSWER);
  const run = claim(turnKey(space, thread));
  if (!run) throw new Refusal(BUSY);
  const unhook = stopWith(signal, run);
  const events = args.onEvent ?? new CollectingChannel<AgentEvent>();
  try {
    const open = openQuestionCall(load(space, thread));
    if (!open || open.block.id !== id) return false;
    const call = healedCall(open.block);
    const answer = cleanAnswer(args.answer, call);
    await ownTurn(space, thread, events, { kind: "answer", call, answer }, run, pick);
  } finally {
    unhook();
    release(run);
  }
  events.send({ kind: "end", sessionId: null });
  return true;
}

const ANSWERS: AccessAnswer[] = ["once", "always", "deny"];
const REMEMBER: WriteScope[] = ["conversation", "space"];

/** The conversation a call names; refused before it is used as a key or a path. */
function threadOf(thread: unknown): string {
  if (!isValidThreadId(thread)) throw new Refusal(NO_THREAD);
  return thread;
}

type ApproveArgs = { space: string; thread: string; id: string; allow: boolean; remember?: unknown };

/**
 * The answer to a write approval. `remember` ("conversation" or "space") with
 * `allow` also lets later writes there go ahead without asking; that is saved
 * before the waiting write is let through, so it holds for the rest of this
 * reply too.
 */
function approve({ space, thread, id, allow, remember }: ApproveArgs): boolean {
  const t = threadOf(thread);
  spaceDir(space);
  if (remember !== undefined && remember !== null && !REMEMBER.includes(remember as WriteScope)) throw new Refusal("That isn’t a permission Phaethon knows.");
  const key = turnKey(String(space), t);
  if (allow === true && remember) {
    try {
      setWritesAllowed(String(space), t, remember as WriteScope, true);
    } catch (e) {
      // The write itself still goes ahead; only remembering failed.
      deliver(key, `write:${id}`, true);
      throw new Refusal(`The file was allowed, but Phaethon couldn’t remember that for next time: ${messageOf(e)}`);
    }
  }
  return deliver(key, `write:${id}`, allow === true);
}

commands({
  agent_send: (args: SendArgs, ctx: CallContext) => agentSend(args, ctx.signal),
  agent_cancel: ({ space, thread }: { space: string; thread: string }) => cancel(turnKey(String(space), threadOf(thread))),
  agent_approve: (args: ApproveArgs) => approve(args),
  agent_access_answer: ({ space, thread, id, answer }: { space: string; thread: string; id: string; answer: AccessAnswer }) => {
    if (!ANSWERS.includes(answer)) throw new Refusal("That isn’t an answer Phaethon knows.");
    return deliver(turnKey(String(space), threadOf(thread)), `access:${id}`, answer);
  },
  lesson_answer: (args: AnswerArgs, ctx: CallContext) => lessonAnswer(args, ctx.signal),
});

