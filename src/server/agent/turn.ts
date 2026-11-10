import path from "node:path";
import type { AccessAnswer, AgentEvent } from "../../shared/agent.ts";
import { Channel, CollectingChannel } from "../rpc/channel.ts";
import { commands, messageOf, Refusal } from "../rpc/registry.ts";
import { answer as deliver } from "../core/pending.ts";
import { BUSY, cancel, claim, release, type Run } from "../core/runs.ts";
import { ATTACHMENT_TYPE, load, openQuestionCall, type Block } from "../core/thread.ts";
import { appFiles, spaceDir, vaultName } from "../core/vault.ts";
import { saveUploads, type Upload } from "../attachments/attachments.ts";
import { runCliTurn } from "../cli/turn.ts";
import { isFullAccess } from "../fullaccess/fullaccess.ts";
import { cliDirs } from "../grants/grants.ts";
import { fullyVisibleCourseDirs } from "../lms/access.ts";
import { readSettings } from "../settings/settings.ts";
import { readSpaceMeta, touchSpace } from "../spaces/meta.ts";
import { workingDirFor } from "../workspace/workspace.ts";
import { forSpace } from "../providers/build.ts";
import { cleanAnswer, healedCall } from "./lesson.ts";
import { runOwnTurn, type TurnMode } from "./loop.ts";

/**
 * The agent commands. `agent_send` runs one turn on the vault's backend
 * (Phaethon's own loop or a CLI) and always ends its channel with exactly one
 * `end`. `lesson_answer` hands the student's answer to an open question back
 * to the model and continues in a new turn.
 */

export const BUSY_TURN = "This space is still answering the previous message. Stop it or wait for it to finish.";
const CLI_CONTINUE = "Continuing a stopped reply works only with Phaethon’s own agent.";
const CLI_ANSWER = "Answering a question works only with Phaethon’s own agent.";

type SendArgs = {
  space: string;
  prompt: string;
  attachments?: Upload[];
  onEvent: Channel<AgentEvent>;
  replaceFrom?: number | null;
  keepAttachments?: string[] | null;
  continueFrom?: number | null;
};

const CLIS = { "claude-cli": "claude", "codex-cli": "codex", "gemini-cli": "gemini" } as const;

/** Attachment refs of the edited message the user kept, first, in their original order. */
function keptAttachments(space: string, index: number, keep: string[]): Block[] {
  try {
    const m = load(space)[index];
    if (!m || m.role !== "user") return [];
    return m.content.filter((b) => b.type === ATTACHMENT_TYPE && keep.includes(String(b.path)));
  } catch {
    return [];
  }
}

async function ownTurn(space: string, events: Channel<AgentEvent>, mode: TurnMode, run: Run): Promise<void> {
  let provider;
  try {
    provider = forSpace(space);
  } catch (e) {
    events.send({ kind: "error", code: "noApiKey", message: messageOf(e) });
    return;
  }
  await runOwnTurn({ space, provider, events, run, mode });
}

export async function agentSend(args: SendArgs): Promise<void> {
  const events = args.onEvent ?? new CollectingChannel<AgentEvent>();
  const end = () => events.send({ kind: "end", sessionId: null });
  const { space } = args;
  let dir: string;
  try {
    dir = spaceDir(space);
  } catch (e) {
    events.send({ kind: "error", code: "invalidSpace", message: messageOf(e) });
    return end();
  }
  touchSpace(space);
  const settings = readSettings();
  const continueFrom = typeof args.continueFrom === "number" ? args.continueFrom : undefined;
  const replaceFrom = typeof args.replaceFrom === "number" ? args.replaceFrom : undefined;
  if (continueFrom !== undefined && settings.backend !== "phaethon") {
    events.send({ kind: "error", code: "cli", message: CLI_CONTINUE });
    return end();
  }
  let attachments: Block[] = [];
  if (continueFrom === undefined) {
    try {
      attachments = saveUploads(space, args.attachments ?? []);
    } catch (e) {
      events.send({ kind: "error", code: "attachment", message: messageOf(e) });
      return end();
    }
    if (replaceFrom !== undefined && args.keepAttachments?.length) attachments = [...keptAttachments(space, replaceFrom, args.keepAttachments), ...attachments];
  }
  const run = claim(space);
  if (!run) {
    events.send({ kind: "error", code: "busy", message: BUSY_TURN });
    return end();
  }
  try {
    if (settings.backend === "phaethon") {
      const mode: TurnMode = continueFrom !== undefined ? { kind: "continue", from: continueFrom } : { kind: "prompt", prompt: String(args.prompt ?? ""), attachments, replaceFrom };
      await ownTurn(space, events, mode, run);
    } else {
      const cli = CLIS[settings.backend];
      const meta = readSpaceMeta(space);
      const model = typeof meta.cliModels?.[cli] === "string" ? meta.cliModels[cli] : null;
      const reasoning = typeof meta.cliReasoning?.[cli] === "string" ? meta.cliReasoning[cli] : null;
      // runCliTurn sends its own single `end`.
      return await runCliTurn(
        {
          cli,
          space,
          spaceDir: dir,
          workingDir: workingDirFor(space),
          prompt: String(args.prompt ?? ""),
          attachments,
          replaceFrom,
          configDir: cli === "claude" && settings.isolateClaudeConfig ? path.join(appFiles.claudeConfigRoot(), vaultName()) : null,
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
    release(run);
    try {
      touchSpace(space);
    } catch {
      // the space may have gone
    }
  }
  end();
}

type AnswerArgs = { space: string; id: string; answer: unknown; onEvent?: Channel<AgentEvent> };

/** Returns false (and sends nothing) when that question isn't waiting any more. */
export async function lessonAnswer(args: AnswerArgs): Promise<boolean> {
  const { space, id } = args;
  spaceDir(space);
  if (readSettings().backend !== "phaethon") throw new Refusal(CLI_ANSWER);
  const run = claim(space);
  if (!run) throw new Refusal(BUSY);
  const events = args.onEvent ?? new CollectingChannel<AgentEvent>();
  try {
    const open = openQuestionCall(load(space));
    if (!open || open.block.id !== id) return false;
    const call = healedCall(open.block);
    const answer = cleanAnswer(args.answer, call);
    await ownTurn(space, events, { kind: "answer", call, answer }, run);
  } finally {
    release(run);
  }
  events.send({ kind: "end", sessionId: null });
  return true;
}

const ANSWERS: AccessAnswer[] = ["once", "always", "deny"];

commands({
  agent_send: (args: SendArgs) => agentSend(args),
  agent_cancel: ({ space }: { space: string }) => cancel(String(space)),
  agent_approve: ({ space, id, allow }: { space: string; id: string; allow: boolean }) => deliver(String(space), `write:${id}`, allow === true),
  agent_access_answer: ({ space, id, answer }: { space: string; id: string; answer: AccessAnswer }) => {
    if (!ANSWERS.includes(answer)) throw new Refusal("That isn’t an answer Phaethon knows.");
    return deliver(String(space), `access:${id}`, answer);
  },
  lesson_answer: (args: AnswerArgs) => lessonAnswer(args),
});
