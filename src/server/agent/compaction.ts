import fs from "node:fs";
import path from "node:path";
import { ATTACHMENT_TYPE, CONTINUE_TYPE, LEGACY_ATTACHMENT_TYPE, recordFromBlock, shownTexts, type Block, type Message } from "../core/thread.ts";
import type { Provider } from "../providers/types.ts";
import { currentPlan } from "./lesson.ts";

/**
 * Learner-centred compaction. When a conversation grows past what the model
 * handles well, the model writes a summary centred on what the student
 * understands, and the next request starts from that summary plus the new
 * message: nothing earlier is replayed, thinking blocks included (they are
 * bound to the history that produced them). The full conversation stays in
 * thread.json and on screen; the summary is a hidden user-role block.
 */

export const COMPACT_TYPE = "phaethon_compact";

export const COMPACT_HEADER =
  "[A summary of this conversation so far, written when it grew long. The earlier messages are not shown to you; work from this summary.]";

/** Roughly how many tokens a conversation costs (4 characters a token; pictures and attached files a flat amount). */
export function estimateTokens(msgs: Message[], spaceRoot?: string): number {
  let chars = 0;
  let flat = 0;
  const block = (b: Block) => {
    switch (b.type) {
      case "text":
        chars += String(b.text ?? "").length;
        break;
      case "thinking":
        chars += String(b.thinking ?? "").length;
        break;
      case "tool_use":
        chars += JSON.stringify(b.input ?? {}).length + 20;
        break;
      case "tool_result":
        if (typeof b.content === "string") chars += b.content.length;
        else if (Array.isArray(b.content)) for (const p of b.content as Block[]) block(p);
        break;
      case "image":
        flat += 1600;
        break;
      case COMPACT_TYPE:
        chars += String(b.summary ?? "").length;
        break;
      case ATTACHMENT_TYPE:
      case LEGACY_ATTACHMENT_TYPE: {
        const media = String(b.media_type ?? "");
        if (media.startsWith("image/")) flat += 1600;
        else {
          let size = 8000;
          try {
            if (spaceRoot) size = fs.statSync(path.join(spaceRoot, String(b.path ?? ""))).size;
          } catch {
            // missing: counted as small
          }
          flat += Math.min(Math.round(size / (media === "application/pdf" ? 20 : 4)), 200_000);
        }
        break;
      }
      default:
        break;
    }
  };
  for (const m of msgs) for (const b of m.content) block(b);
  return Math.round(chars / 4) + flat;
}

/** Where the model's view of the conversation starts: the latest summary, else the beginning. */
export function compactionStart(msgs: Message[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].content.some((b) => b.type === COMPACT_TYPE)) return i;
  return 0;
}

/** The token count past which a conversation is summarised before the next message. */
export function compactAt(provider: Provider): number {
  const env = Number(process.env.PHAETHON_COMPACT_AT);
  if (Number.isFinite(env) && env > 0) return env;
  if (provider.id === "anthropic") return 150_000;
  if (provider.id === "ollama" || provider.id === "lmstudio" || provider.id === "custom") return 12_000;
  return 60_000;
}

export function needsCompaction(msgs: Message[], provider: Provider, spaceRoot?: string): boolean {
  const view = msgs.slice(compactionStart(msgs));
  // Never in the middle of a tool round: the last message must be a finished reply.
  const last = view[view.length - 1];
  if (!last || last.role !== "assistant" || last.content.some((b) => b.type === "tool_use")) return false;
  return estimateTokens(view, spaceRoot) > compactAt(provider);
}

const COMPACT_SYSTEM = `You write the memory of a long tutoring and study conversation, so it can continue from your summary alone. Write it in these four sections, with these headings:

## What the student understands
For each idea that came up: whether they hold it securely, hold it shakily, or hold a misconception (and whether it was corrected). Give the evidence: their answers to questions, how sure they said they were, and what their own reasoning showed. This section matters most; be specific.

## What was covered
The arc of the conversation: what was explained and in what order, tasks done (files read or written, decisions made), and the user's stated goals and preferences.

## The lesson plan
If there is a lesson plan, copy its goal and its prerequisite map exactly as given. Otherwise write "None."

## Where things stand
An unanswered question, promises made, and the next step.

Rules: no praise or commentary; only claims the conversation supports; keep names, file paths, numbers and notation exact. Write the summary only; do not call tools.`;

function transcript(msgs: Message[]): string {
  const lines: string[] = [];
  const asked = new Map<string, Block>();
  for (const m of msgs) {
    for (const b of m.content) {
      if (b.type === COMPACT_TYPE) lines.push(`[Earlier summary]\n${String(b.summary ?? "")}`);
      if (b.type === CONTINUE_TYPE) lines.push("[The user asked to continue the stopped reply.]");
      if (b.type === "tool_use") {
        if (b.name === "check" || b.name === "explain_back") {
          asked.set(String(b.id), b);
          lines.push(`[Assistant asked (${b.name}): ${JSON.stringify(b.input)}]`);
        } else if (b.name !== "send_to_user") lines.push(`[Assistant used ${String(b.name)}: ${JSON.stringify(b.input).slice(0, 300)}]`);
      }
      if (b.type === "tool_result" && asked.has(String(b.tool_use_id))) lines.push(`[Student's answer: ${typeof b.content === "string" ? b.content : JSON.stringify(b.content)}]`);
      const r = recordFromBlock(b);
      if (r?.kind === "lessonPlan") lines.push(`[Lesson plan saved. Goal: ${r.goal}\n${r.map}]`);
    }
    const texts = shownTexts(m);
    if (texts.length) lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${texts.join("\n\n")}`);
  }
  return lines.join("\n\n");
}

/** Asks the conversation's own model for the summary. */
export async function summarize(provider: Provider, msgs: Message[], signal: AbortSignal): Promise<string> {
  const view = msgs.slice(compactionStart(msgs));
  const plan = currentPlan(msgs);
  const turn = await provider.turn(
    {
      system: { stable: COMPACT_SYSTEM, volatile: "" },
      messages: [{ role: "user", content: [{ type: "text", text: `<conversation>\n${transcript(view)}\n</conversation>${plan ? "\n\nThe current lesson plan is in the conversation above; copy it exactly." : ""}\n\nWrite the summary now.` }] }],
      tools: [],
      effort: "medium",
      maxTokens: 8000,
    },
    () => {},
    signal,
  );
  const text = turn.content
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n\n")
    .trim();
  if (!text) throw new Error("the summary came back empty");
  return text;
}

export function compactionBlock(summary: string): Block {
  return { type: COMPACT_TYPE, summary };
}

/** A summary block as the model sees it. */
export function compactionText(block: Block): Block {
  return { type: "text", text: `${COMPACT_HEADER}\n\n${String(block.summary ?? "")}` };
}
