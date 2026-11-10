import { CONTINUE_TYPE, RECORD_TYPE, type Block, type Message } from "../core/thread.ts";
import { toUi } from "../threads/store.ts";
import { Refusal } from "../rpc/registry.ts";

/**
 * Continuing a reply the user stopped. A hidden user message
 * `{type: "phaethon_continue"}` asks the model to carry on; on the wire it
 * becomes the instruction below (the saved history never changes, so the
 * model's earlier thinking stays valid). This is done inside the loop's own
 * wire conversion, so the provider underneath (and what it can see) is the
 * real one: the old wrapper hid `image_input`, which made read_page always
 * refuse.
 */

export const CONTINUE_INSTRUCTION =
  "[The user stopped your previous reply part-way and asked you to continue it. Carry on from exactly where it stopped. Your continuation is shown straight after the stopped text, as a new paragraph: if it stopped mid-sentence, begin by writing that whole sentence again; otherwise do not repeat anything already written. Do not mention the interruption.]";

export const STALE = "That reply can’t be continued: the conversation has changed since it was shown. Reload the conversation and try again.";

export function continueBlock(): Block {
  return { type: CONTINUE_TYPE };
}

const isStopped = (b: Block) => b.type === RECORD_TYPE && b.kind === "stopped";

/** Checks `from` is the last shown reply, with text and a stopped record; returns the index of the message holding that record. */
export function stoppedReply(msgs: Message[], from: number): number {
  const ui = toUi(msgs);
  const last = ui[ui.length - 1];
  if (!last || last.role !== "assistant" || last.index !== from || !last.text.trim() || !last.records.some((r) => r.kind === "stopped")) throw new Refusal(STALE);
  for (let i = msgs.length - 1; i >= from; i--) if (msgs[i].content.some(isStopped)) return i;
  throw new Refusal(STALE);
}

/**
 * After a continue turn: if nothing came back, drop the hidden request;
 * otherwise drop the earlier "stopped" mark so the two parts read as one reply.
 */
export function settle(msgs: Message[], start: number, stoppedAt: number): boolean {
  const hidden = msgs[start];
  if (!hidden || hidden.role !== "user" || !hidden.content.some((b) => b.type === CONTINUE_TYPE)) return false;
  if (start === msgs.length - 1) {
    msgs.pop();
    return true;
  }
  const content = msgs[stoppedAt]?.content;
  if (!content) return false;
  for (let i = content.length - 1; i >= 0; i--) {
    if (isStopped(content[i])) {
      content.splice(i, 1);
      return true;
    }
  }
  return false;
}
