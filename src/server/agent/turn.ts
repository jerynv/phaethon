import type { AccessAnswer, AgentEvent } from "../../shared/agent.ts";
import { requireHome, selected } from "../cli/instances.ts";
import { clearSession } from "../cli/session.ts";
import { runCliTurnBody } from "../cli/turn.ts";
import { Channel, CollectingChannel } from "../rpc/channel.ts";
import { commands, messageOf, Refusal, type CallContext } from "../rpc/registry.ts";
import { answer as deliver } from "../core/pending.ts";
import { BUSY, cancel, claim, release, turnKey, type Run } from "../core/runs.ts";
import { isValidThreadId, load, openQuestionCall, recordBlock, save, type Block, type Message, type Record_ } from "../core/thread.ts";
import { spaceDir } from "../core/vault.ts";
import { saveUploads, type Upload } from "../attachments/attachments.ts";
import { isFullAccess } from "../fullaccess/fullaccess.ts";
import { cliDirs } from "../grants/grants.ts";
import { setWritesAllowed, type WriteScope } from "../grants/writes.ts";
import { fullyVisibleCourseDirs } from "../lms/access.ts";
import { touchSpace } from "../spaces/meta.ts";
import { workingDirFor } from "../workspace/workspace.ts";
import { forSpace, providerFor } from "../providers/build.ts";
import { keptAttachments as keptFrom, threadSummaryIn, toUi } from "../threads/store.ts";
import { notifyLater } from "../background/background.ts";
import { modelForSpace, parseRef, savedRef } from "../providers/presets.ts";
import { readSettings } from "../settings/settings.ts";
import { effectivePick, parsePick, savePick, type ModelPick } from "../threads/pick.ts";
import { friendlyModelLabel, isFallbackEligible, readyFallbackCandidates, sameModelPick, shortFailureReason } from "./fallback.ts";
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

const MAX_FALLBACK_ATTEMPTS = 3;
const OUTPUT_KINDS = new Set<AgentEvent["kind"]>([
  "text",
  "toolStart",
  "record",
  "thinking",
  "progress",
  "approval",
  "accessRequest",
  "check",
  "explainBack",
]);

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

/** A reply finished: a notification with its start, shown only while no Phaethon window has focus. */
function replyDone(space: string, thread: string): void {
  try {
    const last = toUi(load(space, thread)).at(-1);
    if (!last || last.role !== "assistant" || !last.text.trim()) return;
    const title = threadSummaryIn(spaceDir(space), thread)?.title || "Phaethon replied";
    notifyLater({ kind: "reply", title, body: last.text.replace(/[#*_`>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 180), whenAway: true, target: { kind: "thread", space, thread } });
  } catch {
    // a notification is a nicety
  }
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
  const end = (sessionId: string | null = null) => events.send({ kind: "end", sessionId });
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

  const autoFallback = readSettings().autoFallback !== false && continueFrom === undefined;
  let snapshot: Message[] | null = null;
  if (autoFallback) {
    try {
      snapshot = structuredClone(load(space, thread));
    } catch {
      snapshot = null;
    }
  }
  const restoreSnapshot = () => {
    if (!snapshot) return;
    try {
      const now = load(space, thread);
      if (JSON.stringify(now) !== JSON.stringify(snapshot)) save(space, thread, snapshot);
    } catch {
      // best effort
    }
  };

  const resolvePickForExclude = (p: ModelPick): ModelPick => {
    if (p.backend !== "phaethon" || p.model) return p;
    try {
      return { ...p, model: savedRef(modelForSpace(space)) };
    } catch {
      return p;
    }
  };

  const runAttempt = async (attemptPick: ModelPick, attemptEvents: Channel<AgentEvent>, isFallbackAttempt: boolean): Promise<string | null> => {
    const cli = attemptPick.backend === "phaethon" ? null : CLIS[attemptPick.backend];
    if (!cli) {
      const mode: TurnMode = continueFrom !== undefined ? { kind: "continue", from: continueFrom } : { kind: "prompt", prompt: String(args.prompt ?? ""), attachments, replaceFrom };
      await ownTurn(space, thread, attemptEvents, mode, run, attemptPick);
      return null;
    }
    let configDir: string | null = null;
    try {
      configDir = requireHome(selected(cli));
    } catch (e) {
      attemptEvents.send({ kind: "error", code: "cli", message: messageOf(e) });
      return null;
    }
    // When falling back onto a different CLI backend, clear any stale session so the CLI gets the portable transcript handoff.
    if (isFallbackAttempt && attemptPick.backend !== pick.backend) {
      try {
        clearSession(dir, thread);
      } catch {
        // best effort
      }
    }
    return await runCliTurnBody(
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
        model: attemptPick.model,
        reasoning: attemptPick.effort,
        fullAccess: isFullAccess(space),
      },
      attemptEvents,
      run,
    );
  };

  let endSessionId: string | null = null;
  try {
    if (!autoFallback) {
      const directChannel = new Channel<AgentEvent>(events.id, (msg) => {
        if (msg.kind === "end") return !events.closed;
        events.send(msg);
        return !events.closed;
      });
      endSessionId = await runAttempt(pick, directChannel, false);
    } else {
      const resolvedInitial = resolvePickForExclude(pick);
      const initialLabel = friendlyModelLabel(resolvedInitial);
      const initialFrom = { backend: pick.backend, model: resolvedInitial.model };
      const tried: ModelPick[] = [resolvedInitial];
      let candidates: ModelPick[] | null = null;
      let currentPick = pick;
      let firstError: Extract<AgentEvent, { kind: "error" }> | null = null;

      for (let attempt = 0; attempt < MAX_FALLBACK_ATTEMPTS; attempt++) {
        let hasOutput = false;
        const bufferedErrors: Extract<AgentEvent, { kind: "error" }>[] = [];
        let emittedHandoff: Extract<Record_, { kind: "handoff" }> | null = null;
        let pendingSwitch: (() => void) | null =
          attempt > 0 && firstError
            ? () => {
                const toLabel = friendlyModelLabel(currentPick);
                const reason = shortFailureReason(firstError!.code, firstError!.message);
                const handoff: Extract<Record_, { kind: "handoff" }> = { kind: "handoff", from: initialLabel, to: toLabel, reason };
                emittedHandoff = handoff;
                try {
                  savePick(space, thread, currentPick);
                } catch {
                  // best effort
                }
                events.send({
                  kind: "modelSwitch",
                  from: initialFrom,
                  to: currentPick,
                  fromLabel: initialLabel,
                  toLabel,
                  reason,
                });
                events.send({
                  kind: "record",
                  record: handoff,
                });
              }
            : null;

        const flushSwitch = () => {
          if (!pendingSwitch) return;
          const fn = pendingSwitch;
          pendingSwitch = null;
          fn();
        };

        const attemptChannel = new Channel<AgentEvent>(events.id, (msg) => {
          if (msg.kind === "end") return !events.closed;
          if (msg.kind === "error") {
            if (hasOutput || run.abort.signal.aborted) {
              if (hasOutput) flushSwitch();
              events.send(msg);
            } else {
              bufferedErrors.push(msg);
            }
            return !events.closed;
          }
          if (OUTPUT_KINDS.has(msg.kind)) {
            flushSwitch();
            hasOutput = true;
            for (const err of bufferedErrors.splice(0)) events.send(err);
            events.send(msg);
            return !events.closed;
          }
          if (msg.kind === "tool" && attempt > 0) {
            flushSwitch();
          }
          events.send(msg);
          return !events.closed;
        });

        let sessionId: string | null = null;
        try {
          sessionId = await runAttempt(currentPick, attemptChannel, attempt > 0);
        } catch (e) {
          const errEvent: Extract<AgentEvent, { kind: "error" }> = { kind: "error", code: "provider", message: messageOf(e) };
          if (hasOutput || run.abort.signal.aborted) {
            if (hasOutput) flushSwitch();
            events.send(errEvent);
          } else {
            bufferedErrors.push(errEvent);
          }
        }

        if (hasOutput || run.abort.signal.aborted || bufferedErrors.length === 0) {
          if (hasOutput || (!run.abort.signal.aborted && bufferedErrors.length === 0)) flushSwitch();
          for (const err of bufferedErrors) events.send(err);
          if (emittedHandoff) {
            try {
              const msgs = load(space, thread);
              let userIdx = -1;
              for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i]!;
                if (m.role === "user" && !m.content.some((b) => b?.type === "tool_result")) {
                  userIdx = i;
                  break;
                }
              }
              const target = msgs.slice(userIdx + 1).find((m) => m.role === "assistant");
              if (target) {
                target.content.unshift(recordBlock(emittedHandoff));
                save(space, thread, msgs);
              }
            } catch {
              // best effort
            }
          }
          endSessionId = sessionId;
          break;
        }

        const err = bufferedErrors[0]!;
        if (!firstError) firstError = err;

        if (attempt === 0 && !isFallbackEligible(err.code, err.message)) {
          for (const e of bufferedErrors) events.send(e);
          break;
        }

        if (attempt + 1 < MAX_FALLBACK_ATTEMPTS) {
          if (candidates === null) {
            candidates = await readyFallbackCandidates(resolvedInitial);
          }
          const next = candidates.find((c) => !tried.some((t) => sameModelPick(t, c)));
          if (next) {
            restoreSnapshot();
            tried.push(next);
            currentPick = next;
            continue;
          }
        }

        if (attempt > 0) {
          restoreSnapshot();
          events.send(firstError);
        } else {
          for (const e of bufferedErrors) events.send(e);
        }
        break;
      }
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
    if (!run.abort.signal.aborted) replyDone(space, thread);
  }
  end(endSessionId);
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

