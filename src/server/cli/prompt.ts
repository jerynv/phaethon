import path from "node:path";
import { appGuideCliSection, REASONING_PROMPT, RICH_OUTPUT_PROMPT, tutorModeSection } from "../agent/prompt-sections.ts";
import type { Block, Message } from "../core/thread.ts";
import { studyPromptForCli } from "../study/prompt.ts";
import { toUi } from "../threads/store.ts";
import { FULL_ACCESS_NOTE } from "./cli.ts";
import { profilesForPrompt } from "../memory/profile.ts";
import { memoryPromptSection, type TurnContext } from "../memory/prompt.ts";
import { emailBlockPrompt } from "../mail/block.ts";
import { mailEnabledFor } from "../mail/access.ts";

/** Said to a fresh session before a conversation it never saw. */
export const HISTORY_INTRO =
  'This conversation began before this session, so you haven\'t seen it. Here it is so far, as plain text ("Phaethon" is you). Carry on from it.';

const TRANSCRIPT_CAP = 48_000;
const OPENING_CAP = 4_000;

function trimToUtf8BoundaryEnd(buf: Buffer, maxBytes: number): string {
  if (buf.length <= maxBytes) return buf.toString("utf8");
  let start = buf.length - maxBytes;
  // Move forward to a character boundary (skip UTF-8 continuation bytes).
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

function trimToUtf8BoundaryStart(buf: Buffer, maxBytes: number): string {
  if (buf.length <= maxBytes) return buf.toString("utf8");
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * The conversation as plain text: `User:`/`Phaethon:` lines. Short conversations
 * stay completely intact; long multi-turn conversations preserve the opening
 * request plus as many recent turns as fit within ~48 000 bytes so another
 * provider never hits context limits during a handoff.
 */
export function transcript(msgs: Message[]): string {
  const entries = toUi(msgs).map((m) => {
    const who = m.role === "user" ? "User" : "Phaethon";
    const files = m.attachments.length ? ` [attached: ${m.attachments.map((a) => a.name).join(", ")}]` : "";
    return `${who}:${files} ${m.text.trim()}\n\n`;
  });
  const out = entries.join("");
  const bytes = Buffer.from(out, "utf8");
  if (bytes.length <= TRANSCRIPT_CAP) return out;
  if (entries.length >= 3) {
    const openingRaw = entries[0]!;
    const openingBuf = Buffer.from(openingRaw, "utf8");
    const opening =
      openingBuf.length <= OPENING_CAP
        ? openingRaw
        : `${trimToUtf8BoundaryStart(openingBuf, OPENING_CAP).trimEnd()}…\n\n`;
    const gap = "[Earlier turns in the middle of the conversation were left out.]\n\n";
    const budget = TRANSCRIPT_CAP - Buffer.byteLength(opening, "utf8") - Buffer.byteLength(gap, "utf8");
    if (budget > 0) {
      const kept: string[] = [];
      let used = 0;
      for (let i = entries.length - 1; i >= 1; i--) {
        const entry = entries[i]!;
        const len = Buffer.byteLength(entry, "utf8");
        if (used + len <= budget) {
          kept.unshift(entry);
          used += len;
        } else if (kept.length === 0) {
          kept.unshift(trimToUtf8BoundaryEnd(Buffer.from(entry, "utf8"), budget));
          break;
        } else {
          break;
        }
      }
      return `${opening}${gap}${kept.join("")}`;
    }
  }
  return `[The start of the conversation is left out.]\n\n${trimToUtf8BoundaryEnd(bytes, TRANSCRIPT_CAP)}`;
}

/** The latest message and the user's message before it, for picking memories. */
export function cliTurn(prompt: string, msgs: Message[]): TurnContext {
  const prev = [...toUi(msgs)].reverse().find((m) => m.role === "user" && m.text.trim());
  return { text: prompt, ...(prev ? { recent: prev.text } : {}) };
}

/** What the CLI is asked: the new message, after the conversation so far when the session starts fresh on one that has messages. */
export function cliPrompt(ask: string, msgs: Message[], fresh: boolean): string {
  if (!fresh || toUi(msgs).length === 0) return ask;
  return `${HISTORY_INTRO}\n\n<conversation>\n${transcript(msgs)}</conversation>\n\nThe user's new message:\n\n${ask}`;
}

function attachmentPaths(attachments: Block[]): string[] {
  return attachments.map((a) => a.path).filter((p): p is string => typeof p === "string");
}

/** The note naming the message's saved files: space-relative, or absolute when the CLI works in an outside project folder. */
export function attachmentNote(attachments: Block[], spaceDir: string, external: boolean): string {
  const paths = attachmentPaths(attachments);
  if (!paths.length) return "";
  if (external) {
    return `\n\nThe user attached these files in the managed Phaethon space context, not the project folder:\n${paths.map((p) => `- ${path.join(spaceDir, p)}`).join("\n")}`;
  }
  return `\n\nThe user attached these files, saved in this folder:\n${paths.map((p) => `- ${p}`).join("\n")}`;
}

/**
 * The text added to the CLI's own system prompt: how to reason and explain,
 * how replies are shown, the app guide, study (course scope, study files and
 * exam dates, the study-chat block), the tutor mode (in that order), then the
 * workspace block for an outside project folder and the full-access note in
 * front.
 */
export function systemText(o: { space: string; spaceDir: string; workingDir: string; fullAccess: boolean; turn?: TurnContext }): string {
  const parts = [REASONING_PROMPT, RICH_OUTPUT_PROMPT, appGuideCliSection()];
  // Who the user is, and only the memories this message touches (the CLI has no memory tools; the daily review keeps memory current).
  for (const f of [() => profilesForPrompt(o.space), () => memoryPromptSection(o.space, o.turn, { cli: true }), () => (mailEnabledFor(o.space) ? undefined : emailBlockPrompt(o.space))]) {
    try {
      const t = f();
      if (t) parts.push(t);
    } catch {
      // memory is a nicety for a CLI turn
    }
  }
  const study = studyPromptForCli(o.space);
  if (study) parts.push(study);
  const tutor = tutorModeSection(o.space);
  if (tutor) parts.push(tutor);
  let mode = parts.join("\n\n");
  if (o.workingDir !== o.spaceDir) {
    mode = `# Workspace\n\nProject working folder: ${JSON.stringify(o.workingDir)}\nPhaethon space context: ${JSON.stringify(o.spaceDir)}\nRelative project paths resolve under the project working folder. Saved message attachments and app-generated study, notes and practice belong to the Phaethon space context; use its absolute path to read or reference them. Keep Phaethon's conversation and internal metadata in that managed context, not in the project.\n\n${mode}`;
  }
  if (o.fullAccess) mode = `${FULL_ACCESS_NOTE}\n\n${mode}`;
  return mode;
}
